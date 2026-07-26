'use strict';

/**
 * @fileoverview Tests for POST /api/admin/config/bulk endpoint.
 *
 * Covers:
 *  - Happy path: single item, multiple items, max batch size
 *  - Partial failure: mix of valid + invalid items
 *  - Over-cap rejection: exceeding BULK_CONFIG_MAX_ITEMS
 *  - Empty batch / missing operations
 *  - Validation: invalid section, missing config, unknown keys
 *  - Response shape: index, section, status, config/errors, summary
 *  - Cross-section batches
 *  - CORS side-effects in bulk
 *
 * @jest-environment node
 */

// Mock admin auth stack
jest.mock('../src/middleware/stacks', () => ({
  adminStack: [
    (req, _res, next) => {
      req.tenantId = req.headers['x-tenant-id'] || 'tenant_test_default';
      req.user = { sub: 'admin-test-user' };
      next();
    },
  ],
}));

// Mock idempotency middleware to avoid transitive import of metrics.js
// (adminConfig → idempotency → escrowSubmit → metrics)
jest.mock('../src/middleware/idempotency', () => {
  return (req, res, next) => next();
});

// Mock CORS reload functions so we can spy on them
jest.mock('../src/config/cors', () => ({
  reloadCorsOrigins: jest.fn(),
  reloadCorsMaxAge: jest.fn(),
  createCorsOptions: jest.fn(() => ({ origin: '*' })),
  isCorsOriginRejectedError: jest.fn(() => false),
}));

const request = require('supertest');
const express = require('express');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../src/config/cors');

const {
  bulkConfigSchema,
  validateBody,
  BULK_CONFIG_MAX_ITEMS,
  CONFIG_SECTIONS,
} = require('../src/schemas/config');

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    req.id = 'req_test_' + Math.random().toString(36).slice(2, 10);
    next();
  });

  // Mount the admin config router at the same path as production
  const adminConfigRouter = require('../src/routes/adminConfig');
  app.use('/api/admin/config', adminConfigRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validCorsOp(overrides = {}) {
  return {
    section: 'cors',
    config: { origins: ['https://app.example.com'], ...overrides },
  };
}

function validWebhookOp(overrides = {}) {
  return {
    section: 'webhook',
    config: {
      url: 'https://hooks.example.com/deliver',
      secret: 'supersecretkey-32chars-minimum!!',
      events: ['invoice.created'],
      ...overrides,
    },
  };
}

function validRetentionOp(overrides = {}) {
  return {
    section: 'retention',
    config: { retentionDays: 365, ...overrides },
  };
}

function validReconciliationOp(overrides = {}) {
  return {
    section: 'reconciliation',
    config: { batchSize: 100, ...overrides },
  };
}

function validKycOp(overrides = {}) {
  return {
    section: 'kyc',
    config: {
      providerUrl: 'https://kyc.example.com',
      apiKey: 'test-api-key-12345',
      ...overrides,
    },
  };
}

function validFraudOp(overrides = {}) {
  return {
    section: 'fraudThresholds',
    config: { fraudCeiling: 100000, ...overrides },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let app;

beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================
// Happy path
// ===========================================================================

describe('Bulk Config — Happy path', () => {
  it('processes a single valid item and returns 200', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: [validCorsOp()] })
      .expect(200);

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      index: 0,
      section: 'cors',
      status: 'success',
    });
    expect(res.body.results[0].config.origins).toEqual(['https://app.example.com']);
    expect(res.body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
  });

  it('processes multiple valid items across different sections', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          validCorsOp(),
          validWebhookOp(),
          validRetentionOp(),
        ],
      })
      .expect(200);

    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].section).toBe('cors');
    expect(res.body.results[1].section).toBe('webhook');
    expect(res.body.results[2].section).toBe('retention');
    res.body.results.forEach((r) => expect(r.status).toBe('success'));
    expect(res.body.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
  });

  it('processes exactly BULK_CONFIG_MAX_ITEMS items (boundary)', async () => {
    const ops = Array.from({ length: BULK_CONFIG_MAX_ITEMS }, (_, i) =>
      validCorsOp({ origins: [`https://app${i}.example.com`] }),
    );
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: ops })
      .expect(200);

    expect(res.body.results).toHaveLength(BULK_CONFIG_MAX_ITEMS);
    expect(res.body.summary.succeeded).toBe(BULK_CONFIG_MAX_ITEMS);
    expect(res.body.summary.failed).toBe(0);
  });

  it('returns validated/coerced config in each result item', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          validCorsOp({ origins: ['https://test.example.com'], maxAge: 3600 }),
        ],
      })
      .expect(200);

    const item = res.body.results[0];
    expect(item.config.origins).toEqual(['https://test.example.com']);
    expect(item.config.maxAge).toBe(3600);
  });

  it('handles all six section types in a single batch', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          validCorsOp(),
          validWebhookOp(),
          validRetentionOp(),
          validReconciliationOp(),
          validKycOp(),
          validFraudOp(),
        ],
      })
      .expect(200);

    expect(res.body.results).toHaveLength(6);
    const sections = res.body.results.map((r) => r.section);
    expect(sections).toEqual([
      'cors', 'webhook', 'retention', 'reconciliation', 'kyc', 'fraudThresholds',
    ]);
    expect(res.body.summary.succeeded).toBe(6);
  });
});

// ===========================================================================
// Partial failure
// ===========================================================================

describe('Bulk Config — Partial failure', () => {
  it('returns per-item errors without failing the batch', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          validCorsOp(),
          { section: 'webhook', config: { url: 'not-a-url' } }, // invalid
          validRetentionOp(),
        ],
      })
      .expect(200);

    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].status).toBe('success');
    expect(res.body.results[1].status).toBe('error');
    expect(res.body.results[1].errors).toBeDefined();
    expect(res.body.results[2].status).toBe('success');
    expect(res.body.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
  });

  it('returns 200 even when ALL items fail validation', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          { section: 'cors', config: {} },       // empty cors → error
          { section: 'webhook', config: {} },     // missing required fields
        ],
      })
      .expect(200);

    expect(res.body.results).toHaveLength(2);
    res.body.results.forEach((r) => expect(r.status).toBe('error'));
    expect(res.body.summary).toEqual({ total: 2, succeeded: 0, failed: 2 });
  });

  it('preserves correct index for each result', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          { section: 'cors', config: {} },    // fail
          validCorsOp(),                       // success
          { section: 'webhook', config: {} },  // fail
          validRetentionOp(),                  // success
        ],
      })
      .expect(200);

    expect(res.body.results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(res.body.results.map((r) => r.status)).toEqual([
      'error', 'success', 'error', 'success',
    ]);
  });

  it('includes field-level errors for failed items', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          { section: 'cors', config: { origins: ['not-a-url'] } },
        ],
      })
      .expect(200);

    const item = res.body.results[0];
    expect(item.status).toBe('error');
    expect(item.errors).toBeDefined();
    expect(Object.keys(item.errors).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Over-cap rejection
// ===========================================================================

describe('Bulk Config — Over-cap rejection', () => {
  it('rejects batch exceeding BULK_CONFIG_MAX_ITEMS with 400', async () => {
    const ops = Array.from({ length: BULK_CONFIG_MAX_ITEMS + 1 }, () => validCorsOp());
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: ops })
      .expect(400);

    expect(res.body.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
    expect(res.body.fieldErrors.operations).toMatch(/must not exceed/);
  });

  it('rejects 11 items when cap is 10', async () => {
    const ops = Array.from({ length: 11 }, () => validCorsOp());
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: ops });

    // When default cap is 10, 11 should fail
    if (BULK_CONFIG_MAX_ITEMS === 10) {
      expect(res.status).toBe(400);
    }
  });
});

// ===========================================================================
// Empty batch / missing operations
// ===========================================================================

describe('Bulk Config — Empty batch', () => {
  it('rejects empty operations array with 400', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: [] })
      .expect(400);

    expect(res.body.status).toBe(400);
    expect(res.body.fieldErrors.operations).toMatch(/at least one/);
  });

  it('rejects missing operations key with 400', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({})
      .expect(400);

    expect(res.body.status).toBe(400);
    expect(res.body.fieldErrors.operations).toBeDefined();
  });

  it('rejects when operations is not an array', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: 'not-an-array' })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('rejects when operations is null', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: null })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('rejects empty request body', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send()
      .expect(400);

    expect(res.body.status).toBe(400);
  });
});

// ===========================================================================
// Envelope validation
// ===========================================================================

describe('Bulk Config — Envelope validation', () => {
  it('rejects unknown top-level keys (strict mode)', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [validCorsOp()],
        extraField: 'hacker',
      })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('rejects item with invalid section name at envelope level', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [{ section: 'nonexistent', config: { foo: 1 } }],
      })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('rejects item missing config at envelope level', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [{ section: 'cors' }],
      })
      .expect(400);

    expect(res.body.status).toBe(400);
  });

  it('rejects item with unknown keys inside operation (strict)', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [{ section: 'cors', config: { origins: ['https://a.com'] }, extra: true }],
      })
      .expect(400);

    expect(res.body.status).toBe(400);
  });
});

// ===========================================================================
// Per-item section-specific validation
// ===========================================================================

describe('Bulk Config — Section-specific validation in items', () => {
  it('reports section-specific errors for invalid webhook config', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          {
            section: 'webhook',
            config: { url: 'not-a-url', secret: 'short', events: [] },
          },
        ],
      })
      .expect(200);

    const item = res.body.results[0];
    expect(item.status).toBe('error');
    expect(item.errors).toBeDefined();
  });

  it('reports error for cors with invalid origin URL', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          { section: 'cors', config: { origins: ['not-a-url'] } },
        ],
      })
      .expect(200);

    expect(res.body.results[0].status).toBe('error');
  });

  it('reports error for cors maxAge out of range', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          { section: 'cors', config: { maxAge: 999999 } },
        ],
      })
      .expect(200);

    expect(res.body.results[0].status).toBe('error');
  });

  it('reports error for fraudThresholds cross-field rule', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          {
            section: 'fraudThresholds',
            config: { fraudCeiling: 100, manualReviewThreshold: 200 },
          },
        ],
      })
      .expect(200);

    expect(res.body.results[0].status).toBe('error');
  });

  it('reports error for unknown keys in section config (strict)', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          { section: 'cors', config: { origins: ['https://a.com'], hackerField: 'evil' } },
        ],
      })
      .expect(200);

    expect(res.body.results[0].status).toBe('error');
  });
});

// ===========================================================================
// CORS side-effects
// ===========================================================================

describe('Bulk Config — CORS side-effects', () => {
  it('calls reloadCorsOrigins for valid CORS item in batch', async () => {
    await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [validCorsOp()],
      })
      .expect(200);

    expect(reloadCorsOrigins).toHaveBeenCalled();
  });

  it('calls reloadCorsMaxAge for CORS item with maxAge', async () => {
    await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [validCorsOp({ maxAge: 3600 })],
      })
      .expect(200);

    expect(reloadCorsMaxAge).toHaveBeenCalled();
  });

  it('does NOT call CORS reload for non-CORS items', async () => {
    await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [validRetentionOp()],
      })
      .expect(200);

    expect(reloadCorsOrigins).not.toHaveBeenCalled();
    expect(reloadCorsMaxAge).not.toHaveBeenCalled();
  });

  it('does NOT call CORS reload for failed CORS items', async () => {
    await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [{ section: 'cors', config: {} }],
      })
      .expect(200);

    expect(reloadCorsOrigins).not.toHaveBeenCalled();
  });

  it('calls CORS reload only for successful CORS items in mixed batch', async () => {
    await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          validRetentionOp(),
          validCorsOp(),
          { section: 'cors', config: {} }, // invalid
        ],
      })
      .expect(200);

    expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Response shape
// ===========================================================================

describe('Bulk Config — Response shape', () => {
  it('always contains results array and summary object', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: [validCorsOp()] })
      .expect(200);

    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.summary).toBeDefined();
    expect(typeof res.body.summary.total).toBe('number');
    expect(typeof res.body.summary.succeeded).toBe('number');
    expect(typeof res.body.summary.failed).toBe('number');
  });

  it('success items have index, section, status, config', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({ operations: [validCorsOp()] })
      .expect(200);

    const item = res.body.results[0];
    expect(item).toHaveProperty('index', 0);
    expect(item).toHaveProperty('section', 'cors');
    expect(item).toHaveProperty('status', 'success');
    expect(item).toHaveProperty('config');
    expect(item).not.toHaveProperty('errors');
  });

  it('error items have index, section, status, errors', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [{ section: 'cors', config: {} }],
      })
      .expect(200);

    const item = res.body.results[0];
    expect(item).toHaveProperty('index', 0);
    expect(item).toHaveProperty('section', 'cors');
    expect(item).toHaveProperty('status', 'error');
    expect(item).toHaveProperty('errors');
    expect(item).not.toHaveProperty('config');
  });

  it('summary.total equals results.length', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [validCorsOp(), validRetentionOp()],
      })
      .expect(200);

    expect(res.body.summary.total).toBe(res.body.results.length);
  });

  it('summary.succeeded + summary.failed equals summary.total', async () => {
    const res = await request(app)
      .post('/api/admin/config/bulk')
      .send({
        operations: [
          validCorsOp(),
          { section: 'cors', config: {} },
          validRetentionOp(),
        ],
      })
      .expect(200);

    const { total, succeeded, failed } = res.body.summary;
    expect(succeeded + failed).toBe(total);
  });
});

// ===========================================================================
// Schema unit tests
// ===========================================================================

describe('Bulk Config — Schema constants', () => {
  it('BULK_CONFIG_MAX_ITEMS defaults to 10', () => {
    expect(BULK_CONFIG_MAX_ITEMS).toBe(10);
  });

  it('bulkConfigSchema rejects non-object body', () => {
    const result = bulkConfigSchema.safeParse('string');
    expect(result.success).toBe(false);
  });

  it('bulkConfigSchema rejects array body (not wrapped in operations)', () => {
    const result = bulkConfigSchema.safeParse([validCorsOp()]);
    expect(result.success).toBe(false);
  });

  it('CONFIG_SECTIONS includes all six sections', () => {
    expect(CONFIG_SECTIONS).toEqual(
      expect.arrayContaining([
        'webhook', 'reconciliation', 'kyc', 'retention', 'fraudThresholds', 'cors',
      ]),
    );
  });
});
