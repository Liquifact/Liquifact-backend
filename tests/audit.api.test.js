'use strict';

const request = require('supertest');
const express = require('express');
const app = require('../src/app');
const store = require('../src/data/store');
const { auditLog, createAuditLog, GENESIS_HASH } = require('../src/audit/audit-log');
const { createAuditRouter } = require('../src/routes/audit');

const TOKEN = 'test-admin-token';
const admin = (req) => req.set('Authorization', `Bearer ${TOKEN}`);
const INVESTOR = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
const NEW_INVOICE = { sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };
const entries = () => auditLog.entries();

let savedToken;
beforeAll(() => {
  savedToken = process.env.ADMIN_API_TOKEN;
});
afterAll(() => {
  if (savedToken === undefined) {
    delete process.env.ADMIN_API_TOKEN;
  } else {
    process.env.ADMIN_API_TOKEN = savedToken;
  }
});
beforeEach(() => {
  store.reset();
  auditLog.resetForTests();
  process.env.ADMIN_API_TOKEN = TOKEN;
});

describe('recording mutations', () => {
  test('invoice.create records who/what/when with the created invoice as "after"', async () => {
    const res = await request(app).post('/api/invoices').send(NEW_INVOICE);
    expect(res.status).toBe(201);
    expect(entries()).toHaveLength(1);
    const [e] = entries();
    expect(e.seq).toBe(1);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.action).toBe('invoice.create');
    expect(e.resourceType).toBe('invoice');
    expect(e.resourceId).toBe(res.body.data.id);
    expect(e.outcome).toBe('success');
    expect(e.statusCode).toBe(201);
    expect(e.actor).toBe('anonymous');
    expect(e.before).toBeNull();
    expect(e.after.amount).toBe(500);
    expect(e.after.status).toBe('open');
    expect(typeof e.requestId).toBe('string');
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
  });

  test('invoice.fund records before/after fundedAmount and status', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1000, investor: INVESTOR });
    expect(res.status).toBe(200);
    expect(res.body.data.fundedAmount).toBe(19000);
    const [e] = entries();
    expect(e.action).toBe('invoice.fund');
    expect(e.resourceId).toBe('INV_0002');
    expect(e.outcome).toBe('success');
    expect(e.statusCode).toBe(200);
    expect(e.before).toEqual({ fundedAmount: 18000, status: 'open' });
    expect(e.after).toEqual({ fundedAmount: 19000, status: 'open' });
    expect(e.metadata.requestedAmount).toBe(1000);
  });

  test('a fund that completes the invoice records the status change and the requested amount', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor: INVESTOR });
    expect(res.body.data.status).toBe('funded');
    const [e] = entries();
    expect(e.before).toEqual({ fundedAmount: 18000, status: 'open' });
    expect(e.after).toEqual({ fundedAmount: 25000, status: 'funded' });
    expect(e.metadata.requestedAmount).toBe(7000);
  });

  test('a fund without a valid investor is recorded as rejected', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 10 });
    expect(res.status).toBe(400);
    const [e] = entries();
    expect(e.action).toBe('invoice.fund');
    expect(e.outcome).toBe('rejected');
    expect(e.metadata.error).toBe('INVESTOR_REQUIRED');
    expect(e.before).toEqual({ fundedAmount: 18000, status: 'open' });
  });

  test('settle and cancel transitions are recorded with before/after status', async () => {
    expect((await request(app).post('/api/invoices/INV_0003/settle')).status).toBe(200);
    expect((await request(app).post('/api/invoices/INV_0001/settle')).status).toBe(409);
    expect((await request(app).post('/api/invoices/INV_0001/cancel')).status).toBe(200);
    expect((await request(app).post('/api/invoices/missing/cancel')).status).toBe(404);

    const [settled, notFunded, cancelled, missing] = entries();
    expect(settled).toEqual(expect.objectContaining({ action: 'invoice.settle', resourceId: 'INV_0003', outcome: 'success', statusCode: 200 }));
    expect(settled.before).toEqual({ fundedAmount: 42000, status: 'funded' });
    expect(settled.after).toEqual({ fundedAmount: 42000, status: 'settled' });
    expect(notFunded).toEqual(expect.objectContaining({ action: 'invoice.settle', outcome: 'rejected', statusCode: 409 }));
    expect(cancelled).toEqual(expect.objectContaining({ action: 'invoice.cancel', outcome: 'success' }));
    expect(cancelled.after.status).toBe('cancelled');
    expect(missing).toEqual(expect.objectContaining({ action: 'invoice.cancel', outcome: 'rejected', statusCode: 404 }));
    expect(missing.before).toBeNull();
    expect(auditLog.verify()).toEqual({ valid: true, entries: 4 });
  });

  test('rejected fund attempts (404, 400, 409) are recorded as rejected and change nothing', async () => {
    expect((await request(app).post('/api/invoices/missing/fund').send({ amount: 5, investor: INVESTOR })).status).toBe(404);
    expect((await request(app).post('/api/invoices/INV_0001/fund').send({ amount: -5, investor: INVESTOR })).status).toBe(400);
    expect((await request(app).post('/api/invoices/INV_0003/fund').send({ amount: 1, investor: INVESTOR })).status).toBe(409);

    const [notFound, invalid, notOpen] = entries();
    expect(entries().map((e) => e.outcome)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(entries().map((e) => e.statusCode)).toEqual([404, 400, 409]);
    expect(entries().every((e) => e.action === 'invoice.fund')).toBe(true);

    expect(notFound.resourceId).toBe('missing');
    expect(notFound.before).toBeNull();
    expect(notFound.metadata.error).toBe('Invoice not found');

    expect(invalid.resourceId).toBe('INV_0001');
    expect(invalid.before).toEqual({ fundedAmount: 0, status: 'open' });
    expect(invalid.after).toBeNull();
    expect(invalid.metadata.requestedAmount).toBe(-5);

    expect(notOpen.before).toEqual({ fundedAmount: 42000, status: 'funded' });
    expect(notOpen.metadata.error).toContain('funded');

    expect((await request(app).get('/api/invoices/INV_0001')).body.data.fundedAmount).toBe(0);
  });

  test('a rejected create is recorded with the validation errors', async () => {
    const res = await request(app).post('/api/invoices').send({ sme: '' });
    expect(res.status).toBe(400);
    const [e] = entries();
    expect(e.action).toBe('invoice.create');
    expect(e.outcome).toBe('rejected');
    expect(e.statusCode).toBe(400);
    expect(e.resourceId).toBeNull();
    expect(e.metadata.errors).toEqual(res.body.details);
  });

  test('response shapes are unchanged', async () => {
    const created = await request(app).post('/api/invoices').send(NEW_INVOICE);
    expect(Object.keys(created.body)).toEqual(['data']);
    const bad = await request(app).post('/api/invoices').send({});
    expect(Object.keys(bad.body).sort()).toEqual(['details', 'error']);
    const funded = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor: INVESTOR });
    expect(Object.keys(funded.body)).toEqual(['data']);
  });

  test('reads are not audited', async () => {
    await request(app).get('/api/invoices');
    await request(app).get('/api/invoices/INV_0001');
    await request(app).get('/api/stats');
    expect(entries()).toHaveLength(0);
  });

  test('a safe client request id is kept; an unsafe one is replaced', async () => {
    await request(app).post('/api/invoices/INV_0002/fund').set('X-Request-Id', 'req-123').send({ amount: 1, investor: INVESTOR });
    await request(app).post('/api/invoices/INV_0002/fund').set('X-Request-Id', 'bad id!<script>').send({ amount: 1, investor: INVESTOR });
    expect(entries()[0].requestId).toBe('req-123');
    expect(entries()[1].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the client IP is stored truncated', async () => {
    await request(app).post('/api/invoices/INV_0002/fund').set('X-Forwarded-For', '203.0.113.77').send({ amount: 1, investor: INVESTOR });
    expect(entries()[0].ip).toBe('203.0.113.0/24');
    expect(JSON.stringify(entries())).not.toContain('203.0.113.77');
  });

  test('the chain verifies after a mix of mutations', async () => {
    await request(app).post('/api/invoices').send(NEW_INVOICE);
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 10, investor: INVESTOR });
    await request(app).post('/api/invoices/missing/fund').send({ amount: 10, investor: INVESTOR });
    const res = await admin(request(app).get('/api/audit/verify'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, entries: 3 });
  });
});

describe('redaction', () => {
  const SECRETS = ['super-secret-bearer', 'key-12345', 'hunter2', 'SABCDEF', 'p4ss-w0rd', 'tok-789'];

  test('Authorization, API keys and secret/seed/password/token fields never reach any stored entry', async () => {
    const headers = { Authorization: 'Bearer super-secret-bearer', 'X-API-Key': 'key-12345' };
    const extras = { secret: 'hunter2', seed: 'SABCDEF', password: 'p4ss-w0rd', token: 'tok-789' };

    await request(app).post('/api/invoices').set(headers).send({ ...NEW_INVOICE, ...extras });
    await request(app).post('/api/invoices').set(headers).send({ sme: '', ...extras });
    await request(app).post('/api/invoices/INV_0002/fund').set(headers).send({ amount: 1, investor: INVESTOR, ...extras });
    await request(app).post('/api/invoices/INV_0003/fund').set(headers).send({ amount: 1, investor: INVESTOR, ...extras });
    await request(app).post('/api/invoices/missing/fund').set(headers).send({ amount: 1, investor: INVESTOR, ...extras });
    expect(entries()).toHaveLength(5);

    const stored = JSON.stringify(entries());
    SECRETS.forEach((s) => expect(stored).not.toContain(s));

    const listed = await admin(request(app).get('/api/audit'));
    SECRETS.forEach((s) => expect(JSON.stringify(listed.body)).not.toContain(s));
  });
});

describe('GET /api/audit', () => {
  beforeEach(async () => {
    await request(app).post('/api/invoices').send(NEW_INVOICE); // seq 1 -> INV_0005
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor: INVESTOR }); // seq 2
    await request(app).post('/api/invoices/INV_0001/fund').send({ amount: 1, investor: INVESTOR }); // seq 3
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor: INVESTOR }); // seq 4
  });

  test('lists entries oldest first', async () => {
    const res = await admin(request(app).get('/api/audit'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(4);
    expect(res.body.data.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(res.body.nextAfter).toBeNull();
  });

  test('filters by resourceId and by action', async () => {
    const byId = await admin(request(app).get('/api/audit?resourceId=INV_0002'));
    expect(byId.body.data.map((e) => e.seq)).toEqual([2, 4]);
    const byAction = await admin(request(app).get('/api/audit?action=invoice.create'));
    expect(byAction.body.data.map((e) => e.seq)).toEqual([1]);
  });

  test('pages with limit and after', async () => {
    const first = await admin(request(app).get('/api/audit?limit=3'));
    expect(first.body.data.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(first.body.nextAfter).toBe(3);
    const second = await admin(request(app).get(`/api/audit?limit=3&after=${first.body.nextAfter}`));
    expect(second.body.data.map((e) => e.seq)).toEqual([4]);
    expect(second.body.nextAfter).toBeNull();
  });

  test.each(['limit=0', 'limit=201', 'limit=abc', 'after=-1', 'after=x', 'resourceId=a&resourceId=b'])(
    'rejects invalid query "%s" with 400',
    async (query) => {
      const res = await admin(request(app).get(`/api/audit?${query}`));
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
    },
  );
});

describe('admin-only access', () => {
  test.each(['/api/audit', '/api/audit/verify'])('%s requires the admin token', async (path) => {
    const none = await request(app).get(path);
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');

    const wrong = await request(app).get(path).set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);

    const sameLength = await request(app).get(path).set('Authorization', `Bearer ${'x'.repeat(TOKEN.length)}`);
    expect(sameLength.status).toBe(401);

    const wrongScheme = await request(app).get(path).set('Authorization', `Basic ${TOKEN}`);
    expect(wrongScheme.status).toBe(401);

    const bare = await request(app).get(path).set('Authorization', TOKEN);
    expect(bare.status).toBe(401);
    expect(JSON.stringify(bare.body)).not.toContain(TOKEN);

    const ok = await admin(request(app).get(path));
    expect(ok.status).toBe(200);
  });

  test.each(['/api/audit', '/api/audit/verify'])('%s answers 503 when ADMIN_API_TOKEN is not set', async (path) => {
    delete process.env.ADMIN_API_TOKEN;
    expect((await request(app).get(path)).status).toBe(503);
    expect((await request(app).get(path).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(503);
    process.env.ADMIN_API_TOKEN = '';
    expect((await request(app).get(path).set('Authorization', 'Bearer ')).status).toBe(503);
  });
});

describe('history cannot be rewritten through the API', () => {
  /** Mounts the audit router on a log whose storage the test can tamper with directly. */
  function tamperableApi() {
    const items = [];
    const log = createAuditLog({
      store: {
        last: () => (items.length ? items[items.length - 1] : null),
        append: (entry) => items.push(entry),
        entries: () => items,
        size: () => items.length,
      },
    });
    ['a', 'b', 'c'].forEach((id) =>
      log.append({ action: 'invoice.fund', resourceType: 'invoice', resourceId: id, outcome: 'success', statusCode: 200, after: { id } }),
    );
    const mini = express();
    mini.use('/api/audit', createAuditRouter(log));
    return { items, mini };
  }

  test('verify is valid before tampering', async () => {
    const { mini } = tamperableApi();
    const res = await admin(request(mini).get('/api/audit/verify'));
    expect(res.body).toEqual({ valid: true, entries: 3 });
  });

  test('an edited "after" field is reported with the right brokenAt', async () => {
    const { items, mini } = tamperableApi();
    items[1].after = { id: 'edited' };
    const res = await admin(request(mini).get('/api/audit/verify'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, brokenAt: 2 });
  });

  test('a deleted entry is reported with the right brokenAt', async () => {
    const { items, mini } = tamperableApi();
    items.splice(1, 1);
    const res = await admin(request(mini).get('/api/audit/verify'));
    expect(res.body).toEqual({ valid: false, brokenAt: 3 });
  });

  test('reordered entries are reported with the right brokenAt', async () => {
    const { items, mini } = tamperableApi();
    [items[1], items[2]] = [items[2], items[1]];
    const res = await admin(request(mini).get('/api/audit/verify'));
    expect(res.body).toEqual({ valid: false, brokenAt: 3 });
  });

  test('there is no route to edit or delete entries', async () => {
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor: INVESTOR });
    const before = JSON.stringify(entries());
    for (const method of ['post', 'put', 'patch', 'delete']) {
      for (const path of ['/api/audit', '/api/audit/1']) {
        const res = await admin(request(app)[method](path)).send({ after: { fundedAmount: 1 } });
        expect(res.status).toBe(404);
      }
    }
    expect(JSON.stringify(entries())).toBe(before);
    expect(auditLog.verify()).toEqual({ valid: true, entries: 1 });
  });
});

describe('OpenAPI', () => {
  test('documents the audit routes, their security, parameters, errors and schemas', async () => {
    const { body: spec } = await request(app).get('/openapi.json');

    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/audit', '/api/audit/verify']));

    const list = spec.paths['/api/audit'].get;
    expect(list.security).toEqual([{ adminBearer: [] }]);
    expect(list.parameters.map((p) => p.name)).toEqual(['resourceId', 'action', 'limit', 'after']);
    expect(Object.keys(list.responses).sort()).toEqual(['200', '400', '401', '503']);
    expect(list.responses[200].content['application/json'].schema.$ref).toBe('#/components/schemas/AuditList');

    const verify = spec.paths['/api/audit/verify'].get;
    expect(verify.security).toEqual([{ adminBearer: [] }]);
    expect(Object.keys(verify.responses).sort()).toEqual(['200', '401', '503']);
    expect(verify.responses[200].content['application/json'].schema.$ref).toBe('#/components/schemas/AuditVerification');

    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['AuditEntry', 'AuditList', 'AuditVerification']),
    );
    expect(spec.components.schemas.AuditEntry.required).toEqual(expect.arrayContaining(['seq', 'prevHash', 'hash']));
    expect(Object.keys(spec.components.schemas.AuditVerification.properties)).toEqual(['valid', 'entries', 'brokenAt']);
    expect(spec.components.securitySchemes.adminBearer).toEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));
    expect(spec.tags.map((t) => t.name)).toContain('Audit');
  });

  test('the mutating invoice routes note that they are audited, and the index lists the audit endpoints', async () => {
    const { body: spec } = await request(app).get('/openapi.json');
    expect(spec.paths['/api/invoices'].post.description).toContain('audit log');
    expect(spec.paths['/api/invoices/{id}/fund'].post.description).toContain('audit log');

    const index = await request(app).get('/');
    expect(index.body.endpoints.map((e) => e.path)).toEqual(
      expect.arrayContaining(['/api/audit', '/api/audit/verify']),
    );
  });
});
