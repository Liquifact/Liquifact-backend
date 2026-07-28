'use strict';

/**
 * @fileoverview Integration tests for config endpoint success, not-found,
 * validation-failure, and idempotent-repeat paths.
 *
 * Covers the gaps in the existing adminConfig.validation.test.js:
 *  - Full 200 response shape verification
 *  - Idempotent-repeat: same valid payload submitted twice
 *  - Not-found / unknown section edge cases
 *  - Multiple simultaneous field errors
 *  - Body type edge cases (null, string, array)
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
  configRequestDurationSeconds: { labels: () => ({ observe: jest.fn() }) },
  configRequestsTotal: { labels: () => ({ inc: jest.fn() }) },
  configRequestErrorsTotal: { labels: () => ({ inc: jest.fn() }) },
  normalizeConfigEndpoint: () => 'config_update',
  normalizeConfigStatusClass: () => '2xx',
  normalizeConfigCause: () => 'none',
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

// ── Imports ──────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const { CONFIG_SECTIONS } = require('../../src/schemas/config');
const adminConfigRouter   = require('../../src/routes/adminConfig');

// ── Helpers ──────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

function makeAdminToken(sub = 'admin-user', tenantId = 'tenant_test') {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    if (!req.tenantId) { req.tenantId = 'tenant_test'; }
    next();
  });

  app.use('/api/admin/config', adminConfigRouter);

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return app;
}

const APP  = buildApp();
const AUTH = `Bearer ${makeAdminToken()}`;

// ── Valid payloads per section ───────────────────────────────────────────────

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
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Success path: full response shape
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config - success path', () => {
  it('returns application/json content-type on 200', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns section, config, and message in the response body', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('section', 'webhook');
    expect(res.body).toHaveProperty('config');
    expect(res.body).toHaveProperty('message');
  });

  it('echoes back the config values exactly', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual(VALID_PAYLOADS.webhook.config);
  });

  it('message contains the section name', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('webhook');
  });

  it('does not return unexpected top-level keys', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.fraudThresholds);

    expect(res.status).toBe(200);
    const keys = Object.keys(res.body);
    expect(keys).toEqual(expect.arrayContaining(['section', 'config', 'message']));
    expect(keys).toHaveLength(3);
  });

  it('succeeds for every valid section', async () => {
    for (const [name, payload] of Object.entries(VALID_PAYLOADS)) {
      const res = await request(APP)
        .post('/api/admin/config')
        .set('Authorization', AUTH)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.section).toBe(name);
      expect(res.body.config).toEqual(payload.config);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Idempotent-repeat path
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config - idempotent repeat', () => {
  it('returns 200 with identical response when the same payload is sent twice', async () => {
    const payload = VALID_PAYLOADS.webhook;

    const res1 = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(payload);

    const res2 = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res2.body.section).toBe(res1.body.section);
    expect(res2.body.config).toEqual(res1.body.config);
    expect(res2.body.message).toBe(res1.body.message);
  });

  it('returns 200 when the same fraudThresholds payload is sent three times', async () => {
    const payload = VALID_PAYLOADS.fraudThresholds;

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(APP)
          .post('/api/admin/config')
          .set('Authorization', AUTH)
          .send(payload),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.section).toBe('fraudThresholds');
      expect(res.body.config).toEqual(payload.config);
    }
  });

  it('treats each section independently (idempotent per section)', async () => {
    const res1 = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.webhook);

    const res2 = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send(VALID_PAYLOADS.kyc);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.section).toBe('webhook');
    expect(res2.body.section).toBe('kyc');
    expect(res1.body.config).not.toEqual(res2.body.config);
  });

  it('succeeds when alternating between two different valid sections', async () => {
    const payloadA = VALID_PAYLOADS.retention;
    const payloadB = VALID_PAYLOADS.reconciliation;

    const resA1 = await request(APP).post('/api/admin/config').set('Authorization', AUTH).send(payloadA);
    const resB1 = await request(APP).post('/api/admin/config').set('Authorization', AUTH).send(payloadB);
    const resA2 = await request(APP).post('/api/admin/config').set('Authorization', AUTH).send(payloadA);
    const resB2 = await request(APP).post('/api/admin/config').set('Authorization', AUTH).send(payloadB);

    expect(resA1.status).toBe(200);
    expect(resB1.status).toBe(200);
    expect(resA2.status).toBe(200);
    expect(resB2.status).toBe(200);

    expect(resA2.body.config).toEqual(resA1.body.config);
    expect(resB2.body.config).toEqual(resB1.body.config);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Not-found / unknown section edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config - not-found / unknown section', () => {
  it('returns 400 for a completely unknown section name', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: 'nonexistent', config: { anything: true } });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when section is an empty string', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: '', config: {} });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when section is null', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: null, config: {} });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when section is a boolean', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: true, config: {} });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when section is an array', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: ['webhook'], config: {} });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns 400 when section is a valid name but config is for a different section', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({
        section: 'webhook',
        config: { fraudCeiling: 5000000 },
      });

    expect(res.status).toBe(400);
  });

  it('returns RFC 7807 shape for unknown section', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: 'doesNotExist', config: {} });

    expect(res.status).toBe(400);
    expect(res.body.type).toContain('validation-error');
    expect(res.body.title).toMatch(/validation/i);
    expect(res.body.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Validation-failure: body type edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config - body type edge cases', () => {
  it('returns 400 when body is an empty object', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
    expect(res.body.fieldErrors.config).toBeDefined();
  });

  it('returns 400 when body is an array', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send([{ section: 'webhook', config: {} }]);

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is a string', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send('not json');

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is a number (sent as raw JSON)', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send('42');

    expect(res.status).toBe(400);
  });

  it('returns 400 when Content-Type is not set (raw body)', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('Content-Type', 'text/plain')
      .send('plain text');

    expect(res.status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Validation-failure: multiple simultaneous field errors
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config - multiple simultaneous field errors', () => {
  it('returns multiple fieldErrors when both section and config are invalid', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: 123, config: 'not-an-object' });

    expect(res.status).toBe(400);
    const keys = Object.keys(res.body.fieldErrors);
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it('returns fieldErrors for section and config-level errors together', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({
        section: 'webhook',
        config: {
          url: 'not-a-url',
          secret: 'short',
          events: [],
          enabled: 'yes',
        },
      });

    expect(res.status).toBe(400);
    const keys = Object.keys(res.body.fieldErrors);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.some((k) => k.startsWith('config.'))).toBe(true);
  });

  it('returns fieldErrors for unknown section and bad config together', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({ section: 'fake', config: { unknownField: 1 } });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.section).toBeDefined();
  });

  it('returns all fieldErrors as string values', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .send({});

    expect(res.status).toBe(400);
    for (const value of Object.values(res.body.fieldErrors)) {
      expect(typeof value).toBe('string');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — GET /api/admin/config/sections — edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/config/sections - edge cases', () => {
  it('returns exactly CONFIG_SECTIONS from the module', async () => {
    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual(CONFIG_SECTIONS);
  });

  it('returns application/json content-type', async () => {
    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH);

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('sections array contains no duplicates', async () => {
    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH);

    expect(new Set(res.body.sections).size).toBe(res.body.sections.length);
  });

  it('sections array contains only strings', async () => {
    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', AUTH);

    for (const s of res.body.sections) {
      expect(typeof s).toBe('string');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Auth edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/config - auth edge cases', () => {
  it('returns 401 when Authorization header is empty', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', '')
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(401);
  });

  it('returns 401 when Bearer prefix is missing', async () => {
    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', makeAdminToken())
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    const expired = jwt.sign(
      { sub: 'admin', tenantId: 'tenant_test', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '0s' },
    );

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', `Bearer ${expired}`)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(401);
  });

  it('returns 401 when token is signed with wrong secret', async () => {
    const wrong = jwt.sign(
      { sub: 'admin', tenantId: 'tenant_test', role: 'admin' },
      'wrong-secret-that-is-at-least-32-characters',
      { expiresIn: '1h' },
    );

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', `Bearer ${wrong}`)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(401);
  });

  it('accepts a valid token without role claim (auth layer does not enforce role)', async () => {
    const noRole = jwt.sign(
      { sub: 'admin', tenantId: 'tenant_test' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', `Bearer ${noRole}`)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(200);
  });

  it('accepts a valid token with non-admin role (auth layer does not enforce role)', async () => {
    const userToken = jwt.sign(
      { sub: 'user', tenantId: 'tenant_test', role: 'user' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );

    const res = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send(VALID_PAYLOADS.webhook);

    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/config/sections - auth edge cases', () => {
  it('returns 401 with no auth header', async () => {
    const res = await request(APP).get('/api/admin/config/sections');
    expect(res.status).toBe(401);
  });

  it('returns 401 with expired token', async () => {
    const expired = jwt.sign(
      { sub: 'admin', tenantId: 'tenant_test', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '0s' },
    );

    const res = await request(APP)
      .get('/api/admin/config/sections')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
  });
});
