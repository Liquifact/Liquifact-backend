'use strict';

/**
 * @fileoverview Comprehensive tests for the webhook dead-letter replay system.
 *
 * Covers:
 * - writeDeadLetter
 * - replayWebhook: re-signs, re-delivers, resolves row
 * - replayWebhook: already-resolved row
 * - replayWebhook: delivery failure
 * - replayWebhook: missing tenant secret
 * - resolveDeadLetter
 * - webhookReplayHandler (job)
 * - Admin routes: POST /replay/:id, POST /replay (batch), POST /resolve/:id
 *   — unauthorized trigger (no key / bad key)
 *   — not found
 *   — already resolved (409 idempotency)
 *   — delivery failure (502)
 *   — batch replay with mixed outcomes
 */

process.env.NODE_ENV = 'test';

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

// Prevent metrics from double-registering across test files
jest.mock('../src/metrics', () => ({
  webhookReplayTotal: { inc: jest.fn() },
  WEBHOOK_REPLAY_OUTCOME_ENUM: ['success', 'failure', 'not_found', 'already_resolved'],
}));

// Mock auth middleware so admin route tests don't need real JWT/sqlite
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    if (req.headers['authorization'] === 'Bearer valid-admin-token') {
      req.user = { sub: 'admin-user' };
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  },
}));

jest.mock('../src/middleware/apiKeyAuth', () => ({
  authenticateApiKey: () => (req, res, next) => {
    if (req.headers['x-api-key'] === 'valid-admin-key') {
      req.apiKey = { id: 1, name: 'test-admin' };
      return next();
    }
    const err = new Error('Invalid API key');
    err.status = 401;
    return next(err);
  },
}));

const db = require('../src/db/knex');
const logger = require('../src/logger');
const { webhookReplayTotal } = require('../src/metrics');

const {
  writeDeadLetter,
  replayWebhook,
  resolveDeadLetter,
} = require('../src/services/webhooks');
const { webhookReplayHandler } = require('../src/jobs/webhookReplay');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeadLetterRow(overrides = {}) {
  return {
    id: 'dl-uuid-1',
    tenant_id: 'tenant_abc',
    invoice_id: 'inv_001',
    event: 'escrow_funded',
    payload: JSON.stringify({ event: 'escrow_funded', invoiceId: 'inv_001' }),
    webhook_url: 'https://merchant.example.com/hook',
    attempts: 3,
    last_error: 'connect ECONNREFUSED',
    resolved: false,
    resolved_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a fluent knex-style mock object that resolves to the given values.
 * Each method returns `this` so chains like db('t').where('id', x).first() work.
 * `.first()` resolves to `resolveValue`.
 * `.returning()` resolves to `returningValue`.
 * `.update()` resolves to 1.
 * `.select()` resolves to `selectValue` (array).
 */
function makeQ({ first = undefined, returning = undefined, select = undefined } = {}) {
  const q = {
    insert: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockImplementation(function () {
      if (select !== undefined) {
        // select is either a value to resolve with, or this builder returns itself for chaining
        // If the test supplies an array, we want .select(['id']) to resolve to that array
        return Promise.resolve(select);
      }
      return this;
    }),
    update: jest.fn().mockResolvedValue(1),
    first: jest.fn().mockResolvedValue(first),
    returning: jest.fn().mockResolvedValue(returning),
  };
  return q;
}

/**
 * Wire multiple db() call responses in order.
 * `calls` is an array of makeQ() results, consumed one per db() invocation.
 */
function mockDbSequence(calls) {
  let i = 0;
  db.mockImplementation(() => {
    const q = calls[i];
    i += 1;
    return q || makeQ(); // fallback to empty mock
  });
}

// ── writeDeadLetter ───────────────────────────────────────────────────────────

describe('writeDeadLetter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a row and returns the new id', async () => {
    const q = makeQ({ returning: [{ id: 'new-dl-id' }] });
    db.mockReturnValue(q);

    const id = await writeDeadLetter({
      tenantId: 'tenant_abc',
      invoiceId: 'inv_001',
      event: 'escrow_funded',
      payload: { event: 'escrow_funded', invoiceId: 'inv_001' },
      webhookUrl: 'https://example.com/hook',
      attempts: 3,
      lastError: 'ECONNREFUSED',
    });

    expect(db).toHaveBeenCalledWith('webhook_dead_letters');
    expect(q.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant_abc',
        invoice_id: 'inv_001',
        event: 'escrow_funded',
        webhook_url: 'https://example.com/hook',
        attempts: 3,
        last_error: 'ECONNREFUSED',
      })
    );
    expect(id).toBe('new-dl-id');
  });
});

// ── resolveDeadLetter ─────────────────────────────────────────────────────────

describe('resolveDeadLetter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates resolved=true and resolved_at', async () => {
    const q = makeQ();
    db.mockReturnValue(q);

    await resolveDeadLetter('dl-uuid-1');

    expect(db).toHaveBeenCalledWith('webhook_dead_letters');
    expect(q.where).toHaveBeenCalledWith('id', 'dl-uuid-1');
    expect(q.update).toHaveBeenCalledWith(
      expect.objectContaining({ resolved: true, resolved_at: expect.any(String) })
    );
  });
});

// ── replayWebhook ─────────────────────────────────────────────────────────────

describe('replayWebhook', () => {
  let mockFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  it('re-signs with a fresh HMAC header and POSTs to the stored URL', async () => {
    const row = makeDeadLetterRow();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    mockDbSequence([
      makeQ({ first: row }),                                                    // SELECT dead-letter
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),            // SELECT tenant
      makeQ(),                                                                   // UPDATE resolve
    ]);

    await replayWebhook('dl-uuid-1');

    expect(mockFetch).toHaveBeenCalledWith(
      row.webhook_url,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Signature': expect.stringMatching(/^t=\d+,v1=[a-f0-9]{64}$/),
        }),
        body: row.payload,
      })
    );
  });

  it('resolves the dead-letter row on successful delivery', async () => {
    const row = makeDeadLetterRow();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const resolveQ = makeQ();
    mockDbSequence([
      makeQ({ first: row }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      resolveQ,
    ]);

    await replayWebhook('dl-uuid-1');

    expect(resolveQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ resolved: true })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deadLetterId: 'dl-uuid-1' }),
      'Webhook replayed successfully'
    );
  });

  it('throws NOT_FOUND when the row does not exist', async () => {
    mockDbSequence([makeQ({ first: null })]);

    await expect(replayWebhook('missing-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws ALREADY_RESOLVED when the row is already resolved', async () => {
    mockDbSequence([makeQ({ first: makeDeadLetterRow({ resolved: true }) })]);

    await expect(replayWebhook('dl-uuid-1')).rejects.toMatchObject({
      code: 'ALREADY_RESOLVED',
    });
  });

  it('throws when tenant webhook secret is not configured', async () => {
    mockDbSequence([
      makeQ({ first: makeDeadLetterRow() }),
      makeQ({ first: { settings: {} } }), // no secret
    ]);

    await expect(replayWebhook('dl-uuid-1')).rejects.toThrow(/No webhook secret/);
  });

  it('throws when the delivery endpoint returns a non-2xx status', async () => {
    const row = makeDeadLetterRow();
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    mockDbSequence([
      makeQ({ first: row }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
    ]);

    await expect(replayWebhook('dl-uuid-1')).rejects.toThrow('Webhook replay responded with 503');
  });

  it('throws on network error and does NOT resolve the row', async () => {
    const row = makeDeadLetterRow();
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const resolveQ = makeQ();
    mockDbSequence([
      makeQ({ first: row }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      resolveQ,
    ]);

    await expect(replayWebhook('dl-uuid-1')).rejects.toThrow('ECONNREFUSED');
    expect(resolveQ.update).not.toHaveBeenCalled();
  });

  it('uses a fresh HMAC signature format on every call', async () => {
    // We just verify both calls produce a well-formed fresh signature header.
    // Timestamps may collide in the same ms, so we verify format not inequality.
    const row = makeDeadLetterRow();
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    mockDbSequence([
      makeQ({ first: row }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      makeQ(),  // first resolve
      makeQ({ first: { ...row, resolved: false } }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      makeQ(),  // second resolve
    ]);

    await replayWebhook('dl-uuid-1');
    await replayWebhook('dl-uuid-1');

    const sig1 = mockFetch.mock.calls[0][1].headers['X-Signature'];
    const sig2 = mockFetch.mock.calls[1][1].headers['X-Signature'];
    expect(sig1).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(sig2).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });
});

// ── webhookReplayHandler (job) ────────────────────────────────────────────────

describe('webhookReplayHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('calls replayWebhook and increments success counter', async () => {
    const row = makeDeadLetterRow();
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    mockDbSequence([
      makeQ({ first: row }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      makeQ(),
    ]);

    await webhookReplayHandler({ payload: { deadLetterId: 'dl-uuid-1' } });

    expect(webhookReplayTotal.inc).toHaveBeenCalledWith({ outcome: 'success' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deadLetterId: 'dl-uuid-1' }),
      'webhook_replay job succeeded'
    );
  });

  it('increments not_found counter and rethrows', async () => {
    mockDbSequence([makeQ({ first: null })]);

    await expect(
      webhookReplayHandler({ payload: { deadLetterId: 'missing' } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(webhookReplayTotal.inc).toHaveBeenCalledWith({ outcome: 'not_found' });
  });

  it('increments already_resolved counter and rethrows', async () => {
    mockDbSequence([makeQ({ first: makeDeadLetterRow({ resolved: true }) })]);

    await expect(
      webhookReplayHandler({ payload: { deadLetterId: 'dl-uuid-1' } })
    ).rejects.toMatchObject({ code: 'ALREADY_RESOLVED' });

    expect(webhookReplayTotal.inc).toHaveBeenCalledWith({ outcome: 'already_resolved' });
  });

  it('increments failure counter on delivery error and rethrows', async () => {
    const row = makeDeadLetterRow();
    global.fetch.mockResolvedValue({ ok: false, status: 500 });

    mockDbSequence([
      makeQ({ first: row }),
      makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
    ]);

    await expect(
      webhookReplayHandler({ payload: { deadLetterId: 'dl-uuid-1' } })
    ).rejects.toThrow(/500/);

    expect(webhookReplayTotal.inc).toHaveBeenCalledWith({ outcome: 'failure' });
  });

  it('throws when deadLetterId is missing from payload', async () => {
    await expect(
      webhookReplayHandler({ payload: {} })
    ).rejects.toThrow('missing deadLetterId');
  });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

const request = require('supertest');
const express = require('express');
const adminWebhooksRoutes = require('../src/routes/adminWebhooks');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/webhooks', adminWebhooksRoutes);
  // Convert auth errors (from next(err) with err.status) to JSON responses
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe('Admin webhook routes', () => {
  let app;

  beforeAll(() => { app = buildTestApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────

  describe('unauthorized requests', () => {
    it('POST /replay/:id — no credentials returns 401', async () => {
      const res = await request(app).post('/api/admin/webhooks/replay/some-id');
      expect(res.status).toBe(401);
    });

    it('POST /replay/:id — bad API key returns 401', async () => {
      const res = await request(app)
        .post('/api/admin/webhooks/replay/some-id')
        .set('x-api-key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('POST /replay — no credentials returns 401', async () => {
      const res = await request(app)
        .post('/api/admin/webhooks/replay')
        .send({ ids: ['x'] });
      expect(res.status).toBe(401);
    });

    it('POST /resolve/:id — no credentials returns 401', async () => {
      const res = await request(app).post('/api/admin/webhooks/resolve/some-id');
      expect(res.status).toBe(401);
    });
  });

  // ── POST /replay/:id ────────────────────────────────────────────────────────

  describe('POST /replay/:id', () => {
    it('202 on successful replay (auth via JWT)', async () => {
      const row = makeDeadLetterRow();
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      mockDbSequence([
        makeQ({ first: row }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
        makeQ(),
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay/dl-uuid-1')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(202);
      expect(res.body.replayed).toContain('dl-uuid-1');
    });

    it('202 on successful replay (auth via API key)', async () => {
      const row = makeDeadLetterRow();
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      mockDbSequence([
        makeQ({ first: row }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
        makeQ(),
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay/dl-uuid-1')
        .set('x-api-key', 'valid-admin-key');

      expect(res.status).toBe(202);
    });

    it('404 when dead-letter row does not exist', async () => {
      mockDbSequence([makeQ({ first: null })]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay/missing-id')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(404);
    });

    it('409 when dead-letter row is already resolved', async () => {
      mockDbSequence([makeQ({ first: makeDeadLetterRow({ resolved: true }) })]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay/dl-uuid-1')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(409);
    });

    it('502 when the webhook delivery fails', async () => {
      const row = makeDeadLetterRow();
      global.fetch.mockResolvedValue({ ok: false, status: 503 });

      mockDbSequence([
        makeQ({ first: row }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay/dl-uuid-1')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/503/);
    });
  });

  // ── POST /replay (batch) ────────────────────────────────────────────────────

  describe('POST /replay (batch)', () => {
    it('400 when neither ids nor tenantId is provided', async () => {
      const res = await request(app)
        .post('/api/admin/webhooks/replay')
        .set('authorization', 'Bearer valid-admin-token')
        .send({});

      expect(res.status).toBe(400);
    });

    it('400 when ids is an empty array', async () => {
      const res = await request(app)
        .post('/api/admin/webhooks/replay')
        .set('authorization', 'Bearer valid-admin-token')
        .send({ ids: [] });

      expect(res.status).toBe(400);
    });

    it('202 with ids list — replays matching unresolved rows', async () => {
      const rowDetail1 = makeDeadLetterRow({ id: 'dl-1' });
      const rowDetail2 = makeDeadLetterRow({ id: 'dl-2' });
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      // 1. batch SELECT returning list of id-only rows
      const batchQ = {
        whereIn: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'dl-1' }, { id: 'dl-2' }]),
      };

      // 2+3+4. Per-row fetches and resolves
      mockDbSequence([
        batchQ,
        makeQ({ first: rowDetail1 }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
        makeQ(),
        makeQ({ first: rowDetail2 }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
        makeQ(),
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay')
        .set('authorization', 'Bearer valid-admin-token')
        .send({ ids: ['dl-1', 'dl-2'] });

      expect(res.status).toBe(202);
      expect(res.body.replayed).toEqual(expect.arrayContaining(['dl-1', 'dl-2']));
      expect(res.body.failed).toHaveLength(0);
    });

    it('202 with partial failures — reports each outcome', async () => {
      const rowOk = makeDeadLetterRow({ id: 'dl-ok' });
      const rowFail = makeDeadLetterRow({ id: 'dl-fail' });

      global.fetch
        .mockResolvedValueOnce({ ok: true, status: 200 })   // dl-ok
        .mockResolvedValueOnce({ ok: false, status: 502 }); // dl-fail

      const batchQ = {
        whereIn: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'dl-ok' }, { id: 'dl-fail' }]),
      };

      mockDbSequence([
        batchQ,
        makeQ({ first: rowOk }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
        makeQ(),
        makeQ({ first: rowFail }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay')
        .set('authorization', 'Bearer valid-admin-token')
        .send({ ids: ['dl-ok', 'dl-fail'] });

      expect(res.status).toBe(202);
      expect(res.body.replayed).toContain('dl-ok');
      expect(res.body.failed.map((f) => f.id)).toContain('dl-fail');
    });

    it('202 with tenantId filter', async () => {
      const rowDetail = makeDeadLetterRow({ id: 'dl-t1' });
      global.fetch.mockResolvedValue({ ok: true, status: 200 });

      const tenantQ = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'dl-t1' }]),
      };

      mockDbSequence([
        tenantQ,
        makeQ({ first: rowDetail }),
        makeQ({ first: { settings: { webhook_secret: 'sec123' } } }),
        makeQ(),
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/replay')
        .set('authorization', 'Bearer valid-admin-token')
        .send({ tenantId: 'tenant_abc', limit: 10 });

      expect(res.status).toBe(202);
      expect(res.body.replayed).toContain('dl-t1');
    });
  });

  // ── POST /resolve/:id ───────────────────────────────────────────────────────

  describe('POST /resolve/:id', () => {
    it('200 on successful resolve', async () => {
      const row = makeDeadLetterRow();

      mockDbSequence([
        makeQ({ first: row }),  // SELECT row
        makeQ(),                 // UPDATE
      ]);

      const res = await request(app)
        .post('/api/admin/webhooks/resolve/dl-uuid-1')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(200);
      expect(res.body.resolved).toBe('dl-uuid-1');
    });

    it('404 when row not found', async () => {
      mockDbSequence([makeQ({ first: null })]);

      const res = await request(app)
        .post('/api/admin/webhooks/resolve/unknown')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(404);
    });

    it('409 when row already resolved', async () => {
      mockDbSequence([makeQ({ first: makeDeadLetterRow({ resolved: true }) })]);

      const res = await request(app)
        .post('/api/admin/webhooks/resolve/dl-uuid-1')
        .set('authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(409);
    });
  });
});
