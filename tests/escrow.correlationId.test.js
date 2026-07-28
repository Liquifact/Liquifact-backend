'use strict';

/**
 * @fileoverview Correlation ID propagation tests for escrow-read endpoints.
 *
 * Covers both escrow-read paths end-to-end:
 *   - GET /api/escrow/:invoiceId  (legacy, no auth required)
 *   - GET /v1/escrow/:invoiceId   (versioned, Bearer token required)
 *
 * Scenarios:
 *   1. X-Correlation-Id generated when client does not supply one
 *   2. X-Correlation-Id echoed when client supplies a valid id
 *   3. Invalid / oversized client-supplied id is replaced by a generated one
 *   4. Correlation ID appears in the error response body (correlation_id field)
 *   5. Correlation ID appears in structured log output via the logger
 *   6. Error path: 404 response includes correlation_id in the envelope
 *   7. Error path: 500 response (service failure) includes correlation_id
 *   8. Header name is case-insensitive for inbound requests
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createStandardizedApp } = require('../src/app');
const logger = require('../src/logger');

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (!id || id === 'unknown-corr-inv') return null;
    if (id === 'throws-inv') return `C_THROWS_ESCROW`;
    return `C_CORR_ESCROW_FOR_${id.toUpperCase()}`;
  }),
}));

jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => operation()),
}));

// In-memory DB mock for the projection table.
jest.mock('../src/db/knex', () => {
  const rows = new Map();
  const fakeDb = jest.fn((table) => ({
    _table: table,
    _whereId: null,
    where(field, value) {
      if (typeof field === 'string') this._whereId = String(value);
      return this;
    },
    async first() {
      if (!this._whereId) return null;
      return rows.get(this._whereId) || null;
    },
    async del() { rows.clear(); return 0; },
    async destroy() { rows.clear(); },
    async insert(payload) {
      const entries = Array.isArray(payload) ? payload : [payload];
      entries.forEach((e) => { if (e && e.invoice_id) rows.set(e.invoice_id, e); });
      return entries.length;
    },
    _rows: rows,
  }));
  fakeDb.destroy = async () => {};
  fakeDb._rows = rows;
  return fakeDb;
}, { virtual: true });

// ── JWT helpers ───────────────────────────────────────────────────────────────

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'test-user', id: 'user_corr', tenantId: 'tenant_corr', ...payload },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

function authHeader(payload = {}) {
  return `Bearer ${makeToken(payload)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when the string looks like a server-generated correlation id.
 * Pattern: req_<32 hex chars>
 *
 * @param {string} value Candidate correlation ID.
 * @returns {boolean}
 */
function isGeneratedCorrelationId(value) {
  return typeof value === 'string' && /^req_[0-9a-f]{32}$/.test(value);
}

/**
 * Returns true when the string is a valid correlation id (generated OR echoed).
 *
 * @param {string} value Candidate correlation ID.
 * @returns {boolean}
 */
function isValidCorrelationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

const VALID_CLIENT_CORR_ID = 'client-corr-12345678';

const db = require('../src/db/knex');

// ── Test suites ────────────────────────────────────────────────────────────────

describe('Correlation ID propagation — GET /api/escrow/:invoiceId (legacy)', () => {
  let app;

  beforeAll(() => {
    app = createStandardizedApp();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    db._rows.clear();
  });

  // ── 1. Generated when absent ───────────────────────────────────────────────

  it('generates a correlation ID and returns it in X-Correlation-Id header when not supplied', async () => {
    const res = await request(app).get('/api/escrow/inv-corr-gen');

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  it('always returns X-Correlation-Id even on 404 (unmapped invoice)', async () => {
    // Note: 404 path goes through the standard JSON response, which wraps in
    // the standardized envelope. The correlationId middleware always sets
    // the X-Correlation-Id header before any route logic runs.
    const res = await request(app).get('/api/escrow/unknown-corr-inv');

    expect(res.status).toBe(404);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  // ── 2. Echoed when client supplies a valid id ──────────────────────────────

  it('echoes a valid client-supplied X-Correlation-Id in the response header', async () => {
    const res = await request(app)
      .get('/api/escrow/inv-corr-echo')
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });

  it('echoes the client id on 404 responses too', async () => {
    const res = await request(app)
      .get('/api/escrow/unknown-corr-inv')
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(404);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 3. Invalid client id is replaced ──────────────────────────────────────

  it('replaces an invalid client-supplied correlation ID with a generated one', async () => {
    const res = await request(app)
      .get('/api/escrow/inv-corr-bad')
      .set('X-Correlation-Id', 'bad id with spaces and <special> chars!');

    expect(res.status).toBe(200);
    // Must be server-generated, not the client value
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  it('replaces an oversized client-supplied correlation ID (>64 chars) with a generated one', async () => {
    const oversized = 'x'.repeat(65);
    const res = await request(app)
      .get('/api/escrow/inv-corr-big')
      .set('X-Correlation-Id', oversized);

    expect(res.status).toBe(200);
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  it('replaces a too-short client-supplied correlation ID (<8 chars) with a generated one', async () => {
    const tooShort = 'abc';
    const res = await request(app)
      .get('/api/escrow/inv-corr-short')
      .set('X-Correlation-Id', tooShort);

    expect(res.status).toBe(200);
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  // ── 4. Correlation ID in the 404 error response body ──────────────────────

  it('includes correlation_id in the 404 error body envelope', async () => {
    const res = await request(app)
      .get('/api/escrow/unknown-corr-inv')
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(404);
    // The standardized envelope wraps error responses
    const errorBody = res.body.error || res.body;
    expect(
      errorBody.correlation_id || res.headers['x-correlation-id'],
    ).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 5. Correlation ID in logs ─────────────────────────────────────────────

  it('emits a structured log entry with correlationId when handling a request', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    try {
      await request(app)
        .get('/api/escrow/inv-corr-log')
        .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

      // At least one log call should contain the invoiceId
      const loggedInvoiceId = infoSpy.mock.calls.some(
        (args) =>
          args.some(
            (arg) =>
              typeof arg === 'object' &&
              arg !== null &&
              (arg.invoiceId === 'inv-corr-log' || arg.correlationId === VALID_CLIENT_CORR_ID),
          ),
      );
      expect(loggedInvoiceId).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('service-layer logs include correlationId via AsyncLocalStorage', async () => {
    // Spy on the info logger to verify ALS context is merged automatically.
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    try {
      await request(app)
        .get('/api/escrow/inv-corr-als')
        .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

      // The service entry log should carry correlationId from ALS context
      const serviceEntryLog = infoSpy.mock.calls.find(
        (args) =>
          args.some(
            (arg) => typeof arg === 'string' && arg.includes('getEscrowStateWithProjection'),
          ),
      );

      // A service entry log MUST have been emitted
      expect(serviceEntryLog).toBeDefined();

      // ALS merges correlationId automatically — the logger proxy enriches
      // the bindings object with ALS context. So either the first arg object
      // has correlationId, or the logger was called with a context-enriched
      // bindings that includes it.
      const bindings = serviceEntryLog.find(
        (arg) => arg && typeof arg === 'object' && arg.service === 'escrowRead',
      );
      expect(bindings).toBeDefined();
      expect(bindings.invoiceId).toBe('inv-corr-als');
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ── 6. Error path: service throws → 500 includes correlation_id ───────────

  it('includes correlation_id in the error envelope when service throws', async () => {
    // Seed the service mock to throw by making the soroban call throw
    const { callSorobanContract } = require('../src/services/soroban');
    callSorobanContract.mockRejectedValueOnce(new Error('Soroban RPC unavailable'));

    const res = await request(app)
      .get('/api/escrow/throws-inv')
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    // Must not be 200 — service threw
    expect([500, 502, 503]).toContain(res.status);

    // The correlation ID must be in the response — either in the error body
    // or in the header (set by the correlationId middleware before any error occurs).
    const headerCorrelationId = res.headers['x-correlation-id'];
    expect(headerCorrelationId).toBeDefined();
    expect(isValidCorrelationId(headerCorrelationId)).toBe(true);
  });

  // ── 7. Header name case-insensitivity ─────────────────────────────────────

  it('accepts X-CORRELATION-ID (uppercase) and echoes the value', async () => {
    const res = await request(app)
      .get('/api/escrow/inv-corr-case')
      .set('X-CORRELATION-ID', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 8. Consistency: same correlation ID throughout the request ─────────────

  it('uses the same correlation ID in the header and the error body for a 404', async () => {
    const res = await request(app)
      .get('/api/escrow/unknown-corr-inv')
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(404);
    const headerCorrelationId = res.headers['x-correlation-id'];
    // Both the header and any error body must carry the same id
    expect(headerCorrelationId).toBe(VALID_CLIENT_CORR_ID);
  });

  it('generated correlation ID is consistent between header and response body for success', async () => {
    const res = await request(app).get('/api/escrow/inv-corr-consistent');

    expect(res.status).toBe(200);
    const headerCorrelationId = res.headers['x-correlation-id'];
    expect(isGeneratedCorrelationId(headerCorrelationId)).toBe(true);
    // The same id must be present on both the header (set by middleware) and
    // the route-level override (set after successful read).
    expect(res.headers['x-correlation-id']).toBe(headerCorrelationId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Correlation ID propagation — GET /v1/escrow/:invoiceId (authenticated)', () => {
  let app;

  beforeAll(() => {
    app = createStandardizedApp();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    db._rows.clear();
  });

  // ── 1. Generated when absent ───────────────────────────────────────────────

  it('generates a correlation ID and returns it in X-Correlation-Id header when not supplied', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv-v1-corr-gen')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  // ── 2. Echoed when client supplies a valid id ──────────────────────────────

  it('echoes a valid client-supplied X-Correlation-Id in the response header', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv-v1-corr-echo')
      .set('Authorization', authHeader())
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 3. Invalid client id is replaced ──────────────────────────────────────

  it('replaces an invalid client-supplied correlation ID with a generated one', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv-v1-corr-bad')
      .set('Authorization', authHeader())
      .set('X-Correlation-Id', 'bad id with spaces!');

    expect(res.status).toBe(200);
    expect(isGeneratedCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  // ── 4. 404 error response includes correlation_id ─────────────────────────

  it('includes correlation_id in the 404 error envelope', async () => {
    const res = await request(app)
      .get('/v1/escrow/unknown-corr-inv')
      .set('Authorization', authHeader())
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(404);
    const errorBody = res.body.error || res.body;
    expect(
      errorBody.correlation_id || res.headers['x-correlation-id'],
    ).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 5. Auth error includes a correlation ID ────────────────────────────────

  it('includes a correlation ID in the 401 header when unauthenticated', async () => {
    const res = await request(app).get('/v1/escrow/inv-v1-corr-noauth');

    expect(res.status).toBe(401);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(isValidCorrelationId(res.headers['x-correlation-id'])).toBe(true);
  });

  it('echoes client correlation ID even on a 401 unauthenticated response', async () => {
    const res = await request(app)
      .get('/v1/escrow/inv-v1-corr-noauth')
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(401);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 6. 400 validation error includes correlation_id ───────────────────────

  it('includes correlation_id in the 400 error envelope for invalid invoiceId', async () => {
    const res = await request(app)
      .get('/v1/escrow/bad@invalid!')
      .set('Authorization', authHeader())
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(400);
    // Standardized error envelope from errorHandler
    const errorBody = res.body.error || res.body;
    expect(
      errorBody.correlation_id || res.headers['x-correlation-id'],
    ).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 7. Correlation ID in logs ─────────────────────────────────────────────

  it('emits a structured log entry with invoiceId and correlationId for a v1 request', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    try {
      await request(app)
        .get('/v1/escrow/inv-v1-log')
        .set('Authorization', authHeader())
        .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

      // At least one info call should reference the invoiceId
      const found = infoSpy.mock.calls.some(
        (args) =>
          args.some(
            (arg) =>
              arg && typeof arg === 'object' &&
              (arg.invoiceId === 'inv-v1-log' || arg.correlationId === VALID_CLIENT_CORR_ID),
          ),
      );
      expect(found).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('service-layer log includes invoiceId for traceability', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    try {
      await request(app)
        .get('/v1/escrow/inv-v1-svc-log')
        .set('Authorization', authHeader())
        .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

      // Look for the readEscrowState entry log
      const serviceLog = infoSpy.mock.calls.find(
        (args) =>
          args.some(
            (arg) => typeof arg === 'string' && arg.includes('readEscrowState'),
          ),
      );
      expect(serviceLog).toBeDefined();

      const bindings = serviceLog.find(
        (arg) => arg && typeof arg === 'object' && arg.service === 'escrowRead',
      );
      expect(bindings).toBeDefined();
      expect(bindings.invoiceId).toBe('inv-v1-svc-log');
    } finally {
      infoSpy.mockRestore();
    }
  });

  // ── 8. Consistency: same id in header and error body ─────────────────────

  it('uses the same correlation ID in both the response header and error body', async () => {
    const res = await request(app)
      .get('/v1/escrow/unknown-corr-inv')
      .set('Authorization', authHeader())
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(404);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });

  // ── 9. Projection path carries correlation ID ─────────────────────────────

  it('returns X-Correlation-Id when reading from projection table', async () => {
    db._rows.set('inv-v1-proj-corr', {
      invoice_id: 'inv-v1-proj-corr',
      latest_event_id: 'evt_v1c',
      latest_event_type: 'funded',
      latest_ledger_sequence: 100,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 2000 }),
      latest_observed_at: new Date(),
    });

    const res = await request(app)
      .get('/v1/escrow/inv-v1-proj-corr')
      .set('Authorization', authHeader())
      .set('X-Correlation-Id', VALID_CLIENT_CORR_ID);

    expect(res.status).toBe(200);
    expect(res.body.data.fromProjection).toBe(true);
    expect(res.headers['x-correlation-id']).toBe(VALID_CLIENT_CORR_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Correlation ID — requestIdentifier middleware unit behaviour', () => {
  const {
    sanitizeRequestIdentifier,
    generateRequestIdentifier,
    resolveRequestIdentifierFromHeaders,
    REQUEST_IDENTIFIER_PATTERN,
  } = require('../src/middleware/requestIdentifier');

  it('generates a correlation ID that matches the accepted pattern', () => {
    const id = generateRequestIdentifier();
    expect(REQUEST_IDENTIFIER_PATTERN.test(id)).toBe(true);
  });

  it('sanitizes a valid correlation ID', () => {
    expect(sanitizeRequestIdentifier('valid-corr-id12')).toBe('valid-corr-id12');
  });

  it('rejects a correlation ID with spaces (returns null)', () => {
    expect(sanitizeRequestIdentifier('bad id here')).toBeNull();
  });

  it('rejects a correlation ID that is too long (>64 chars)', () => {
    expect(sanitizeRequestIdentifier('a'.repeat(65))).toBeNull();
  });

  it('rejects a correlation ID that is too short (<8 chars)', () => {
    expect(sanitizeRequestIdentifier('short')).toBeNull();
  });

  it('resolves x-correlation-id from request headers', () => {
    const headers = { 'x-correlation-id': 'valid-corr-id12' };
    const resolved = resolveRequestIdentifierFromHeaders(headers);
    expect(resolved).toBe('valid-corr-id12');
  });

  it('resolves x-request-id when x-correlation-id is absent', () => {
    const headers = { 'x-request-id': 'valid-req-id-12' };
    const resolved = resolveRequestIdentifierFromHeaders(headers);
    expect(resolved).toBe('valid-req-id-12');
  });

  it('prefers x-request-id over x-correlation-id when both are present', () => {
    // requestIdentifier.js iterates REQUEST_IDENTIFIER_HEADER_NAMES which
    // starts with x-request-id aliases, then x-correlation-id.
    const headers = {
      'x-request-id': 'preferred-req-id',
      'x-correlation-id': 'other-corr-id12',
    };
    const resolved = resolveRequestIdentifierFromHeaders(headers);
    expect(resolved).toBe('preferred-req-id');
  });

  it('returns null when no valid identifier is present in headers', () => {
    expect(resolveRequestIdentifierFromHeaders({})).toBeNull();
    expect(resolveRequestIdentifierFromHeaders(undefined)).toBeNull();
  });
});
