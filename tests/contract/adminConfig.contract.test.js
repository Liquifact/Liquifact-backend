'use strict';

/**
 * @fileoverview Schema/contract tests for the admin config response shapes
 * (issue #818).
 *
 * These tests validate real HTTP responses from `src/routes/adminConfig.js`
 * against the JSON Schemas documented in the route's `@swagger` annotations
 * (compiled into the OpenAPI spec by `src/openapi/openapiSpec.js`). Every
 * documented response schema is `additionalProperties: false` with an
 * explicit `required` list, so `assertResponse` fails the test whenever a
 * response gains an undocumented field, loses a required one, or changes a
 * field's type — locking the contract in place per the issue.
 *
 * Coverage:
 *  - POST /api/admin/config — 200 (every section), 400 (validation error),
 *    401 (missing/invalid auth), 409 (idempotency key reused with a
 *    different body).
 *  - GET  /api/admin/config/sections — 200, 401.
 *  - A meta-test proving the schemas actually catch drift: mutating a
 *    known-good body (extra field / missing required field) must fail
 *    validation, otherwise the "shape lock" would be a no-op.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ── Module mocks ─────────────────────────────────────────────────────────────

// Idempotency DB access is only exercised when a request sets the
// Idempotency-Key header (see SECTION 4 below). Everywhere else the route
// never touches knex, so a bare stub is enough.
const mockDb = jest.fn();
const mockTrx = jest.fn();
mockDb.transaction = jest.fn(async (cb) => cb(mockTrx));
mockDb.fn = { now: jest.fn(() => '2023-01-01T00:00:00Z') };

jest.mock('../../src/db/knex', () => mockDb);

jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { getValidator, assertResponse } = require('./helpers');
const { CONFIG_SECTIONS } = require('../../src/schemas/config');
const adminConfigRouter = require('../../src/routes/adminConfig');

// ── Helpers ──────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

function makeAdminToken(sub = 'admin-user', tenantId = 'tenant_test') {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Builds an Express app mounting the real adminConfig router with the real
 * adminStack (JWT/API-key auth + tenant extraction), matching how the router
 * is wired in production. The rate limiter stays on its globally-mocked
 * no-op implementation (see tests/mocks/setup.js) so these shape assertions
 * never trip on request volume.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/config', adminConfigRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      type: err.type,
      title: err.title,
      status: err.status || 500,
      detail: err.detail || err.message,
    });
  });
  return app;
}

const APP = buildApp();
const AUTH = `Bearer ${makeAdminToken()}`;

/** One valid payload per documented config section. */
const VALID_PAYLOADS = {
  webhook: {
    section: 'webhook',
    config: {
      url: 'https://hooks.example.com/delivery',
      secret: 'a-valid-secret-that-is-long-enough',
      events: ['invoice.created', 'invoice.paid'],
    },
  },
  reconciliation: {
    section: 'reconciliation',
    config: { batchSize: 50, enabled: true },
  },
  kyc: {
    section: 'kyc',
    config: {
      providerUrl: 'https://kyc.provider.example.com',
      apiKey: 'validapikey-min8',
    },
  },
  retention: {
    section: 'retention',
    config: { retentionDays: 90, purgeEnabled: false },
  },
  fraudThresholds: {
    section: 'fraudThresholds',
    config: { fraudCeiling: 5000000 },
  },
  cors: {
    section: 'cors',
    config: { origins: ['https://app.example.com'], maxAge: 3600 },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.transaction = jest.fn(async (cb) => cb(mockTrx));
  mockDb.fn = { now: jest.fn(() => '2023-01-01T00:00:00Z') };
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — POST /api/admin/config — 200 success shape (every section)
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config — 200 response contract', () => {
  it.each(Object.keys(VALID_PAYLOADS))('matches the documented schema for section "%s"', async (name) => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS[name]);

    assertResponse('post', '/api/admin/config', 200, res);
  });

  it('rejects a response with an undocumented extra field', () => {
    const { ajv, spec } = getValidator();
    const schema = spec.paths['/api/admin/config'].post.responses['200'].content['application/json'].schema;
    const validate = ajv.compile(schema);

    const mutated = {
      section: 'webhook',
      config: {},
      message: 'ok',
      unexpectedField: 'should not be here',
    };
    expect(validate(mutated)).toBe(false);
  });

  it('rejects a response missing a required field', () => {
    const { ajv, spec } = getValidator();
    const schema = spec.paths['/api/admin/config'].post.responses['200'].content['application/json'].schema;
    const validate = ajv.compile(schema);

    const mutated = { section: 'webhook', config: {} }; // missing `message`
    expect(validate(mutated)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — POST /api/admin/config — 400 validation-error shape
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config — 400 response contract', () => {
  it('matches the documented schema for an unknown section', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: 'not-a-real-section', config: {} });

    assertResponse('post', '/api/admin/config', 400, res);
  });

  it('matches the documented schema for a field-level validation failure', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({
        section: 'webhook',
        config: { url: 'not-a-url', secret: 'short', events: [] },
      });

    assertResponse('post', '/api/admin/config', 400, res);
  });

  it('matches the documented schema for a missing body', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({});

    assertResponse('post', '/api/admin/config', 400, res);
  });

  it('rejects a 400 body carrying an undocumented "code" field alongside fieldErrors', () => {
    const { ajv, spec } = getValidator();
    const schema = spec.paths['/api/admin/config'].post.responses['400'].content['application/problem+json'].schema;
    const validate = ajv.compile(schema);

    const mutated = {
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'bad body',
      fieldErrors: { section: 'required' },
      code: 'UNDOCUMENTED_EXTRA',
    };
    expect(validate(mutated)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Authentication error shapes (401), reused Problem schema
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config — 401 response contract', () => {
  it('matches the documented Problem schema with no Authorization header', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .send(VALID_PAYLOADS.webhook);

    assertResponse('post', '/api/admin/config', 401, res);
  });

  it('matches the documented Problem schema for a malformed token', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', 'Bearer not.a.jwt')
      .send(VALID_PAYLOADS.webhook);

    assertResponse('post', '/api/admin/config', 401, res);
  });
});

describe('GET /api/admin/config/sections — response contract', () => {
  it('matches the documented 200 schema', async () => {
    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH);

    assertResponse('get', '/api/admin/config/sections', 200, res);
    expect(res.body.sections).toEqual(CONFIG_SECTIONS);
  });

  it('matches the documented 401 schema with no auth', async () => {
    const res = await request(APP).get('/api/admin/config/sections');
    assertResponse('get', '/api/admin/config/sections', 401, res);
  });

  it('rejects a sections response containing a non-enum section value', () => {
    const { ajv, spec } = getValidator();
    const schema = spec.paths['/api/admin/config/sections'].get.responses['200'].content['application/json'].schema;
    const validate = ajv.compile(schema);

    expect(validate({ sections: ['webhook', 'not-a-real-section'] })).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — 409 idempotency-conflict shape
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config — 409 response contract', () => {
  let mockWhere, mockFirst, mockInsert;

  beforeEach(() => {
    mockFirst = jest.fn();
    mockInsert = jest.fn().mockResolvedValue([1]);
    mockWhere = jest.fn().mockReturnValue({ first: mockFirst });
    mockTrx.mockReturnValue({ where: mockWhere, insert: mockInsert });
    mockDb.mockReturnValue({ where: mockWhere });
  });

  it('matches the documented schema when the Idempotency-Key is reused with a different body', async () => {
    mockFirst.mockResolvedValueOnce({
      idempotency_key: 'valid-key-12345678',
      request_fingerprint: 'a-completely-different-fingerprint',
      response_status: 200,
      response_body: '{}',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'valid-key-12345678')
      .send(VALID_PAYLOADS.webhook);

    assertResponse('post', '/api/admin/config', 409, res);
  });

  it('rejects a 409 body still using the retired "requestId" field name instead of "instance"', () => {
    const { ajv, spec } = getValidator();
    const schema = spec.paths['/api/admin/config'].post.responses['409'].content['application/problem+json'].schema;
    const validate = ajv.compile(schema);

    const legacyShape = {
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Idempotency-Key reused with a different request body.',
      requestId: 'req-123',
    };
    // Missing the required `instance` field (and carries an undocumented one).
    expect(validate(legacyShape)).toBe(false);
  });
});
