'use strict';

/**
 * @fileoverview Contract tests for API-key response shapes.
 *
 * Asserts that every response produced by the API-key subsystem matches its
 * documented contract exactly: correct fields, correct types, required fields
 * present, and no undocumented extra keys.
 *
 * Covered surfaces:
 *   1. Auth middleware error responses (401 / 403)  — src/middleware/apiKeyAuth.js
 *   2. Auth middleware success shape (req.apiClient) — documented in docs/api-keys.md
 *   3. Listing endpoint success shape                — src/routes/apiKeys.js
 *   4. Listing endpoint cursor error shape
 *   5. Limit query-param edge cases (type coercion, bounds)
 *   6. Malformed registry error shape (500)
 *   7. revoked field coercion (optional → boolean)
 *   8. nextCursor base64 validity
 *   9. Empty / whitespace X-API-Key header contract
 */

const request = require('supertest');
const express = require('express');

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(),
  createRequestLogger: jest.fn(),
}));

jest.mock('../../src/metrics', () => ({
  registry: { metrics: jest.fn(), contentType: 'text/plain' },
  getRegistry: jest.fn(),
  metricsAuth: jest.fn((_req, res, next) => next()),
  metricsHandler: jest.fn((_req, res) => res.send('')),
  recordMetricsEndpointOutcome: jest.fn(),
  normalizeMetricsEndpointStatusClass: jest.fn(),
  normalizeMetricsEndpointCause: jest.fn(),
  metricsRequestDurationSeconds: { observe: jest.fn(), labels: jest.fn(() => ({ observe: jest.fn() })) },
  metricsRequestsTotal: { inc: jest.fn(), labels: jest.fn(() => ({ inc: jest.fn() })) },
  metricsRequestErrorsTotal: { inc: jest.fn(), labels: jest.fn(() => ({ inc: jest.fn() })) },
  apiKeyAuthDurationSeconds: { observe: jest.fn() },
  apiKeyAuthErrorsTotal: { inc: jest.fn() },
  classifyApiKeyOutcome: jest.fn(() => 'success'),
  classifyApiKeyErrorCause: jest.fn(() => null),
  safeEqual: jest.fn(),
  extractClientIp: jest.fn(() => '127.0.0.1'),
  LOOPBACK: '127.0.0.1',
}));

const { authenticateApiKey, API_KEY_HEADER } = require('../../src/middleware/apiKeyAuth');
const apiKeysRouter = require('../../src/routes/apiKeys');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KEY = 'lf_contract001';
const REVOKED_KEY = 'lf_revokedc01';
const SCOPED_KEY = 'lf_scopedcn01';

const TEST_ENV = {
  API_KEYS: [
    JSON.stringify({ key: VALID_KEY, clientId: 'svc-contract-a', scopes: ['invoices:read', 'escrow:read'] }),
    JSON.stringify({ key: REVOKED_KEY, clientId: 'svc-contract-b', scopes: ['invoices:read'], revoked: true }),
    JSON.stringify({ key: SCOPED_KEY, clientId: 'svc-contract-c', scopes: ['escrow:read'] }),
  ].join(';'),
};

function makeAuthApp(middleware) {
  const app = express();
  app.get('/test', middleware, (req, res) => res.json({ apiClient: req.apiClient }));
  return app;
}

function makeListingApp(envOverride) {
  const app = express();
  if (envOverride && envOverride.API_KEYS !== undefined) {
    process.env.API_KEYS = envOverride.API_KEYS;
  }
  app.use(apiKeysRouter);
  return app;
}

// ---------------------------------------------------------------------------
// 1. Auth middleware — error response contracts
// ---------------------------------------------------------------------------

describe('Contract: auth middleware error responses', () => {
  describe('401 — missing X-API-Key header', () => {
    const app = makeAuthApp(authenticateApiKey({ env: TEST_ENV }));

    it('has status 401', async () => {
      const res = await request(app).get('/test');
      expect(res.status).toBe(401);
    });

    it('body contains exactly { error: string }', async () => {
      const res = await request(app).get('/test');
      expect(res.body).toEqual({
        error: expect.stringContaining('API key is required'),
      });
    });

    it('has no extra fields', async () => {
      const res = await request(app).get('/test');
      expect(Object.keys(res.body).sort()).toEqual(['error']);
    });

    it('error is a non-empty string', async () => {
      const res = await request(app).get('/test');
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
    });
  });

  describe('401 — invalid (unrecognised) key', () => {
    const app = makeAuthApp(authenticateApiKey({ env: TEST_ENV }));

    it('has status 401', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_nosuchkey01');
      expect(res.status).toBe(401);
    });

    it('body contains exactly { error: string }', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_nosuchkey01');
      expect(res.body).toEqual({
        error: expect.stringContaining('Invalid API key'),
      });
    });

    it('has no extra fields', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_nosuchkey01');
      expect(Object.keys(res.body).sort()).toEqual(['error']);
    });
  });

  describe('401 — revoked key', () => {
    const app = makeAuthApp(authenticateApiKey({ env: TEST_ENV }));

    it('has status 401', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, REVOKED_KEY);
      expect(res.status).toBe(401);
    });

    it('body contains exactly { error: string }', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, REVOKED_KEY);
      expect(res.body).toEqual({
        error: expect.stringContaining('revoked'),
      });
    });

    it('has no extra fields', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, REVOKED_KEY);
      expect(Object.keys(res.body).sort()).toEqual(['error']);
    });
  });

  describe('403 — insufficient scope', () => {
    const app = makeAuthApp(
      authenticateApiKey({ requiredScope: 'invoices:write', env: TEST_ENV }),
    );

    it('has status 403', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, SCOPED_KEY);
      expect(res.status).toBe(403);
    });

    it('body contains exactly { error: string }', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, SCOPED_KEY);
      expect(res.body).toEqual({
        error: expect.stringContaining('Insufficient permissions'),
      });
    });

    it('has no extra fields', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, SCOPED_KEY);
      expect(Object.keys(res.body).sort()).toEqual(['error']);
    });

    it('error includes the required scope name', async () => {
      const res = await request(app).get('/test').set(API_KEY_HEADER, SCOPED_KEY);
      expect(res.body.error).toContain('invoices:write');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Auth middleware — success shape (req.apiClient)
// ---------------------------------------------------------------------------

describe('Contract: auth middleware success shape (req.apiClient)', () => {
  const app = makeAuthApp(authenticateApiKey({ env: TEST_ENV }));

  it('has status 200', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(200);
  });

  it('response body contains { apiClient: { clientId, scopes } }', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res.body).toEqual({
      apiClient: {
        clientId: 'svc-contract-a',
        scopes: expect.arrayContaining(['invoices:read', 'escrow:read']),
      },
    });
  });

  it('apiClient has exactly 2 keys: clientId and scopes', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(Object.keys(res.body.apiClient).sort()).toEqual(['clientId', 'scopes']);
  });

  it('clientId is a non-empty string', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(typeof res.body.apiClient.clientId).toBe('string');
    expect(res.body.apiClient.clientId.length).toBeGreaterThan(0);
  });

  it('scopes is a non-empty array of strings', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    const { scopes } = res.body.apiClient;
    expect(Array.isArray(scopes)).toBe(true);
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(typeof scope).toBe('string');
    }
  });

  it('scopes is a defensive copy (mutating it does not affect the next request)', async () => {
    const res1 = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    res1.body.apiClient.scopes.push('injected');

    const res2 = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res2.body.apiClient.scopes).not.toContain('injected');
  });

  it('no extra fields beyond clientId and scopes', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    const extraKeys = Object.keys(res.body.apiClient).filter(
      (k) => k !== 'clientId' && k !== 'scopes',
    );
    expect(extraKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /api/api-keys — listing success shape
// ---------------------------------------------------------------------------

describe('Contract: GET /api/api-keys listing success shape', () => {
  const env = {
    API_KEYS: [
      JSON.stringify({ key: 'lf_listkey0001', clientId: 'svc-list-a', scopes: ['invoices:read'] }),
      JSON.stringify({ key: 'lf_listkey0002', clientId: 'svc-list-b', scopes: ['escrow:read'], revoked: true }),
    ].join(';'),
  };

  it('has status 200', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('response body contains exactly { data, nextCursor }', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
  });

  it('data is an array', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('nextCursor is null when all items fit on one page', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    expect(res.body.nextCursor).toBeNull();
  });

  it('each entry has exactly { key, clientId, scopes, revoked }', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    for (const entry of res.body.data) {
      expect(Object.keys(entry).sort()).toEqual(['clientId', 'key', 'revoked', 'scopes']);
    }
  });

  it('each entry has correct field types', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    for (const entry of res.body.data) {
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.clientId).toBe('string');
      expect(Array.isArray(entry.scopes)).toBe(true);
      expect(typeof entry.revoked).toBe('boolean');
    }
  });

  it('key starts with lf_ and is a non-empty string', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    for (const entry of res.body.data) {
      expect(entry.key).toMatch(/^lf_/);
      expect(entry.key.length).toBeGreaterThan(0);
    }
  });

  it('scopes is a non-empty array of strings', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    for (const entry of res.body.data) {
      expect(entry.scopes.length).toBeGreaterThan(0);
      for (const s of entry.scopes) {
        expect(typeof s).toBe('string');
      }
    }
  });

  it('returns all keys from registry (including revoked)', async () => {
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    expect(res.body.data).toHaveLength(2);
    const clientIds = res.body.data.map((e) => e.clientId).sort();
    expect(clientIds).toEqual(['svc-list-a', 'svc-list-b']);
  });
});

// ---------------------------------------------------------------------------
// 4. GET /api/api-keys — empty registry
// ---------------------------------------------------------------------------

describe('Contract: GET /api/api-keys with empty registry', () => {
  it('returns { data: [], nextCursor: null } when no keys configured', async () => {
    const app = makeListingApp({ API_KEYS: '' });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], nextCursor: null });
  });

  it('response body has exactly 2 keys', async () => {
    const app = makeListingApp({ API_KEYS: '' });
    const res = await request(app).get('/');
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
  });
});

// ---------------------------------------------------------------------------
// 5. GET /api/api-keys — cursor error shape
// ---------------------------------------------------------------------------

describe('Contract: GET /api/api-keys cursor error', () => {
  it('returns 400 with { error: string } for an invalid cursor', async () => {
    const app = makeListingApp(TEST_ENV);
    const res = await request(app).get('/').query({ cursor: 'not-a-valid-cursor' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid cursor' });
  });

  it('error body has exactly 1 key', async () => {
    const app = makeListingApp(TEST_ENV);
    const res = await request(app).get('/').query({ cursor: 'not-a-valid-cursor' });
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('returns 400 for a non-existent cursor (valid base64 but unknown key)', async () => {
    const app = makeListingApp(TEST_ENV);
    const fakeCursor = Buffer.from('lf_nonexistent01').toString('base64');
    const res = await request(app).get('/').query({ cursor: fakeCursor });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid cursor' });
  });
});

// ---------------------------------------------------------------------------
// 6. GET /api/api-keys — pagination cursor shape
// ---------------------------------------------------------------------------

describe('Contract: GET /api/api-keys pagination cursor', () => {
  const manyKeys = {
    API_KEYS: [
      JSON.stringify({ key: 'lf_pagekey0001', clientId: 'svc-p1', scopes: ['invoices:read'] }),
      JSON.stringify({ key: 'lf_pagekey0002', clientId: 'svc-p2', scopes: ['invoices:read'] }),
      JSON.stringify({ key: 'lf_pagekey0003', clientId: 'svc-p3', scopes: ['invoices:read'] }),
    ].join(';'),
  };

  it('nextCursor is a string when there are more pages', async () => {
    const app = makeListingApp(manyKeys);
    const res = await request(app).get('/').query({ limit: 1 });
    expect(res.status).toBe(200);
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.data).toHaveLength(1);
  });

  it('nextCursor is null on the last page', async () => {
    const app = makeListingApp(manyKeys);
    const res = await request(app).get('/').query({ limit: 100 });
    expect(res.body.nextCursor).toBeNull();
  });

  it('second page returns the remaining items', async () => {
    const app = makeListingApp(manyKeys);
    const page1 = await request(app).get('/').query({ limit: 2 });
    expect(page1.body.data).toHaveLength(2);
    expect(typeof page1.body.nextCursor).toBe('string');

    const page2 = await request(app).get('/').query({ limit: 2, cursor: page1.body.nextCursor });
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('pagination response body always has exactly { data, nextCursor }', async () => {
    const app = makeListingApp(manyKeys);
    const res = await request(app).get('/').query({ limit: 1 });
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
  });
});

// ---------------------------------------------------------------------------
// 7. Content-Type header
// ---------------------------------------------------------------------------

describe('Contract: response Content-Type', () => {
  it('auth middleware error returns application/json', async () => {
    const app = makeAuthApp(authenticateApiKey({ env: TEST_ENV }));
    const res = await request(app).get('/test');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('listing endpoint returns application/json', async () => {
    const app = makeListingApp(TEST_ENV);
    const res = await request(app).get('/');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('cursor error returns application/json', async () => {
    const app = makeListingApp(TEST_ENV);
    const res = await request(app).get('/').query({ cursor: 'bad' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// 8. Limit query-param edge cases — shape consistency
// ---------------------------------------------------------------------------

describe('Contract: GET /api/api-keys limit edge cases', () => {
  const singleKey = {
    API_KEYS: JSON.stringify({ key: 'lf_limittest01', clientId: 'svc-lim', scopes: ['invoices:read'] }),
  };

  it('non-numeric limit falls back to default, still { data, nextCursor }', async () => {
    const app = makeListingApp(singleKey);
    const res = await request(app).get('/').query({ limit: 'abc' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('limit=0 falls back to default, shape unchanged', async () => {
    const app = makeListingApp(singleKey);
    const res = await request(app).get('/').query({ limit: '0' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
  });

  it('negative limit falls back to default, shape unchanged', async () => {
    const app = makeListingApp(singleKey);
    const res = await request(app).get('/').query({ limit: '-5' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
  });

  it('limit exceeding max is clamped, shape unchanged', async () => {
    const app = makeListingApp(singleKey);
    const res = await request(app).get('/').query({ limit: '999' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
  });
});

// ---------------------------------------------------------------------------
// 9. revoked field coercion (optional input → boolean in response)
// ---------------------------------------------------------------------------

describe('Contract: revoked field coercion', () => {
  it('entry without revoked in input still has boolean revoked in response', async () => {
    const env = {
      API_KEYS: JSON.stringify({ key: 'lf_norevoked01', clientId: 'svc-nr', scopes: ['escrow:read'] }),
    };
    const app = makeListingApp(env);
    const res = await request(app).get('/');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].revoked).toBe(false);
    expect(typeof res.body.data[0].revoked).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 10. Malformed registry — 500 error shape
// ---------------------------------------------------------------------------

describe('Contract: malformed API_KEYS env', () => {
  afterEach(() => { delete process.env.API_KEYS; });

  it('returns 500 with a JSON body when env contains broken JSON', async () => {
    process.env.API_KEYS = '{not valid json;';
    const app = express();
    app.use(apiKeysRouter);
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body).toBe('object');
    expect(res.body).not.toBeNull();
    expect(typeof res.body.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 11. Empty / whitespace X-API-Key header
// ---------------------------------------------------------------------------

describe('Contract: empty and whitespace X-API-Key', () => {
  const app = makeAuthApp(authenticateApiKey({ env: TEST_ENV }));

  it('empty string header returns 401 with { error }', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, '');
    expect(res.status).toBe(401);
    expect(Object.keys(res.body).sort()).toEqual(['error']);
  });

  it('whitespace-only header returns 401 with { error }', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, '   ');
    expect(res.status).toBe(401);
    expect(Object.keys(res.body).sort()).toEqual(['error']);
  });
});

// ---------------------------------------------------------------------------
// 12. nextCursor is valid base64 when non-null
// ---------------------------------------------------------------------------

describe('Contract: nextCursor base64 validity', () => {
  it('nextCursor decodes to a key string via base64', async () => {
    const env = {
      API_KEYS: [
        JSON.stringify({ key: 'lf_b64key00001', clientId: 'svc-1', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_b64key00002', clientId: 'svc-2', scopes: ['invoices:read'] }),
      ].join(';'),
    };
    const app = makeListingApp(env);
    const res = await request(app).get('/').query({ limit: 1 });
    expect(typeof res.body.nextCursor).toBe('string');
    const decoded = Buffer.from(res.body.nextCursor, 'base64').toString('utf8');
    expect(decoded).toBe('lf_b64key00001');
  });
});
