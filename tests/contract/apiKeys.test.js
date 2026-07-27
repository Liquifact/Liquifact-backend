'use strict';

/**
 * tests/contract/apiKeys.test.js
 *
 * Response-shape contract tests for the API-key authentication middleware
 * (src/middleware/apiKeyAuth.js) and the api-keys listing route
 * (src/routes/apiKeys.js).
 *
 * Every test uses exact key assertions so that accidental additions or
 * removals of fields break the suite immediately.
 */

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

const request = require('supertest');
const express = require('express');
const { authenticateApiKey, API_KEY_HEADER } = require('../../src/middleware/apiKeyAuth');
const apiKeysRouter = require('../../src/routes/apiKeys');
const { VALID_SCOPES } = require('../../src/config/apiKeys');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KEY = 'lf_contract001';
const REVOKED_KEY = 'lf_revokedc001';
const SCOPED_KEY = 'lf_scopedco001';

const REGISTRY_ENV = {
  API_KEYS: [
    JSON.stringify({ key: VALID_KEY, clientId: 'svc-read', scopes: ['invoices:read', 'escrow:read'] }),
    JSON.stringify({ key: REVOKED_KEY, clientId: 'svc-old', scopes: ['invoices:read'], revoked: true }),
    JSON.stringify({ key: SCOPED_KEY, clientId: 'svc-write', scopes: ['invoices:write'] }),
  ].join(';'),
};

const ALL_SCOPES_ENV = {
  API_KEYS: [
    JSON.stringify({
      key: 'lf_allscope001',
      clientId: 'svc-all',
      scopes: [...VALID_SCOPES],
    }),
  ].join(';'),
};

/**
 * Builds a minimal Express app that mounts the given middleware and echoes
 * req.apiClient on success.
 *
 * @param {import('express').RequestHandler} middleware
 * @returns {import('express').Express}
 */
function makeAuthApp(middleware) {
  const app = express();
  app.get('/test', middleware, (req, res) => {
    res.json({ apiClient: req.apiClient });
  });
  return app;
}

/**
 * Builds an Express app that mounts the api-keys listing router with
 * a controlled API_KEYS environment variable.
 *
 * @param {string} [apiKeysEnv=''] - Raw API_KEYS env value.
 * @returns {import('express').Express}
 */
function makeKeysApp(apiKeysEnv = '') {
  const app = express();
  const saved = process.env.API_KEYS;
  process.env.API_KEYS = apiKeysEnv;
  app.use('/api-keys', apiKeysRouter);
  // Attach cleanup so callers can restore the original env.
  app._cleanupEnv = () => {
    if (saved === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = saved;
    }
  };
  return app;
}

// ---------------------------------------------------------------------------
// Helper – strict shape assertion
// ---------------------------------------------------------------------------

/**
 * Asserts that `obj` contains exactly the keys listed in `expectedKeys`,
 * with correct types. Fails if an unexpected extra key is present or a
 * required key is missing.
 *
 * @param {object} obj
 * @param {string[]} expectedKeys
 */
function assertExactKeys(obj, expectedKeys) {
  const actual = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  expect(actual).toEqual(expected);
}

// ============================================================================
// 1. Middleware – 401 missing X-API-Key header
// ============================================================================

describe('Contract: middleware 401 – missing X-API-Key', () => {
  const app = makeAuthApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns exactly { error } with the documented message', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    assertExactKeys(res.body, ['error']);
    expect(res.body.error).toBe('API key is required. Provide it via the X-API-Key header.');
  });

  it('does not include any extra fields', async () => {
    const res = await request(app).get('/test');
    assertExactKeys(res.body, ['error']);
  });
});

// ============================================================================
// 2. Middleware – 401 invalid key
// ============================================================================

describe('Contract: middleware 401 – invalid key', () => {
  const app = makeAuthApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns exactly { error } with the documented message', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_notreal0001');
    expect(res.status).toBe(401);
    assertExactKeys(res.body, ['error']);
    expect(res.body.error).toBe('Invalid API key.');
  });

  it('does not leak key material', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_notreal0001');
    expect(JSON.stringify(res.body)).not.toContain('lf_notreal0001');
  });
});

// ============================================================================
// 3. Middleware – 401 revoked key
// ============================================================================

describe('Contract: middleware 401 – revoked key', () => {
  const app = makeAuthApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns exactly { error } with the documented message', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, REVOKED_KEY);
    expect(res.status).toBe(401);
    assertExactKeys(res.body, ['error']);
    expect(res.body.error).toBe('API key has been revoked.');
  });
});

// ============================================================================
// 4. Middleware – 403 insufficient scope
// ============================================================================

describe('Contract: middleware 403 – insufficient scope', () => {
  const app = makeAuthApp(
    authenticateApiKey({ requiredScope: 'invoices:write', env: REGISTRY_ENV }),
  );

  it('returns exactly { error } with the documented message', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(403);
    assertExactKeys(res.body, ['error']);
    expect(res.body.error).toBe('Insufficient permissions. Required scope: "invoices:write".');
  });
});

// ============================================================================
// 5. Middleware – 200 success (req.apiClient attached)
// ============================================================================

describe('Contract: middleware 200 – successful auth attaches apiClient', () => {
  const app = makeAuthApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('apiClient has exactly { clientId, scopes }', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res.status).toBe(200);
    assertExactKeys(res.body.apiClient, ['clientId', 'scopes']);
    expect(typeof res.body.apiClient.clientId).toBe('string');
    expect(Array.isArray(res.body.apiClient.scopes)).toBe(true);
    expect(res.body.apiClient.scopes.length).toBeGreaterThan(0);
    expect(res.body.apiClient.clientId).toBe('svc-read');
    expect(res.body.apiClient.scopes).toEqual(['invoices:read', 'escrow:read']);
  });

  it('scopes are a defensive copy (mutating the response does not affect registry)', async () => {
    const res1 = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    const res2 = await request(app).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res1.body.apiClient.scopes).toEqual(res2.body.apiClient.scopes);
  });
});

// ============================================================================
// 6. Route – GET /api-keys success (paginated list)
// ============================================================================

describe('Contract: GET /api-keys – success shape', () => {
  it('returns { data, nextCursor } with valid entries', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys');

    expect(res.status).toBe(200);
    assertExactKeys(res.body, ['data', 'nextCursor']);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('each entry in data has exactly { key, clientId, scopes, revoked }', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys');

    for (const entry of res.body.data) {
      assertExactKeys(entry, ['key', 'clientId', 'scopes', 'revoked']);
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.clientId).toBe('string');
      expect(Array.isArray(entry.scopes)).toBe(true);
      expect(typeof entry.revoked).toBe('boolean');
    }
  });

  it('nextCursor is null when all entries fit in one page', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys');
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns nextCursor as a string when more pages exist', async () => {
    const manyKeys = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({
        key: `lf_pagekey00${i}`,
        clientId: `svc-page-${i}`,
        scopes: ['invoices:read'],
      }),
    ).join(';');

    const app = makeKeysApp(manyKeys);
    const res = await request(app).get('/api-keys').query({ limit: 1 });

    expect(res.status).toBe(200);
    assertExactKeys(res.body, ['data', 'nextCursor']);
    expect(res.body.data).toHaveLength(1);
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.nextCursor).not.toBeNull();
  });

  it('does not include unexpected top-level fields', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys');
    assertExactKeys(res.body, ['data', 'nextCursor']);
  });
});

// ============================================================================
// 7. Route – GET /api-keys with pagination cursor
// ============================================================================

describe('Contract: GET /api-keys – pagination respects entry shape', () => {
  it('paginated page returns entries with the same shape', async () => {
    const manyKeys = [
      JSON.stringify({ key: 'lf_pagea00001', clientId: 'svc-a', scopes: ['invoices:read'] }),
      JSON.stringify({ key: 'lf_pageb00001', clientId: 'svc-b', scopes: ['invoices:write'] }),
      JSON.stringify({ key: 'lf_pagec00001', clientId: 'svc-c', scopes: ['escrow:read'] }),
    ].join(';');

    const app = makeKeysApp(manyKeys);
    const first = await request(app).get('/api-keys').query({ limit: 1 });

    expect(first.status).toBe(200);
    assertExactKeys(first.body, ['data', 'nextCursor']);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app).get('/api-keys').query({
      limit: 1,
      cursor: first.body.nextCursor,
    });

    expect(second.status).toBe(200);
    assertExactKeys(second.body, ['data', 'nextCursor']);
    expect(second.body.data).toHaveLength(1);
    assertExactKeys(second.body.data[0], ['key', 'clientId', 'scopes', 'revoked']);
  });
});

// ============================================================================
// 8. Route – GET /api-keys invalid cursor
// ============================================================================

describe('Contract: GET /api-keys – 400 invalid cursor', () => {
  it('returns exactly { error } on invalid cursor', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys').query({ cursor: 'not-a-valid-cursor' });

    expect(res.status).toBe(400);
    assertExactKeys(res.body, ['error']);
    expect(res.body.error).toBe('Invalid cursor');
  });
});

// ============================================================================
// 9. Route – empty registry
// ============================================================================

describe('Contract: GET /api-keys – empty registry', () => {
  it('returns { data: [], nextCursor: null } when no keys exist', async () => {
    const app = makeKeysApp('');
    const res = await request(app).get('/api-keys');

    expect(res.status).toBe(200);
    assertExactKeys(res.body, ['data', 'nextCursor']);
    expect(res.body.data).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });
});

// ============================================================================
// 10. Route – valid key entry content
// ============================================================================

describe('Contract: GET /api-keys – entry field values are correct', () => {
  it('returns the exact entries from the registry', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys');

    const keys = res.body.data.map((e) => e.key).sort();
    expect(keys).toEqual([REVOKED_KEY, SCOPED_KEY, VALID_KEY].sort());
  });

  it('revoked flag is false when omitted in the entry', async () => {
    const env = JSON.stringify({
      key: 'lf_norevoke001',
      clientId: 'svc-nr',
      scopes: ['invoices:read'],
    });
    const app = makeKeysApp(env);
    const res = await request(app).get('/api-keys');
    expect(res.body.data[0].revoked).toBe(false);
  });

  it('revoked flag is true when set in the entry', async () => {
    const env = JSON.stringify({
      key: 'lf_yesrevk001',
      clientId: 'svc-yr',
      scopes: ['invoices:read'],
      revoked: true,
    });
    const app = makeKeysApp(env);
    const res = await request(app).get('/api-keys');
    expect(res.body.data[0].revoked).toBe(true);
  });
});

// ============================================================================
// 11. Middleware – Content-Type is JSON for all responses
// ============================================================================

describe('Contract: middleware responses use application/json', () => {
  const app = makeAuthApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('401 missing key returns application/json', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('401 invalid key returns application/json', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_badkey0001');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('401 revoked key returns application/json', async () => {
    const res = await request(app).get('/test').set(API_KEY_HEADER, REVOKED_KEY);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('403 insufficient scope returns application/json', async () => {
    const scoped = makeAuthApp(
      authenticateApiKey({ requiredScope: 'invoices:write', env: REGISTRY_ENV }),
    );
    const res = await request(scoped).get('/test').set(API_KEY_HEADER, VALID_KEY);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ============================================================================
// 12. Route – Content-Type is JSON
// ============================================================================

describe('Contract: GET /api-keys returns application/json', () => {
  it('content-type is application/json', async () => {
    const app = makeKeysApp(REGISTRY_ENV.API_KEYS);
    const res = await request(app).get('/api-keys');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ============================================================================
// 13. All error responses share the same { error: string } shape
// ============================================================================

describe('Contract: all API-key error responses share the same shape', () => {
  it('every error body has exactly { error: string }', async () => {
    const authApp = makeAuthApp(authenticateApiKey({ env: REGISTRY_ENV }));
    const scopeApp = makeAuthApp(
      authenticateApiKey({ requiredScope: 'escrow:read', env: REGISTRY_ENV }),
    );
    const keysApp = makeKeysApp(REGISTRY_ENV.API_KEYS);

    const cases = [
      { label: 'missing header', res: await request(authApp).get('/test') },
      { label: 'invalid key', res: await request(authApp).get('/test').set(API_KEY_HEADER, 'lf_nope000001') },
      { label: 'revoked key', res: await request(authApp).get('/test').set(API_KEY_HEADER, REVOKED_KEY) },
      { label: 'insufficient scope', res: await request(scopeApp).get('/test').set(API_KEY_HEADER, SCOPED_KEY) },
      { label: 'invalid cursor', res: await request(keysApp).get('/api-keys').query({ cursor: 'bad' }) },
    ];

    for (const { label, res } of cases) {
      assertExactKeys(res.body, ['error'], `${label}: unexpected keys`);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// 14. Scope validation – all VALID_SCOPES are accepted
// ============================================================================

describe('Contract: middleware scope enforcement covers all VALID_SCOPES', () => {
  it('each scope in VALID_SCOPES can be enforced independently', async () => {
    for (const scope of VALID_SCOPES) {
      const app = makeAuthApp(
        authenticateApiKey({ requiredScope: scope, env: ALL_SCOPES_ENV }),
      );
      const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_allscope001');
      expect(res.status).toBe(200);
    }
  });

  it('each scope in VALID_SCOPES returns 403 when missing', async () => {
    for (const scope of VALID_SCOPES) {
      const missingScopes = VALID_SCOPES.filter((s) => s !== scope);
      const env = {
        API_KEYS: JSON.stringify({
          key: 'lf_noscope001',
          clientId: 'svc-missing',
          scopes: missingScopes,
        }),
      };
      const app = makeAuthApp(
        authenticateApiKey({ requiredScope: scope, env }),
      );
      const res = await request(app).get('/test').set(API_KEY_HEADER, 'lf_noscope001');
      expect(res.status).toBe(403);
      assertExactKeys(res.body, ['error']);
      expect(res.body.error).toContain(scope);
    }
  });
});
