'use strict';

/**
 * @fileoverview Comprehensive tests for config input validation.
 *
 * Covers:
 *  - src/schemas/config.js — all section schemas and the top-level
 *    runtimeConfigSchema (valid payloads, missing fields, wrong types,
 *    oversized strings, boundary numbers, unknown-key rejection)
 *  - POST /api/admin/config — route integration via supertest
 *    (auth, 200 on valid, 400 + fieldErrors on invalid)
 *  - GET /api/admin/config/sections — lists valid section names
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/db/knex', () => jest.fn());
jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../../src/metrics', () => ({
  webhookReplayTotal: { inc: jest.fn() },
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
}));
jest.mock('prom-client', () => ({
  Counter:  class { constructor() {} inc() {} },
  Gauge:    class { constructor() {} set() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

// ── Imports ───────────────────────────────────────────────────────────────────

const express  = require('express');
const request  = require('supertest');
const jwt      = require('jsonwebtoken');

const {
  webhookConfigSchema,
  reconciliationConfigSchema,
  kycConfigSchema,
  retentionConfigSchema,
  fraudThresholdsSchema,
  runtimeConfigSchema,
  parseValidationErrors,
  CONFIG_SECTIONS,
} = require('../../src/schemas/config');

const adminConfigRouter = require('../../src/routes/adminConfig');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

/** Mint a valid admin JWT for test requests. */
function makeAdminToken(sub = 'admin-user', tenantId = 'tenant_test') {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Build a minimal Express app that mounts the adminConfig router.
 * Injects a stub tenant so tests don't need a real DB.
 */
function buildApp() {
  const app = express();
  app.use(express.json());

  // Stub tenant extraction — the real middleware reads from the DB
  app.use((req, _res, next) => {
    if (!req.tenantId) { req.tenantId = 'tenant_test'; }
    next();
  });

  app.use('/api/admin/config', adminConfigRouter);

  // Generic error handler
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return app;
}

const APP = buildApp();
const TOKEN = makeAdminToken();
const AUTH  = `Bearer ${TOKEN}`;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Schema unit tests (no HTTP layer)
// ═════════════════════════════════════════════════════════════════════════════

// ── webhookConfigSchema ───────────────────────────────────────────────────────

describe('webhookConfigSchema', () => {
  const VALID = {
    url: 'https://example.com/hook',
    secret: 'supersecret-16chars',
    events: ['invoice.created', 'invoice.paid'],
  };

  it('accepts a minimal valid payload', () => {
    const r = webhookConfigSchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });

  it('accepts all optional fields', () => {
    const r = webhookConfigSchema.safeParse({
      ...VALID,
      maxRetries: 3,
      timeoutMs: 5000,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing url', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, url: undefined });
    expect(r.success).toBe(false);
  });

  it('rejects invalid url', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, url: 'not-a-url' });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.url).toBeDefined();
  });

  it('rejects url exceeding 2048 chars', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, url: 'https://x.com/' + 'a'.repeat(2050) });
    expect(r.success).toBe(false);
  });

  it('rejects secret shorter than 16 chars', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, secret: 'tooshort' });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.secret).toMatch(/16/);
  });

  it('rejects secret exceeding 256 chars', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, secret: 'a'.repeat(257) });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.secret).toMatch(/256/);
  });

  it('rejects empty events array', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, events: [] });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.events).toBeDefined();
  });

  it('rejects events array with more than 50 items', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, events: Array(51).fill('evt') });
    expect(r.success).toBe(false);
  });

  it('rejects an event name exceeding 100 chars', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, events: ['a'.repeat(101)] });
    expect(r.success).toBe(false);
  });

  it('rejects maxRetries below 0', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, maxRetries: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects maxRetries above 10', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, maxRetries: 11 });
    expect(r.success).toBe(false);
  });

  it('accepts maxRetries at boundary values 0 and 10', () => {
    expect(webhookConfigSchema.safeParse({ ...VALID, maxRetries: 0 }).success).toBe(true);
    expect(webhookConfigSchema.safeParse({ ...VALID, maxRetries: 10 }).success).toBe(true);
  });

  it('rejects timeoutMs below 500', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, timeoutMs: 499 });
    expect(r.success).toBe(false);
  });

  it('rejects timeoutMs above 30000', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, timeoutMs: 30001 });
    expect(r.success).toBe(false);
  });

  it('accepts timeoutMs at boundary values 500 and 30000', () => {
    expect(webhookConfigSchema.safeParse({ ...VALID, timeoutMs: 500 }).success).toBe(true);
    expect(webhookConfigSchema.safeParse({ ...VALID, timeoutMs: 30000 }).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, unknownField: 'boom' });
    expect(r.success).toBe(false);
    // Zod v4 strict() emits unrecognized_keys at path [] → mapped to '_root'
    const errs = parseValidationErrors(r.error);
    expect(errs._root).toMatch(/unknownField/);
  });

  it('rejects non-boolean enabled', () => {
    const r = webhookConfigSchema.safeParse({ ...VALID, enabled: 'yes' });
    expect(r.success).toBe(false);
  });
});

// ── reconciliationConfigSchema ────────────────────────────────────────────────

describe('reconciliationConfigSchema', () => {
  it('accepts a single field update', () => {
    const r = reconciliationConfigSchema.safeParse({ batchSize: 50 });
    expect(r.success).toBe(true);
  });

  it('accepts all valid fields together', () => {
    const r = reconciliationConfigSchema.safeParse({
      batchSize: 100,
      maxDriftSeconds: 300,
      scheduleExpression: '0 2 * * *',
      enabled: false,
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty object', () => {
    const r = reconciliationConfigSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects batchSize below 1', () => {
    const r = reconciliationConfigSchema.safeParse({ batchSize: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects batchSize above 500', () => {
    const r = reconciliationConfigSchema.safeParse({ batchSize: 501 });
    expect(r.success).toBe(false);
  });

  it('accepts batchSize at boundary values 1 and 500', () => {
    expect(reconciliationConfigSchema.safeParse({ batchSize: 1 }).success).toBe(true);
    expect(reconciliationConfigSchema.safeParse({ batchSize: 500 }).success).toBe(true);
  });

  it('rejects maxDriftSeconds below 0', () => {
    const r = reconciliationConfigSchema.safeParse({ maxDriftSeconds: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects maxDriftSeconds above 3600', () => {
    const r = reconciliationConfigSchema.safeParse({ maxDriftSeconds: 3601 });
    expect(r.success).toBe(false);
  });

  it('rejects scheduleExpression exceeding 100 chars', () => {
    const r = reconciliationConfigSchema.safeParse({ scheduleExpression: 'x'.repeat(101) });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const r = reconciliationConfigSchema.safeParse({ batchSize: 10, extra: true });
    expect(r.success).toBe(false);
  });
});

// ── kycConfigSchema ───────────────────────────────────────────────────────────

describe('kycConfigSchema', () => {
  const VALID = {
    providerUrl: 'https://kyc.provider.com/api',
    apiKey: 'kyc-apikey-minimum8',
  };

  it('accepts a minimal valid payload', () => {
    expect(kycConfigSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts optional fields', () => {
    const r = kycConfigSchema.safeParse({ ...VALID, timeoutMs: 10000, retries: 3 });
    expect(r.success).toBe(true);
  });

  it('rejects missing providerUrl', () => {
    const r = kycConfigSchema.safeParse({ apiKey: VALID.apiKey });
    expect(r.success).toBe(false);
  });

  it('rejects non-URL providerUrl', () => {
    const r = kycConfigSchema.safeParse({ ...VALID, providerUrl: 'not-a-url' });
    expect(r.success).toBe(false);
    expect(parseValidationErrors(r.error).providerUrl).toBeDefined();
  });

  it('rejects apiKey shorter than 8 chars', () => {
    const r = kycConfigSchema.safeParse({ ...VALID, apiKey: 'short' });
    expect(r.success).toBe(false);
    expect(parseValidationErrors(r.error).apiKey).toMatch(/8/);
  });

  it('rejects apiKey exceeding 256 chars', () => {
    const r = kycConfigSchema.safeParse({ ...VALID, apiKey: 'k'.repeat(257) });
    expect(r.success).toBe(false);
  });

  it('rejects retries above 5', () => {
    const r = kycConfigSchema.safeParse({ ...VALID, retries: 6 });
    expect(r.success).toBe(false);
  });

  it('accepts retries at boundary values 0 and 5', () => {
    expect(kycConfigSchema.safeParse({ ...VALID, retries: 0 }).success).toBe(true);
    expect(kycConfigSchema.safeParse({ ...VALID, retries: 5 }).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const r = kycConfigSchema.safeParse({ ...VALID, hackField: 'x' });
    expect(r.success).toBe(false);
  });
});

// ── retentionConfigSchema ─────────────────────────────────────────────────────

describe('retentionConfigSchema', () => {
  it('accepts a single field update', () => {
    expect(retentionConfigSchema.safeParse({ retentionDays: 365 }).success).toBe(true);
  });

  it('accepts all valid fields together', () => {
    const r = retentionConfigSchema.safeParse({
      retentionDays: 90,
      purgeEnabled: true,
      batchSize: 200,
      purgeCron: '0 3 * * 0',
      legalHoldReasons: ['litigation', 'regulatory'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty object', () => {
    expect(retentionConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects retentionDays below 1', () => {
    expect(retentionConfigSchema.safeParse({ retentionDays: 0 }).success).toBe(false);
  });

  it('rejects retentionDays above 3650', () => {
    expect(retentionConfigSchema.safeParse({ retentionDays: 3651 }).success).toBe(false);
  });

  it('accepts retentionDays at boundary values 1 and 3650', () => {
    expect(retentionConfigSchema.safeParse({ retentionDays: 1 }).success).toBe(true);
    expect(retentionConfigSchema.safeParse({ retentionDays: 3650 }).success).toBe(true);
  });

  it('rejects batchSize above 1000', () => {
    expect(retentionConfigSchema.safeParse({ batchSize: 1001 }).success).toBe(false);
  });

  it('rejects purgeCron exceeding 100 chars', () => {
    expect(retentionConfigSchema.safeParse({ purgeCron: 'x'.repeat(101) }).success).toBe(false);
  });

  it('rejects legalHoldReasons with more than 20 items', () => {
    const r = retentionConfigSchema.safeParse({ legalHoldReasons: Array(21).fill('r') });
    expect(r.success).toBe(false);
  });

  it('rejects a legalHoldReason exceeding 100 chars', () => {
    const r = retentionConfigSchema.safeParse({ legalHoldReasons: ['a'.repeat(101)] });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const r = retentionConfigSchema.safeParse({ retentionDays: 30, unknown: true });
    expect(r.success).toBe(false);
  });
});

// ── fraudThresholdsSchema ─────────────────────────────────────────────────────

describe('fraudThresholdsSchema', () => {
  it('accepts updating only fraudCeiling', () => {
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: 5000000 }).success).toBe(true);
  });

  it('accepts updating only manualReviewThreshold', () => {
    expect(fraudThresholdsSchema.safeParse({ manualReviewThreshold: 500000 }).success).toBe(true);
  });

  it('accepts both fields when manualReview <= fraudCeiling', () => {
    const r = fraudThresholdsSchema.safeParse({
      fraudCeiling: 10000000,
      manualReviewThreshold: 1000000,
    });
    expect(r.success).toBe(true);
  });

  it('accepts equal fraudCeiling and manualReviewThreshold', () => {
    const r = fraudThresholdsSchema.safeParse({
      fraudCeiling: 1000000,
      manualReviewThreshold: 1000000,
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty object', () => {
    expect(fraudThresholdsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects fraudCeiling below 1', () => {
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: 0 }).success).toBe(false);
  });

  it('rejects fraudCeiling above 1_000_000_000', () => {
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: 1_000_000_001 }).success).toBe(false);
  });

  it('accepts fraudCeiling at boundary values 1 and 1_000_000_000', () => {
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: 1 }).success).toBe(true);
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: 1_000_000_000 }).success).toBe(true);
  });

  it('rejects non-finite fraudCeiling (Infinity)', () => {
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: Infinity }).success).toBe(false);
  });

  it('rejects non-finite fraudCeiling (NaN)', () => {
    expect(fraudThresholdsSchema.safeParse({ fraudCeiling: NaN }).success).toBe(false);
  });

  it('rejects manualReviewThreshold > fraudCeiling', () => {
    const r = fraudThresholdsSchema.safeParse({
      fraudCeiling: 1000,
      manualReviewThreshold: 2000,
    });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs['manualReviewThreshold']).toMatch(/fraudCeiling/i);
  });

  it('rejects unknown keys', () => {
    const r = fraudThresholdsSchema.safeParse({ fraudCeiling: 5000, extra: 'field' });
    expect(r.success).toBe(false);
  });

  it('rejects string values', () => {
    const r = fraudThresholdsSchema.safeParse({ fraudCeiling: 'ten-thousand' });
    expect(r.success).toBe(false);
    expect(parseValidationErrors(r.error).fraudCeiling).toBeDefined();
  });
});

// ── runtimeConfigSchema ───────────────────────────────────────────────────────

describe('runtimeConfigSchema', () => {
  it('accepts a valid webhook section payload', () => {
    const r = runtimeConfigSchema.safeParse({
      section: 'webhook',
      config: {
        url: 'https://example.com/hook',
        secret: 'supersecret-16chars',
        events: ['invoice.created'],
      },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid fraudThresholds section payload', () => {
    const r = runtimeConfigSchema.safeParse({
      section: 'fraudThresholds',
      config: { fraudCeiling: 5000000 },
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing section field', () => {
    const r = runtimeConfigSchema.safeParse({
      config: { fraudCeiling: 5000000 },
    });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.section).toBeDefined();
  });

  it('rejects unknown section value', () => {
    const r = runtimeConfigSchema.safeParse({
      section: 'unknownSection',
      config: { foo: 'bar' },
    });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.section).toBeDefined();
  });

  it('rejects missing config field', () => {
    const r = runtimeConfigSchema.safeParse({ section: 'webhook' });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs.config).toBeDefined();
  });

  it('rejects unknown top-level keys', () => {
    const r = runtimeConfigSchema.safeParse({
      section: 'retention',
      config: { retentionDays: 90 },
      extraKey: 'bad',
    });
    expect(r.success).toBe(false);
  });

  it('propagates section-level field errors with "config." prefix', () => {
    const r = runtimeConfigSchema.safeParse({
      section: 'webhook',
      config: {
        url: 'https://example.com/hook',
        secret: 'tooshort',   // < 16 chars — should fail
        events: ['invoice.created'],
      },
    });
    expect(r.success).toBe(false);
    const errs = parseValidationErrors(r.error);
    expect(errs['config.secret']).toBeDefined();
  });

  it('propagates unknown-key error from inner section schema', () => {
    const r = runtimeConfigSchema.safeParse({
      section: 'kyc',
      config: {
        providerUrl: 'https://kyc.example.com',
        apiKey: 'validapikey-8chars',
        unknownField: 'oops',
      },
    });
    expect(r.success).toBe(false);
    // Zod v4 strict() emits unrecognized_keys at path ['config'] → 'config'
    const errs = parseValidationErrors(r.error);
    expect(errs['config']).toMatch(/unknownField/);
  });

  it('lists all expected sections in CONFIG_SECTIONS', () => {
    const expected = ['webhook', 'reconciliation', 'kyc', 'retention', 'fraudThresholds'];
    expect(CONFIG_SECTIONS).toEqual(expect.arrayContaining(expected));
    expect(CONFIG_SECTIONS).toHaveLength(expected.length);
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — HTTP integration tests (POST /api/admin/config)
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config', () => {
  // ── Auth ───────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no Authorization header is supplied', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .send({ section: 'webhook', config: {} });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the JWT is malformed', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', 'Bearer not.a.jwt')
        .send({ section: 'webhook', config: {} });
      expect(res.status).toBe(401);
    });

    it('accepts a valid Bearer token', async () => {
      // Body is invalid but we want to verify auth passes (expect 400, not 401)
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'webhook', config: { url: 'bad', secret: 'short', events: [] } });
      expect(res.status).toBe(400);
    });
  });

  // ── Valid payloads ──────────────────────────────────────────────────────────

  describe('valid payloads — 200 responses', () => {
    it('accepts a valid webhook config and echoes it back', async () => {
      const payload = {
        section: 'webhook',
        config: {
          url: 'https://hooks.example.com/delivery',
          secret: 'a-valid-secret-that-is-long-enough',
          events: ['invoice.created', 'invoice.paid'],
          maxRetries: 5,
          timeoutMs: 10000,
          enabled: true,
        },
      };

      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.section).toBe('webhook');
      expect(res.body.config.url).toBe(payload.config.url);
      expect(res.body.message).toMatch(/webhook/i);
    });

    it('accepts a valid reconciliation config', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'reconciliation',
          config: { batchSize: 100, enabled: true },
        });

      expect(res.status).toBe(200);
      expect(res.body.section).toBe('reconciliation');
    });

    it('accepts a valid kyc config', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'kyc',
          config: {
            providerUrl: 'https://kyc.provider.example.com',
            apiKey: 'validapikey-min8',
            retries: 2,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.section).toBe('kyc');
    });

    it('accepts a valid retention config', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'retention',
          config: { retentionDays: 365, purgeEnabled: false },
        });

      expect(res.status).toBe(200);
      expect(res.body.section).toBe('retention');
    });

    it('accepts a valid fraudThresholds config', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'fraudThresholds',
          config: { fraudCeiling: 10000000, manualReviewThreshold: 1000000 },
        });

      expect(res.status).toBe(200);
      expect(res.body.section).toBe('fraudThresholds');
    });
  });

  // ── Missing fields ──────────────────────────────────────────────────────────

  describe('missing required fields — 400 responses', () => {
    it('returns 400 with fieldError for missing section', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ config: { fraudCeiling: 5000000 } });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(400);
      expect(res.body.fieldErrors.section).toBeDefined();
    });

    it('returns 400 with fieldError for missing config', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'webhook' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.config).toBeDefined();
    });

    it('returns 400 with machine-readable code VALIDATION_ERROR', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({});

      expect(res.status).toBe(400);
      // validateBody returns RFC 7807 shape
      expect(res.body.type).toContain('validation-error');
      expect(res.body.title).toMatch(/validation/i);
    });
  });

  // ── Wrong types ─────────────────────────────────────────────────────────────

  describe('wrong types — 400 responses', () => {
    it('returns 400 when section is a number', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 42, config: {} });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.section).toBeDefined();
    });

    it('returns 400 when config is an array instead of object', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'retention', config: [1, 2, 3] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when a numeric field receives a string', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'fraudThresholds',
          config: { fraudCeiling: 'ten-million' },
        });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors['config.fraudCeiling']).toBeDefined();
    });

    it('returns 400 when boolean field receives a string', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'webhook',
          config: {
            url: 'https://hooks.example.com',
            secret: 'a-valid-secret-at-least-16chars',
            events: ['invoice.created'],
            enabled: 'yes',       // should be boolean
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors['config.enabled']).toBeDefined();
    });
  });

  // ── Oversized strings ───────────────────────────────────────────────────────

  describe('oversized strings — 400 responses', () => {
    it('returns 400 when webhook secret exceeds 256 chars', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'webhook',
          config: {
            url: 'https://hooks.example.com',
            secret: 's'.repeat(257),
            events: ['invoice.created'],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors['config.secret']).toMatch(/256/);
    });

    it('returns 400 when an event name exceeds 100 chars', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'webhook',
          config: {
            url: 'https://hooks.example.com',
            secret: 'valid-secret-minimum-16',
            events: ['e'.repeat(101)],
          },
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when KYC apiKey exceeds 256 chars', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'kyc',
          config: {
            providerUrl: 'https://kyc.example.com',
            apiKey: 'k'.repeat(257),
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors['config.apiKey']).toMatch(/256/);
    });

    it('returns 400 when scheduleExpression exceeds 100 chars', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'reconciliation',
          config: { scheduleExpression: 'x'.repeat(101) },
        });

      expect(res.status).toBe(400);
    });
  });

  // ── Boundary numbers ────────────────────────────────────────────────────────

  describe('boundary numbers', () => {
    it('accepts retentionDays at exact lower bound (1)', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'retention', config: { retentionDays: 1 } });
      expect(res.status).toBe(200);
    });

    it('accepts retentionDays at exact upper bound (3650)', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'retention', config: { retentionDays: 3650 } });
      expect(res.status).toBe(200);
    });

    it('rejects retentionDays one above upper bound (3651)', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'retention', config: { retentionDays: 3651 } });
      expect(res.status).toBe(400);
    });

    it('accepts fraudCeiling at exact lower bound (1)', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'fraudThresholds', config: { fraudCeiling: 1 } });
      expect(res.status).toBe(200);
    });

    it('accepts fraudCeiling at exact upper bound (1_000_000_000)', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'fraudThresholds', config: { fraudCeiling: 1_000_000_000 } });
      expect(res.status).toBe(200);
    });

    it('rejects fraudCeiling one above upper bound', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'fraudThresholds', config: { fraudCeiling: 1_000_000_001 } });
      expect(res.status).toBe(400);
    });

    it('rejects manualReviewThreshold > fraudCeiling', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'fraudThresholds',
          config: { fraudCeiling: 1000, manualReviewThreshold: 2000 },
        });
      expect(res.status).toBe(400);
      expect(res.body.fieldErrors['config.manualReviewThreshold']).toMatch(/fraudCeiling/i);
    });
  });

  // ── Unknown fields ──────────────────────────────────────────────────────────

  describe('unknown fields — 400 responses', () => {
    it('returns 400 for unknown top-level key', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'retention',
          config: { retentionDays: 30 },
          injectedTopLevel: 'evil',   // unknown key — strict() rejects
        });
      expect(res.status).toBe(400);
      // _root is the mapped path for top-level unrecognized_keys
      expect(res.body.fieldErrors._root).toMatch(/injectedTopLevel/);
    });

    it('returns 400 for unknown key inside config object', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'kyc',
          config: {
            providerUrl: 'https://kyc.example.com',
            apiKey: 'validapikey-min8',
            injectedField: 'DROP TABLE users;',
          },
        });

      expect(res.status).toBe(400);
      // Zod v4 strict() reports unrecognized_keys at path ['config'] → 'config'
      expect(res.body.fieldErrors['config']).toMatch(/injectedField/);
    });

    it('returns 400 for unknown section name', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'superSecretSection', config: { anything: true } });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.section).toBeDefined();
    });
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  describe('400 response shape (RFC 7807)', () => {
    it('returns application/json content-type', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({});

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('includes type, title, status, detail, and fieldErrors', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({ section: 'fraudThresholds', config: { fraudCeiling: 'bad' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        type: expect.stringContaining('validation-error'),
        title: expect.any(String),
        status: 400,
        detail: expect.any(String),
        fieldErrors: expect.any(Object),
      });
    });

    it('fieldErrors keys are navigable dot-notation paths', async () => {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send({
          section: 'webhook',
          config: { url: 'bad-url', secret: 'short', events: [] },
        });

      expect(res.status).toBe(400);
      // At least one key must start with "config."
      const keys = Object.keys(res.body.fieldErrors);
      const hasPrefixed = keys.some((k) => k.startsWith('config.'));
      expect(hasPrefixed).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — GET /api/admin/config/sections
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/config/sections', () => {
  it('returns 401 without auth', async () => {
    const res = await request(APP).get('/api/admin/config/sections');
    expect(res.status).toBe(401);
  });

  it('returns 200 with sections array when authenticated', async () => {
    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections).toContain('webhook');
    expect(res.body.sections).toContain('fraudThresholds');
    expect(res.body.sections).toHaveLength(CONFIG_SECTIONS.length);
  });
});
