'use strict';

/**
 * Scheduled reconciliation trigger tests.
 *
 * Escrow reads are mocked at module level so transition detection and dedupe
 * can be exercised without Soroban RPC.
 */

const http = require('http');
const request = require('supertest');

jest.mock('../src/routes/escrow', () => {
  const actual = jest.requireActual('../src/routes/escrow');
  actual.readEscrowOnChain = jest.fn();
  return actual;
});

const app = require('../src/app');
const escrowRoute = require('../src/routes/escrow');
const store = require('../src/data/store');
const reconciliation = require('../src/routes/reconciliation');
const emitter = require('../src/webhooks/emitter');
const webhookStore = require('../src/webhooks/store');

const { DEPLOY_SNAPSHOT } = escrowRoute;
const CRON_SECRET = 'reconciliation-cron-secret';
const ADMIN_TOKEN = 'reconciliation-admin-token';
const DRIFT_EVENT = 'invoice.reconciliation_drift';

function cronHeaders(token = CRON_SECRET) {
  return { Authorization: `Bearer ${token}` };
}

function adminHeaders() {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function driftEvents(emitSpy) {
  return emitSpy.mock.calls.filter(([type]) => type === DRIFT_EVENT);
}

function trigger() {
  return request(app)
    .post('/api/internal/reconciliation/run')
    .set(cronHeaders())
    .send({});
}

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ body });
      res.writeHead(200).end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

function stopReceiver(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(received, n, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (received.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('POST /api/internal/reconciliation/run — cron guard', () => {
  let originalSecret;

  beforeEach(() => {
    originalSecret = process.env.CRON_SECRET;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  test('returns 404 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;

    const res = await request(app)
      .post('/api/internal/reconciliation/run')
      .set('Authorization', 'Bearer anything')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  test('returns 401 when the bearer token is wrong or missing', async () => {
    process.env.CRON_SECRET = CRON_SECRET;

    const bad = await request(app)
      .post('/api/internal/reconciliation/run')
      .set(cronHeaders('wrong-secret'))
      .send({});
    expect(bad.status).toBe(401);
    expect(bad.body.status).toBe(401);

    const missing = await request(app)
      .post('/api/internal/reconciliation/run')
      .send({});
    expect(missing.status).toBe(401);
  });
});

describe('scheduled reconciliation — transitions and dedupe', () => {
  let originalCronSecret;
  let originalAdminToken;
  let emitSpy;

  beforeAll(() => {
    originalCronSecret = process.env.CRON_SECRET;
    originalAdminToken = process.env.ADMIN_API_TOKEN;
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  });

  afterAll(() => {
    if (originalCronSecret === undefined) { delete process.env.CRON_SECRET; }
    else { process.env.CRON_SECRET = originalCronSecret; }
    if (originalAdminToken === undefined) { delete process.env.ADMIN_API_TOKEN; }
    else { process.env.ADMIN_API_TOKEN = originalAdminToken; }
  });

  beforeEach(() => {
    store.reset();
    webhookStore.reset();
    reconciliation.resetLatestReport();
    escrowRoute.readEscrowOnChain.mockReset();
    escrowRoute.readEscrowOnChain.mockResolvedValue({ ...DEPLOY_SNAPSHOT });
    emitSpy = jest.spyOn(emitter, 'emit');
  });

  afterEach(() => {
    emitSpy.mockRestore();
    jest.clearAllMocks();
  });

  test('emits exactly one drift event on in_sync → drift and suppresses repeats', async () => {
    const baseline = await trigger();
    expect(baseline.status).toBe(200);
    expect(baseline.body.summary.inSync).toBe(1);
    expect(driftEvents(emitSpy)).toHaveLength(0);

    const invoice = store.get('INV_0001');
    invoice.fundedAmountMinor = 100000000n; // 10 XLM funded off-chain, still 0 on-chain

    const driftRun = await trigger();
    expect(driftRun.status).toBe(200);
    expect(driftRun.body.summary.drift).toBe(1);
    expect(driftRun.body.alerts).toBe(1);
    expect(driftRun.body.alertedInvoiceIds).toEqual(['INV_0001']);

    const events = driftEvents(emitSpy);
    expect(events).toHaveLength(1);
    const payload = events[0][1];
    expect(payload.invoiceId).toBe('INV_0001');
    expect(payload.previousStatus).toBe('in_sync');
    expect(payload.status).toBe('drift');
    expect(payload.mismatches.map((m) => m.field)).toContain('fundedAmount');
    expect(payload.reconciliation.mismatches).toEqual(payload.mismatches);

    emitSpy.mockClear();
    const repeated = await trigger();
    expect(repeated.status).toBe(200);
    expect(repeated.body.alerts).toBe(0);
    expect(driftEvents(emitSpy)).toHaveLength(0);
  });

  test('emits one event on in_sync → error and dedupes repeated errors', async () => {
    expect((await trigger()).status).toBe(200);

    escrowRoute.readEscrowOnChain.mockRejectedValueOnce(new Error('simulated RPC timeout'));
    const failed = await trigger();
    expect(failed.body.summary.error).toBe(1);
    expect(failed.body.alerts).toBe(1);

    const events = driftEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][1].status).toBe('error');
    expect(events[0][1].code).toBe('RPC_ERROR');
    expect(events[0][1].detail).toMatch(/simulated RPC timeout/);
    expect(events[0][1].mismatches).toEqual([]);

    emitSpy.mockClear();
    escrowRoute.readEscrowOnChain.mockRejectedValueOnce(new Error('simulated RPC timeout'));
    const repeated = await trigger();
    expect(repeated.body.alerts).toBe(0);
    expect(driftEvents(emitSpy)).toHaveLength(0);
  });

  test('GET /api/reconciliation/latest is admin-only and returns report age', async () => {
    const unauth = await request(app).get('/api/reconciliation/latest');
    expect(unauth.status).toBe(401);

    const noReport = await request(app)
      .get('/api/reconciliation/latest')
      .set(adminHeaders());
    expect(noReport.status).toBe(404);

    expect((await trigger()).status).toBe(200);
    const cached = reconciliation.getLatestReport();
    reconciliation.setLatestReport({
      ...cached,
      checkedAt: new Date(Date.now() - 65000).toISOString(),
    });

    const res = await request(app)
      .get('/api/reconciliation/latest')
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.report.summary.inSync).toBe(1);
    expect(res.body.ageMs).toBeGreaterThanOrEqual(60000);
    expect(res.body.ageSeconds).toBeGreaterThanOrEqual(60);
  });

  test('POST /api/webhooks accepts invoice.reconciliation_drift', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set(adminHeaders())
      .send({
        url: 'http://127.0.0.1:4555/hook',
        events: [DRIFT_EVENT],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.events).toContain(DRIFT_EVENT);
  });

  test('delivers the mismatch list to a drift webhook subscriber', async () => {
    const receiver = await startReceiver();
    try {
      const registration = await request(app)
        .post('/api/webhooks')
        .set(adminHeaders())
        .send({
          url: `http://127.0.0.1:${receiver.port}/hook`,
          events: [DRIFT_EVENT],
        });
      expect(registration.status).toBe(201);

      expect((await trigger()).status).toBe(200);
      store.get('INV_0001').fundedAmountMinor = 100000000n;
      expect((await trigger()).status).toBe(200);

      await waitFor(receiver.received, 1);
      expect(receiver.received).toHaveLength(1);

      const envelope = JSON.parse(receiver.received[0].body);
      expect(envelope.type).toBe(DRIFT_EVENT);
      expect(envelope.data.invoice.invoiceId).toBe('INV_0001');
      expect(envelope.data.invoice.mismatches.map((m) => m.field)).toContain('fundedAmount');
    } finally {
      await stopReceiver(receiver.server);
    }
  });
});
