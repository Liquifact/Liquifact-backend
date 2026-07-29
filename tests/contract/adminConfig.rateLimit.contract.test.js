'use strict';

/**
 * @fileoverview Schema/contract test for the POST /api/admin/config 429
 * (rate-limited) response shape (issue #818).
 *
 * Kept in its own file because it needs the *real* rate limiter (the global
 * test mock in tests/mocks/setup.js replaces it with a no-op so the rest of
 * the config test suite isn't rate-limited by accident) and a tight
 * CONFIG_RATE_LIMIT_MAX so a single test can cheaply trip the limit.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
// Must be set before requiring adminConfig — rateLimit.js reads it at
// module-load time.
process.env.CONFIG_RATE_LIMIT_WINDOW_MS = '60000';
process.env.CONFIG_RATE_LIMIT_MAX = '2';

jest.unmock('../../src/middleware/rateLimit');

jest.mock('../../src/db/knex', () => jest.fn());
jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { getValidator, assertResponse } = require('./helpers');
const adminConfigRouter = require('../../src/routes/adminConfig');

const JWT_SECRET = process.env.JWT_SECRET;

function makeAdminToken(sub = 'admin-user', tenantId = 'tenant_test') {
  return jwt.sign({ sub, tenantId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/config', adminConfigRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

const APP = buildApp();
const AUTH = `Bearer ${makeAdminToken()}`;

// `npm test` runs Jest with --runInBand (single process), and `process.env`
// mutations are not sandboxed per test file. Restore these so a later file
// sharing the process doesn't inherit our tightened rate-limit budget.
afterAll(() => {
  delete process.env.CONFIG_RATE_LIMIT_WINDOW_MS;
  delete process.env.CONFIG_RATE_LIMIT_MAX;
});

describe('POST /api/admin/config — 429 response contract', () => {
  it('matches the documented schema once the per-client budget is exhausted', async () => {
    const key = 'lf_contract_test_key_429';
    const payload = {
      section: 'fraudThresholds',
      config: { fraudCeiling: 1000000 },
    };

    await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', 'tenant_contract')
      .send(payload);
    await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', 'tenant_contract')
      .send(payload);
    const blocked = await request(APP)
      .post('/api/admin/config')
      .set('Authorization', AUTH)
      .set('X-API-Key', key)
      .set('X-Tenant-Id', 'tenant_contract')
      .send(payload);

    assertResponse('post', '/api/admin/config', 429, blocked);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
  });

  it('rejects a 429 body missing a required field (e.g. "scope")', () => {
    const { ajv, spec } = getValidator();
    const schema = spec.paths['/api/admin/config'].post.responses['429'].content['application/json'].schema;
    const validate = ajv.compile(schema);

    const mutated = {
      type: 'https://liquifact.com/probs/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      retry_hint: 'Wait for the rate-limit window to reset before retrying.',
      error: 'Too many requests.',
      message: 'Rate limit threshold breached for /api/admin/config. Please try again later.',
      // `scope` intentionally omitted.
    };
    expect(validate(mutated)).toBe(false);
  });
});
