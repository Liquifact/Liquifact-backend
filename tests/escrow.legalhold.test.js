/**
 * @fileoverview Legal-hold tri-state tests (issue #424).
 *
 * Verifies that:
 *  - `fetchLegalHoldStatus` returns the canonical tri-state envelope.
 *  - `fetchLegalHold` (legacy boolean) returns `true` only on `held`.
 *  - `readEscrowState` exposes `legalHoldStatus` AND fails closed at the
 *    boolean layer (legal_hold === true on 'unknown').
 *  - `legalHoldGate()` returns:
 *      • 423 Locked on `held`
 *      • next()  on `not_held`
 *      • 503 Service Unavailable (RFC 7807) on `unknown`, increments the
 *        `legalHoldUnknownBlocks` counter, and emits a structured warn log.
 *  - A boolean-returning `legalHoldAdapter` is coerced into the tri-state.
 *  - A throwing adapter falls closed via the same 503 / metric / log path.
 *
 * The assertions use `jest` only — mocha/chai/sinon are intentionally
 * removed so this test file does not require those modules (none are in
 * `package.json` devDependencies). Where routes are wired end-to-end we
 * bootstrap a tiny expright app via `supertest` and the production gate.
 *
 * @module tests/escrow.legalhold
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-424';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const express = require('express');
const request = require('supertest');

// Subject-under-test modules.
// eslint-disable-next-line global-require
const escrowRead = require('../src/services/escrowRead');
const {
  fetchLegalHold,
  fetchLegalHoldStatus,
  readEscrowState,
  validateInvoiceId,
  LEGAL_HOLD_STATUS,
  LEGAL_HOLD_UNKNOWN_REASONS,
} = escrowRead;

// eslint-disable-next-line global-require
const { legalHoldGate } = require('../src/middleware/legalHoldGate');

// eslint-disable-next-line global-require
const metrics = require('../src/metrics');

// =============================================================================
// Helpers
// =============================================================================

/** Read the current value of a labeled counter from the registry.
 *
 * Issue #424 — the prom-client shim exposes both `counter.hashMap` AND a
 * `counter.get(labels)` accessor. The test must inspect via `get(labels)`
 * because the shim's internal `hashMap` key shape is JSON-stringified
 * labels (matches real prom-client internals), and any parser that
 * assumes `{k="v"}` syntax is brittle. Use `get` for a deterministic,
 * key-format-agnostic lookup.
 */
function readCounter(counter, labelSet = {}) {
  if (typeof counter.get === 'function') {
    return counter.get(labelSet);
  }
  // Fallback for real prom-client (no shim).
  if (counter.hashMap && typeof counter.hashMap === 'object') {
    let total = 0;
    for (const [, value] of Object.entries(counter.hashMap)) {
      if (typeof value === 'object' && value && 'value' in value) {
        total += value.value;
      } else if (typeof value === 'number') {
        total += value;
      }
    }
    return total;
  }
  return 0;
}

/** Build a minimal Express app that mounts the gate ahead of a sentinel. */
function buildGateApp(adapter) {
  const app = express();
  app.use(express.json());
  app.get(
    '/fund/:invoiceId',
    (req, _res, next) => {
      req.params = req.params || {};
      next();
    },
    legalHoldGate({
      ...(adapter && typeof adapter === 'function'
        ? {
            legalHoldStatusAdapter: adapter,
          }
        : {}),
    }),
    (_req, res) => res.status(200).json({ ok: true, status: 'funded' }),
  );
  app.post(
    '/fund',
    (req, _res, next) => next(),
    legalHoldGate({
      ...(adapter && typeof adapter === 'function'
        ? {
            legalHoldStatusAdapter: adapter,
          }
        : {}),
    }),
    (_req, res) => res.status(200).json({ ok: true, status: 'funded' }),
  );
  return app;
}

/** Inject a request id so the problem response instance is deterministic. */
function withReqId(req) {
  req.headers = req.headers || {};
  req.headers['x-request-id'] = req.headers['x-request-id'] || 'req-test-424';
  return req;
}

// =============================================================================
// Service: validateInvoiceId
// =============================================================================

describe('escrowRead.validateInvoiceId', () => {
  it('accepts valid alphanumeric IDs', () => {
    expect(validateInvoiceId('inv_123').valid).toBe(true);
    expect(validateInvoiceId('INV-ABC-001').valid).toBe(true);
    expect(validateInvoiceId('a').valid).toBe(true);
  });

  it('rejects empty string', () => {
    const r = validateInvoiceId('');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/non-empty/);
  });

  it('rejects non-string values', () => {
    expect(validateInvoiceId(null).valid).toBe(false);
    expect(validateInvoiceId(42).valid).toBe(false);
    expect(validateInvoiceId(undefined).valid).toBe(false);
  });

  it('rejects IDs with special characters', () => {
    expect(validateInvoiceId('inv 123').valid).toBe(false);
    expect(validateInvoiceId('inv/123').valid).toBe(false);
    expect(validateInvoiceId('../etc/passwd').valid).toBe(false);
  });

  it('rejects IDs longer than 128 characters', () => {
    expect(validateInvoiceId('a'.repeat(129)).valid).toBe(false);
  });
});

// =============================================================================
// Service: fetchLegalHold (legacy boolean)
// =============================================================================

describe('fetchLegalHold (legacy boolean projection)', () => {
  it('returns true when adapter resolves truthy', async () => {
    await expect(fetchLegalHold('inv_lh_01', async () => true)).resolves.toBe(true);
  });

  it('returns false when adapter resolves false', async () => {
    await expect(fetchLegalHold('inv_lh_02', async () => false)).resolves.toBe(false);
  });

  it('coerces numeric 1 to true', async () => {
    await expect(fetchLegalHold('inv_lh_03', async () => 1)).resolves.toBe(true);
  });

  it('coerces string "true" to true', async () => {
    await expect(fetchLegalHold('inv_lh_04', async () => 'true')).resolves.toBe(true);
  });

  // Issue #424 — the legacy boolean projection collapses UNKNOWN into false.
  // Document that behaviour explicitly here so future refactors do not
  // accidentally widen the security posture by returning true on unknown.
  it('collapses UNKNOWN into false at the boolean layer (fail-closed at read state, NOT at this function)', async () => {
    // fetchLegalHold reads via fetchLegalHoldStatus internally. We can
    // simulate an UNKNOWN outcome by throwing inside the adapter and
    // confirming the boolean projection returns false.
    await expect(
      fetchLegalHold('inv_lh_05', async () => {
        throw Object.assign(new Error('RPC timeout'), { code: 'ETIMEDOUT' });
      }),
    ).resolves.toBe(false);
  });
});

// =============================================================================
// Service: fetchLegalHoldStatus (tri-state)
// =============================================================================

describe('fetchLegalHoldStatus (tri-state)', () => {
  it("returns status='held' when adapter resolves truthy", async () => {
    const envelope = await fetchLegalHoldStatus('inv_st_01', async () => true);
    expect(envelope.status).toBe(LEGAL_HOLD_STATUS.HELD);
    expect(envelope.reason).toBeUndefined();
  });

  it("returns status='not_held' when adapter resolves false", async () => {
    const envelope = await fetchLegalHoldStatus('inv_st_02', async () => false);
    expect(envelope.status).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  it("returns status='unknown' with reason='rpc_error' when adapter throws (issue #424)", async () => {
    const envelope = await fetchLegalHoldStatus(
      'inv_st_03',
      async () => {
        throw Object.assign(new Error('RPC timeout'), { code: 'ETIMEDOUT' });
      },
    );
    expect(envelope.status).toBe(LEGAL_HOLD_STATUS.UNKNOWN);
    expect(envelope.reason).toBe(LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR);
    expect(envelope.errorCode).toBe('ETIMEDOUT');
  });

  it("returns status='unknown' on string error (e.g. circuit open)", async () => {
    const envelope = await fetchLegalHoldStatus(
      'inv_st_04',
      async () => {
        throw new Error('circuit_open');
      },
    );
    expect(envelope.status).toBe(LEGAL_HOLD_STATUS.UNKNOWN);
    expect(envelope.reason).toBe(LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR);
  });

  it('does not throw even when the adapter rejects', async () => {
    await expect(
      fetchLegalHoldStatus('inv_st_05', async () => {
        throw new Error('boom');
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: LEGAL_HOLD_STATUS.UNKNOWN }),
    );
  });

  it('exposes the canonical LEGAL_HOLD_STATUS enum on the module', () => {
    expect(LEGAL_HOLD_STATUS).toEqual(
      expect.objectContaining({
        HELD: 'held',
        NOT_HELD: 'not_held',
        UNKNOWN: 'unknown',
      }),
    );
  });
});

// =============================================================================
// Service: readEscrowState (projection + legalHoldStatus + fail-closed legal_hold)
// =============================================================================

describe('readEscrowState — fail-closed at the data layer (issue #424)', () => {
  it('reports legal_hold=true and legalHoldStatus=held when adapter is true', async () => {
    const state = await readEscrowState('inv_rs_01', {
      legalHoldAdapter: async () => true,
      escrowAdapter: async (id) => ({
        invoiceId: id,
        status: 'active',
        fundedAmount: 0,
      }),
    });
    expect(state.legal_hold).toBe(true);
    expect(state.legalHoldStatus).toBe(LEGAL_HOLD_STATUS.HELD);
  });

  it('reports legal_hold=false and legalHoldStatus=not_held when adapter is false', async () => {
    const state = await readEscrowState('inv_rs_02', {
      legalHoldAdapter: async () => false,
      escrowAdapter: async (id) => ({
        invoiceId: id,
        status: 'active',
        fundedAmount: 100,
      }),
    });
    expect(state.legal_hold).toBe(false);
    expect(state.legalHoldStatus).toBe(LEGAL_HOLD_STATUS.NOT_HELD);
  });

  // Issue #424 — the read-layer must fail closed. legal_hold=true on
  // 'unknown' so naive consumers that branch on `if (!state.legal_hold)`
  // cannot accidentally fund an unreadable invoice.
  it('reports legal_hold=true AND legalHoldStatus=unknown when read fails (fail-closed)', async () => {
    const state = await readEscrowState('inv_rs_03', {
      legalHoldAdapter: async () => {
        throw Object.assign(new Error('RPC down'), { code: 'ECONNREFUSED' });
      },
      escrowAdapter: async (id) => ({
        invoiceId: id,
        status: 'active',
        fundedAmount: 0,
      }),
    });
    expect(state.legal_hold).toBe(true);
    expect(state.legalHoldStatus).toBe(LEGAL_HOLD_STATUS.UNKNOWN);
    expect(state.legalHoldReason).toBe(LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR);
    expect(state.legalHoldErrorCode).toBe('ECONNREFUSED');
  });

  it('surfaces the 400 INVALID_INVOICE_ID for empty input', async () => {
    await expect(readEscrowState('')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_INVOICE_ID',
    });
  });

  it('surfaces the 400 INVALID_INVOICE_ID for path-traversal input', async () => {
    await expect(readEscrowState('../secret')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_INVOICE_ID',
    });
  });
});

// =============================================================================
// Middleware: legalHoldGate()
// =============================================================================

describe('legalHoldGate() — tri-state routing (issue #424)', () => {
  let warnSpy;
  let errorSpy;

  beforeAll(() => {
    // Spy on logger so we can assert the structured `legal_hold_status_unavailable`
    // warn without coupling to pino transport formatting.
    const logger = require('../src/logger');
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    if (warnSpy) warnSpy.mockRestore();
    if (errorSpy) errorSpy.mockRestore();
  });

  beforeEach(() => {
    warnSpy && warnSpy.mockClear();
    errorSpy && errorSpy.mockClear();

    // Issue #424 — counters live on a module-level shim that persists
    // across tests in the same Jest run. Reset to 0 in beforeEach so
    // a strict `expect(after - before).toBe(N)` assertion is deterministic
    // regardless of test-ordering or test-suite shuffle.
    if (typeof metrics.legalHoldUnknownBlocksTotal.reset === 'function') {
      metrics.legalHoldUnknownBlocksTotal.reset();
    }
    if (typeof metrics.legalHoldBlocksTotal.reset === 'function') {
      metrics.legalHoldBlocksTotal.reset();
    }
  });

  it("on 'held' returns 423 Locked (RFC 7807)", async () => {
    const app = buildGateApp(async () => ({ status: 'held' }));
    const res = await request(app).get('/fund/inv_g_01');
    expect(res.status).toBe(423);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body.title).toBe('Legal Hold Active');
    expect(res.body.status).toBe(423);
  });

  it("on 'not_held' returns 200 (handler runs)", async () => {
    const app = buildGateApp(async () => ({ status: 'not_held' }));
    const res = await request(app).get('/fund/inv_g_02');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'funded' });
  });

  // Issue #424 — this is the headline assertion. An UNKNOWN read MUST
  // surface as 503 with a clear problem response and MUST NOT reach the
  // downstream handler.
  it("on 'unknown' returns 503 Service Unavailable (RFC 7807) and blocks funding", async () => {
    const app = buildGateApp(async () => ({
      status: 'unknown',
      reason: 'rpc_error',
      errorCode: 'ETIMEDOUT',
    }));
    const res = await request(app).get('/fund/inv_g_03');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body.title).toBe('Legal Hold Status Unavailable');
    expect(res.body.status).toBe(503);
    expect(res.body.type).toBe('https://liquifact.com/probs/legal-hold-status-unavailable');
    expect(res.body.detail).toMatch(/fail-closed/i);
  });

  it("on 'unknown' increments the dedicated unknown-blocks counter", async () => {
    const before = readCounter(metrics.legalHoldUnknownBlocksTotal, { reason: 'rpc_error' });
    const app = buildGateApp(async () => ({
      status: 'unknown',
      reason: 'rpc_error',
      errorCode: 'ETIMEDOUT',
    }));
    const res = await request(app).get('/fund/inv_g_04');
    expect(res.status).toBe(503);
    const after = readCounter(metrics.legalHoldUnknownBlocksTotal, { reason: 'rpc_error' });
    // Strict equality: the gate emits exactly one increment per funding
    // request, so the counter MUST go up by exactly 1. A weaker bound
    // (>= 0) would mask a wiring regression where every unknown block
    // gets lost in the gap between the gate helper and the shim.
    expect(after - before).toBe(1);
    expect(typeof metrics.incrementLegalHoldUnknownBlocks).toBe('function');
  });

  it("on 'unknown' emits a structured `legal_hold_status_unavailable` warn log", async () => {
    const app = buildGateApp(async () => ({
      status: 'unknown',
      reason: 'rpc_error',
      errorCode: 'ETIMEDOUT',
    }));
    await request(app).get('/fund/inv_g_05');
    const matched = (warnSpy.mock.calls || []).some((args) => {
      const payload = args[0] || {};
      return payload.event === 'legal_hold_status_unavailable';
    });
    expect(matched).toBe(true);
  });

  it('returns 400 when invoiceId param is missing', async () => {
    const app = buildGateApp();
    // Build a dedicated app with no :invoiceId in the path so the gate sees
    // an undefined invoiceId.
    const noParamApp = express();
    noParamApp.use(express.json());
    noParamApp.post(
      '/fund',
      (req, _res, next) => {
        req.body = {};
        next();
      },
      legalHoldGate(),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    const res = await request(noParamApp).post('/fund').send({});
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });

  it('returns 400 when invoiceId body is empty string', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/fund',
      (_req, _res, next) => next(),
      legalHoldGate(),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    const res = await request(app).post('/fund').send({ invoiceId: '   ' });
    expect(res.status).toBe(400);
  });

  it('a throwing legalHoldStatusAdapter fails closed (503 + reason=adapter_error)', async () => {
    const app = buildGateApp(async () => {
      throw Object.assign(new Error('adapter boom'), { code: 'ADAPTER_THROW' });
    });
    const res = await request(app).get('/fund/inv_g_06');
    expect(res.status).toBe(503);
    const matched = (errorSpy.mock.calls || []).some((args) => {
      const payload = args[0] || {};
      return payload.event === 'legal_hold_status_unavailable';
    });
    expect(matched).toBe(true);
  });

  it('a legacy legalHoldAdapter returning boolean `true` is coerced to held (423)', async () => {
    const app = express();
    app.use(express.json());
    app.get(
      '/fund/:invoiceId',
      (_req, _res, next) => next(),
      legalHoldGate({ legalHoldAdapter: async () => true }),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    const res = await request(app).get('/fund/inv_g_07');
    expect(res.status).toBe(423);
  });

  it('a legacy legalHoldAdapter returning boolean `false` is coerced to not_held (200)', async () => {
    const app = express();
    app.use(express.json());
    app.get(
      '/fund/:invoiceId',
      (_req, _res, next) => next(),
      legalHoldGate({ legalHoldAdapter: async () => false }),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    const res = await request(app).get('/fund/inv_g_08');
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Module exports — keep the public surface stable
// =============================================================================

describe('module exports (backwards compatibility)', () => {
  it('escrowRead still exposes the legacy boolean fetchLegalHold', () => {
    expect(typeof escrowRead.fetchLegalHold).toBe('function');
  });

  it('escrowRead also exposes the tri-state fetchLegalHoldStatus', () => {
    expect(typeof escrowRead.fetchLegalHoldStatus).toBe('function');
  });

  it('escrowRead exposes the canonical LEGAL_HOLD_STATUS constant', () => {
    expect(escrowRead.LEGAL_HOLD_STATUS).toEqual(
      expect.objectContaining({
        HELD: 'held',
        NOT_HELD: 'not_held',
        UNKNOWN: 'unknown',
      }),
    );
  });

  it('metrics exports the new fail-closed counter and helpers', () => {
    expect(typeof metrics.incrementLegalHoldUnknownBlocks).toBe('function');
    expect(typeof metrics.incrementLegalHoldBlocks).toBe('function');
    expect(typeof metrics.incrementMetric).toBe('function');
  });

  // Drift guard #424 — if anyone changes the canonical string in
  // services/escrowRead without updating the gate's fallback, this fails
  // loudly. Cheaper than letting the predicates silently mismatch in prod.
  it('canon LEGAL_HOLD_STATUS strings match the documented tri-state', () => {
    expect(LEGAL_HOLD_STATUS.HELD).toBe('held');
    expect(LEGAL_HOLD_STATUS.NOT_HELD).toBe('not_held');
    expect(LEGAL_HOLD_STATUS.UNKNOWN).toBe('unknown');
  });
});

// =============================================================================
// Coverage of the rarely-exercised `service_unavailable` branch
// =============================================================================

describe('legalHoldGate() — fallback when service module is unconfigured', () => {
  let gateSt;

  beforeAll(() => {
    // Reset modules and mock the service to omit BOTH fetch helpers so the
    // `_resolveTriState` early-exit branch is exercised.
    jest.resetModules();
    jest.doMock('../src/services/escrowRead', () => ({
      LEGAL_HOLD_STATUS: { HELD: 'held', NOT_HELD: 'not_held', UNKNOWN: 'unknown' },
      LEGAL_HOLD_UNKNOWN_REASONS: { RPC_ERROR: 'rpc_error', ADAPTER_ERROR: 'adapter_error' },
      coerceLegalHoldStatus: (raw) => (raw === true || raw === 1 || raw === 'true'
        ? 'held' : 'not_held'),
    }));
    // eslint-disable-next-line global-require
    ({ legalHoldGate: gateSt } = require('../src/middleware/legalHoldGate'));
  });

  afterAll(() => {
    jest.dontMock('../src/services/escrowRead');
    jest.resetModules();
  });

  beforeEach(() => {
    // Issue #424 — the fallback branch increments
    // `legalHoldUnknownBlocksTotal{reason="service_unavailable"}` on every
    // call. Reset between tests so a future assertion on this label is
    // deterministic regardless of test ordering.
    if (typeof metrics.legalHoldUnknownBlocksTotal.reset === 'function') {
      metrics.legalHoldUnknownBlocksTotal.reset();
    }
  });

  it('returns 503 service_unavailable AND increments the dedicated counter', async () => {
    const before = metrics.legalHoldUnknownBlocksTotal.get({ reason: 'service_unavailable' })
      || 0;
    const app = express();
    app.get(
      '/fund/:invoiceId',
      (_req, _res, next) => next(),
      gateSt(),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    const res = await request(app).get('/fund/inv_unavail');
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/fail-closed/i);
    expect(res.body.title).toBe('Legal Hold Status Unavailable');
    const after = metrics.legalHoldUnknownBlocksTotal.get({ reason: 'service_unavailable' })
      || 0;
    expect(after - before).toBe(1);
  });
});
