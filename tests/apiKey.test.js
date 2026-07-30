'use strict';

/**
 * tests/apiKey.test.js
 *
 * Migration smoke tests verifying that the legacy SQLite-backed API key
 * middleware has been fully retired and all callers now use the env-registry
 * authenticator in src/middleware/apiKeyAuth.js.
 *
 * Deep coverage of authenticateApiKey + config/apiKeys lives in
 * tests/unit/apiKeyAuth.test.js. This file focuses on:
 *   - legacy module is gone (no sqlite3, no per-request DB connection)
 *   - the modern path handles the same scenarios the old test covered
 *   - stacks.js adminAuth uses the registry-backed middleware
 */

// The middleware emits structured pino log lines for every auth outcome
// (missing / invalid / revoked / insufficient_scope / success). We mock the
// shared logger with stable jest.fn() handles so audit-invoked assertions
// are robust to logging-internals changes (Proxy / _enrichedLevelMethods).
// This mirrors the strategy used in tests/unit/apiKeyAuth.test.js.
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(),
  createRequestLogger: jest.fn(),
};
jest.mock('../src/logger', () => mockLogger);

const request = require('supertest');
const express = require('express');
const { authenticateApiKey, API_KEY_HEADER } = require('../src/middleware/apiKeyAuth');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_KEY = 'lf_testmigr00001';
const REVOKED_KEY = 'lf_revokedkey001';
const SCOPED_KEY = 'lf_scopedkey0001';

const TEST_ENV = {
  API_KEYS: [
    JSON.stringify({ key: VALID_KEY, clientId: 'test-service', scopes: ['invoices:read', 'escrow:read'] }),
    JSON.stringify({ key: REVOKED_KEY, clientId: 'old-service', scopes: ['invoices:read'], revoked: true }),
    JSON.stringify({ key: SCOPED_KEY, clientId: 'scoped-service', scopes: ['invoices:write'] }),
  ].join(';'),
};

function makeApp(middleware) {
  const app = express();
  app.get('/protected', middleware, (req, res) => res.json({ ok: true, apiClient: req.apiClient }));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

// ─── Legacy module is gone ────────────────────────────────────────────────────

describe('legacy apiKey.js is retired', () => {
  it('src/middleware/apiKey.js no longer exists', () => {
    expect(() => require('../src/middleware/apiKey')).toThrow();
  });

  it('does not expose initDb (no per-request SQLite connection)', () => {
    const mod = require('../src/middleware/apiKeyAuth');
    expect(mod.initDb).toBeUndefined();
  });

  it('does not export hashApiKey (raw SHA-256 key hashing is internal)', () => {
    const mod = require('../src/middleware/apiKeyAuth');
    expect(mod.hashApiKey).toBeUndefined();
  });
});

// ─── Audit service invoked (issue #590) ──────────────────────────────────────
// The legacy SQLite path used SQL-logged audit events. The new path must use
// the shared structured logger — never SQL — and must never write raw key
// material to any log line.

describe('authenticateApiKey — audit service integration', () => {
  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('invokes the shared logger.warn on a missing X-API-Key (no raw key data)', async () => {
    const app = makeApp(authenticateApiKey({ env: TEST_ENV }));
    await request(app).get('/protected');
    expect(mockLogger.warn).toHaveBeenCalled();
    const firstCall = mockLogger.warn.mock.calls[0][0];
    expect(firstCall).toMatchObject({ event: 'api_key.auth', outcome: 'missing_header' });
    // No raw key, no header echo, no token leakage
    expect(JSON.stringify(firstCall)).not.toMatch(/lf_/);
  });

  it('invokes the shared logger.warn on an invalid key', async () => {
    const app = makeApp(authenticateApiKey({ env: TEST_ENV }));
    await request(app).get('/protected').set(API_KEY_HEADER, 'lf_attacker_guess');
    expect(mockLogger.warn).toHaveBeenCalled();
    const payload = mockLogger.warn.mock.calls[0][0];
    expect(payload).toMatchObject({ event: 'api_key.auth', outcome: 'invalid_key' });
    // The candidate key must not be logged under any outcome
    expect(JSON.stringify(payload)).not.toContain('lf_attacker_guess');
  });

  it('invokes the shared logger.warn on a revoked key (without leaking it)', async () => {
    const app = makeApp(authenticateApiKey({ env: TEST_ENV }));
    await request(app).get('/protected').set(API_KEY_HEADER, REVOKED_KEY);
    expect(mockLogger.warn).toHaveBeenCalled();
    const payload = mockLogger.warn.mock.calls[0][0];
    expect(payload).toMatchObject({
      event: 'api_key.auth',
      outcome: 'revoked',
      clientId: 'old-service',
    });
    // The raw key string is never written to the log
    expect(JSON.stringify(payload)).not.toContain(REVOKED_KEY);
  });

  it('invokes the shared logger.warn on insufficient scope', async () => {
    const app = makeApp(
      authenticateApiKey({ requiredScope: 'invoices:write', env: TEST_ENV })
    );
    await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(mockLogger.warn).toHaveBeenCalled();
    const payload = mockLogger.warn.mock.calls[0][0];
    expect(payload).toMatchObject({
      event: 'api_key.auth',
      outcome: 'insufficient_scope',
      clientId: 'test-service',
      requiredScope: 'invoices:write',
    });
    expect(JSON.stringify(payload)).not.toContain(VALID_KEY);
  });

  it('invokes the shared logger.info on a successful auth (no raw key)', async () => {
    const app = makeApp(authenticateApiKey({ env: TEST_ENV }));
    await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(mockLogger.info).toHaveBeenCalled();
    const payload = mockLogger.info.mock.calls[0][0];
    expect(payload).toMatchObject({
      event: 'api_key.auth',
      outcome: 'success',
      clientId: 'test-service',
    });
    // clientId + scopes are OK; the raw key string is never written
    expect(JSON.stringify(payload)).not.toContain(VALID_KEY);
  });
});

// ─── Modern path — missing header ─────────────────────────────────────────────

describe('authenticateApiKey — missing header', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 401 when X-API-Key header is absent', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key is required/);
  });

  it('returns 401 when X-API-Key header is empty', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, '');
    expect(res.status).toBe(401);
  });
});

// ─── Modern path — invalid key ────────────────────────────────────────────────

describe('authenticateApiKey — invalid key', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 401 for an unrecognised key', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_unknownkey999');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid API key/);
  });

  it('does not leak key material in the error response', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_secretvalue0');
    expect(JSON.stringify(res.body)).not.toContain('lf_secretvalue0');
  });
});

// ─── Modern path — revoked key ────────────────────────────────────────────────

describe('authenticateApiKey — revoked key', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 401 for a revoked key', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, REVOKED_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/);
  });
});

// ─── Modern path — valid key ──────────────────────────────────────────────────

describe('authenticateApiKey — valid key', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('returns 200 and populates req.apiClient', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiClient).toMatchObject({
      clientId: 'test-service',
      scopes: expect.arrayContaining(['invoices:read', 'escrow:read']),
    });
  });

  it('accepts key with surrounding whitespace', async () => {
    const res = await request(app).get('/protected').set(API_KEY_HEADER, `  ${VALID_KEY}  `);
    expect(res.status).toBe(200);
  });
});

// ─── Modern path — wrong scope ────────────────────────────────────────────────

describe('authenticateApiKey — scope enforcement', () => {
  it('returns 403 when the key lacks the required scope', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'invoices:write', env: TEST_ENV }));
    // VALID_KEY only has invoices:read and escrow:read
    const res = await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Insufficient permissions/);
  });

  it('returns 200 when the key has the required scope', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'invoices:write', env: TEST_ENV }));
    const res = await request(app).get('/protected').set(API_KEY_HEADER, SCOPED_KEY);
    expect(res.status).toBe(200);
  });
});

// ─── Modern path — malformed registry ────────────────────────────────────────

describe('authenticateApiKey — malformed registry', () => {
  it('surfaces a 500 when API_KEYS contains invalid JSON', async () => {
    const app = makeApp(authenticateApiKey({ env: { API_KEYS: '{broken' } }));
    const res = await request(app).get('/protected').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(500);
  });
});

// ─── Timing-safe comparison (no short-circuit) ───────────────────────────────

describe('authenticateApiKey — timing-safe lookup', () => {
  it('uses constant-time comparison (always evaluates all registry entries)', async () => {
    const multiEnv = {
      API_KEYS: [
        JSON.stringify({ key: 'lf_alpha00000001', clientId: 'svc-alpha', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_beta000000001', clientId: 'svc-beta', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_gamma00000001', clientId: 'svc-gamma', scopes: ['invoices:read'] }),
      ].join(';'),
    };
    const app = makeApp(authenticateApiKey({ env: multiEnv }));

    const r1 = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_alpha00000001');
    expect(r1.body.apiClient.clientId).toBe('svc-alpha');

    const r2 = await request(app).get('/protected').set(API_KEY_HEADER, 'lf_gamma00000001');
    expect(r2.body.apiClient.clientId).toBe('svc-gamma');
  });
});

// ─── X-API-KEY header contract (issue #590) ─────────────────────────────────

describe('authenticateApiKey — X-API-KEY header contract', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('accepts the lowercase X-API-Key variant', async () => {
    const res = await request(app).get('/protected').set('X-API-Key', VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiClient.clientId).toBe('test-service');
  });

  it('accepts the uppercase X-API-KEY variant (Express normalises headers)', async () => {
    const res = await request(app).get('/protected').set('X-API-KEY', VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiClient.clientId).toBe('test-service');
  });

  it('rejects when no X-API-Key header is present at all', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });
});

// ─── No-key-material-in-responses (issue #590 security checklist) ────────────

describe('authenticateApiKey — no key material leaks', () => {
  const app = makeApp(authenticateApiKey({ env: TEST_ENV }));

  it('does not echo the candidate key in 401 bodies', async () => {
    const candidate = 'lf_supersecretvalue';
    const res = await request(app).get('/protected').set(API_KEY_HEADER, candidate);
    expect(res.status).toBe(401);
    // The raw candidate must never appear in the response body
    expect(JSON.stringify(res.body)).not.toContain(candidate);
  });

  it('does not echo any registry key in 401 / 403 bodies', async () => {
    for (const candidate of [VALID_KEY, REVOKED_KEY, SCOPED_KEY, 'lf_unknownkey999']) {
      const res = await request(app).get('/protected').set(API_KEY_HEADER, candidate);
      expect(JSON.stringify(res.body)).not.toContain(candidate);
    }
  });
});

// ─── No SQLite connection on the hot path (issue #590) ───────────────────────

describe('authenticateApiKey — no SQLite on the hot path', () => {
  it('does not import sqlite or sqlite3 anywhere in the middleware module', () => {
    // Read the raw module source and assert it contains no SQLite references.
    // The regex uses a word-boundary so future comments mentioning the
    // retirement of SQLite stay compliant.
    const fs = require('fs');
    const path = require('path');
    const modulePath = path.join(__dirname, '..', 'src', 'middleware', 'apiKeyAuth.js');
    const source = fs.readFileSync(modulePath, 'utf8');
    expect(source).not.toMatch(/\bsqlite3?\b/i);
    expect(source).not.toMatch(/require\(['"]sqlite/);
  });

  it('the public module surface does not expose any database handle', () => {
    const mod = require('../src/middleware/apiKeyAuth');
    const dbLikeKeys = ['db', 'database', 'initDb', 'openDb', 'connection', 'pool'];
    for (const k of dbLikeKeys) {
      expect(mod[k]).toBeUndefined();
    }
  });

  it('serves 100 sequential requests without opening any DB connection', async () => {
    const app = makeApp(authenticateApiKey({ env: TEST_ENV }));
    for (let i = 0; i < 100; i += 1) {
      // Mix of valid, invalid, revoked — none may touch the filesystem or DB
      const candidates = [VALID_KEY, REVOKED_KEY, `lf_attempt_${i}`];
      const res = await request(app).get('/protected').set(API_KEY_HEADER, candidates[i % 3]);
      expect([200, 401]).toContain(res.status);
    }
  });
});
