/**
 * Tests for API key authentication — middleware and key registry.
 *
 * Covers:
 *  - parseApiKeys / buildKeyRegistry / loadApiKeyRegistry (config/apiKeys)
 *  - authenticateApiKey middleware (middleware/apiKeyAuth)
 *    › missing key  › invalid key  › revoked key
 *    › scope enforcement  › valid + scoped access
 *    › req.apiClient population
 *    › env override for isolated tests
 */

const request = require('supertest');
const express = require('express');

const {
  parseApiKeys,
  buildKeyRegistry,
  loadApiKeyRegistry,
  validateEntry,
  VALID_SCOPES,
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
} = require('../../src/config/apiKeys');

const {
  authenticateApiKey,
  API_KEY_HEADER,
} = require('../../src/middleware/apiKeyAuth');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Express app that mounts the given middleware on GET /test
 * and echoes req.apiClient on success.
 *
 * @param {import('express').RequestHandler} middleware - Middleware under test.
 * @returns {import('express').Express} Configured app.
 */
function makeApp(middleware) {
  const app = express();
  app.get('/test', middleware, (req, res) => {
    res.json({ apiClient: req.apiClient });
  });
  return app;
}

/**
 * Builds a valid JSON entry string suitable for inclusion in API_KEYS.
 *
 * @param {Partial<{key: string, clientId: string, scopes: string[], revoked: boolean}>} overrides
 * @returns {string} Serialised JSON object.
 */
function makeEntry(overrides = {}) {
  return JSON.stringify({
    key: 'lf_testkey001',
    clientId: 'test-service',
    scopes: ['invoices:read'],
    ...overrides,
  });
}

/** A pre-built valid API_KEYS string used across multiple test groups. */
const VALID_KEY = 'lf_validkey001';
const REVOKED_KEY = 'lf_revokedkey01';
const SCOPED_KEY = 'lf_scopedkey001';

const REGISTRY_ENV = {
  API_KEYS: [
    JSON.stringify({ key: VALID_KEY, clientId: 'svc-a', scopes: ['invoices:read', 'invoices:write'] }),
    JSON.stringify({ key: REVOKED_KEY, clientId: 'svc-b', scopes: ['invoices:read'], revoked: true }),
    JSON.stringify({ key: SCOPED_KEY, clientId: 'svc-c', scopes: ['escrow:read'] }),
  ].join(';'),
};

// ---------------------------------------------------------------------------
// config/apiKeys — unit tests
// ---------------------------------------------------------------------------

describe('config/apiKeys — parseApiKeys', () => {
  it('returns an empty array for undefined input', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseApiKeys('')).toEqual([]);
  });

  it('returns an empty array for a whitespace-only string', () => {
    expect(parseApiKeys('   ')).toEqual([]);
  });

  it('parses a single valid entry', () => {
    const raw = makeEntry();
    const result = parseApiKeys(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'lf_testkey001',
      clientId: 'test-service',
      scopes: ['invoices:read'],
      revoked: false,
    });
  });

  it('parses multiple entries separated by semicolons', () => {
    const raw = [makeEntry({ key: 'lf_key0000001' }), makeEntry({ key: 'lf_key0000002', clientId: 'svc-2' })].join(';');
    expect(parseApiKeys(raw)).toHaveLength(2);
  });

  it('ignores empty segments between semicolons', () => {
    const raw = `;${makeEntry()};;`;
    expect(parseApiKeys(raw)).toHaveLength(1);
  });

  it('propagates revoked flag when true', () => {
    const raw = makeEntry({ revoked: true });
    expect(parseApiKeys(raw)[0].revoked).toBe(true);
  });

  it('defaults revoked to false when absent', () => {
    const raw = makeEntry();
    expect(parseApiKeys(raw)[0].revoked).toBe(false);
  });

  it('throws when an entry is not valid JSON', () => {
    expect(() => parseApiKeys('not-json')).toThrow(/failed to parse JSON/);
  });

  it('throws when an entry is a JSON array instead of an object', () => {
    expect(() => parseApiKeys('[1,2]')).toThrow(/must be a JSON object/);
  });

  it('throws when an entry is a JSON primitive', () => {
    expect(() => parseApiKeys('42')).toThrow(/must be a JSON object/);
  });
});

describe('config/apiKeys — validateEntry', () => {
  it('throws when key is missing', () => {
    expect(() => validateEntry({ clientId: 'x', scopes: ['invoices:read'] }, 0))
      .toThrow(/"key" must be a non-empty string/);
  });

  it('throws when key does not start with the required prefix', () => {
    expect(() => validateEntry({ key: 'bad_key0001', clientId: 'x', scopes: ['invoices:read'] }, 0))
      .toThrow(new RegExp(`"key" must start with "${API_KEY_PREFIX}"`));
  });

  it(`throws when key is shorter than ${MIN_KEY_LENGTH} characters`, () => {
    expect(() => validateEntry({ key: 'lf_short', clientId: 'x', scopes: ['invoices:read'] }, 0))
      .toThrow(/at least/);
  });

  it('throws when clientId is missing', () => {
    expect(() => validateEntry({ key: 'lf_validkey001', scopes: ['invoices:read'] }, 0))
      .toThrow(/"clientId" must be a non-empty string/);
  });

  it('throws when clientId is an empty string', () => {
    expect(() => validateEntry({ key: 'lf_validkey001', clientId: '  ', scopes: ['invoices:read'] }, 0))
      .toThrow(/"clientId" must be a non-empty string/);
  });

  it('throws when scopes is missing', () => {
    expect(() => validateEntry({ key: 'lf_validkey001', clientId: 'x' }, 0))
      .toThrow(/"scopes" must be a non-empty array/);
  });

  it('throws when scopes is an empty array', () => {
    expect(() => validateEntry({ key: 'lf_validkey001', clientId: 'x', scopes: [] }, 0))
      .toThrow(/"scopes" must be a non-empty array/);
  });

  it('throws when a scope is not in the valid list', () => {
    expect(() => validateEntry({ key: 'lf_validkey001', clientId: 'x', scopes: ['unknown:scope'] }, 0))
      .toThrow(/unknown scope/);
  });

  it('throws when revoked is not a boolean', () => {
    expect(() => validateEntry({ key: 'lf_validkey001', clientId: 'x', scopes: ['invoices:read'], revoked: 'yes' }, 0))
      .toThrow(/"revoked" must be a boolean/);
  });

  it('accepts every value in VALID_SCOPES individually', () => {
    for (const scope of VALID_SCOPES) {
      expect(() =>
        validateEntry({ key: 'lf_validkey001', clientId: 'svc', scopes: [scope] }, 0)
      ).not.toThrow();
    }
  });

  it('accepts all VALID_SCOPES together', () => {
    expect(() =>
      validateEntry({ key: 'lf_validkey001', clientId: 'svc', scopes: VALID_SCOPES }, 0)
    ).not.toThrow();
  });
});

describe('config/apiKeys — buildKeyRegistry', () => {
  it('returns a Map keyed by the key string', () => {
    const entries = parseApiKeys(makeEntry());
    const registry = buildKeyRegistry(entries);
    expect(registry).toBeInstanceOf(Map);
    expect(registry.has('lf_testkey001')).toBe(true);
  });

  it('throws on duplicate key strings', () => {
    const entries = [
      ...parseApiKeys(makeEntry()),
      ...parseApiKeys(makeEntry({ clientId: 'other-service' })),
    ];
    expect(() => buildKeyRegistry(entries)).toThrow(/duplicate key/);
  });

  it('returns an empty Map for an empty entry list', () => {
    expect(buildKeyRegistry([])).toEqual(new Map());
  });
});

describe('config/apiKeys — loadApiKeyRegistry', () => {
  it('returns an empty Map when API_KEYS is not set', () => {
    const registry = loadApiKeyRegistry({});
    expect(registry.size).toBe(0);
  });

  it('loads and indexes keys from the env object', () => {
    const registry = loadApiKeyRegistry(REGISTRY_ENV);
    expect(registry.size).toBe(3);
    expect(registry.has(VALID_KEY)).toBe(true);
    expect(registry.has(REVOKED_KEY)).toBe(true);
    expect(registry.has(SCOPED_KEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// middleware/apiKeyAuth — unit tests (direct invocation, no HTTP)
// ---------------------------------------------------------------------------

describe('middleware/apiKeyAuth — API_KEY_HEADER constant', () => {
  it('is the lowercase header name', () => {
    expect(API_KEY_HEADER).toBe('x-api-key');
  });
});

// ---------------------------------------------------------------------------
// middleware/apiKeyAuth — integration tests (via supertest)
// ---------------------------------------------------------------------------

describe('middleware/apiKeyAuth — missing key', () => {
  const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns 401 when the X-API-Key header is absent', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key is required/);
  });

  it('returns 401 when the header value is an empty string', async () => {
    const res = await request(app).get('/test').set('X-API-Key', '');
    expect(res.status).toBe(401);
  });
});

describe('middleware/apiKeyAuth — invalid key', () => {
  const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns 401 for an unrecognised key', async () => {
    const res = await request(app).get('/test').set('X-API-Key', 'lf_unknownkey000');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid API key/);
  });

  it('returns 401 for a key that does not match the prefix', async () => {
    const res = await request(app).get('/test').set('X-API-Key', 'sk_notavalidkey');
    expect(res.status).toBe(401);
  });
});

describe('middleware/apiKeyAuth — revoked key', () => {
  const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns 401 for a revoked key', async () => {
    const res = await request(app).get('/test').set('X-API-Key', REVOKED_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/);
  });
});

describe('middleware/apiKeyAuth — valid key, no scope requirement', () => {
  const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));

  it('returns 200 and attaches apiClient for a valid key', async () => {
    const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiClient).toMatchObject({
      clientId: 'svc-a',
      scopes: expect.arrayContaining(['invoices:read', 'invoices:write']),
    });
  });
});

describe('middleware/apiKeyAuth — scope enforcement', () => {
  it('returns 403 when the required scope is missing from the key', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'invoices:write', env: REGISTRY_ENV }));
    // SCOPED_KEY only has escrow:read
    const res = await request(app).get('/test').set('X-API-Key', SCOPED_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Insufficient permissions/);
    expect(res.body.error).toMatch(/invoices:write/);
  });

  it('returns 200 when the key has the required scope', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'invoices:read', env: REGISTRY_ENV }));
    const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
    expect(res.status).toBe(200);
  });

  it('returns 200 when the key has exactly the required scope', async () => {
    const app = makeApp(authenticateApiKey({ requiredScope: 'escrow:read', env: REGISTRY_ENV }));
    const res = await request(app).get('/test').set('X-API-Key', SCOPED_KEY);
    expect(res.status).toBe(200);
    expect(res.body.apiClient.clientId).toBe('svc-c');
  });

  it('passes when no requiredScope is specified and any valid key is used', async () => {
    const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
    const res = await request(app).get('/test').set('X-API-Key', SCOPED_KEY);
    expect(res.status).toBe(200);
  });
});

describe('middleware/apiKeyAuth — req.apiClient population', () => {
  it('attaches clientId and a defensive copy of scopes', async () => {
    const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
    const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
    const { apiClient } = res.body;
    expect(apiClient).toHaveProperty('clientId', 'svc-a');
    expect(Array.isArray(apiClient.scopes)).toBe(true);
  });
});

describe('middleware/apiKeyAuth — whitespace-trimmed key', () => {
  it('accepts a key with surrounding whitespace by trimming it', async () => {
    const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
    const res = await request(app).get('/test').set('X-API-Key', `  ${VALID_KEY}  `);
    expect(res.status).toBe(200);
  });
});

describe('middleware/apiKeyAuth — empty registry', () => {
  it('returns 401 for any key when no keys are configured', async () => {
    const app = makeApp(authenticateApiKey({ env: {} }));
    const res = await request(app).get('/test').set('X-API-Key', VALID_KEY);
    expect(res.status).toBe(401);
  });
});

describe('middleware/apiKeyAuth — malformed API_KEYS env propagates error', () => {
  it('surfaces a 500-class error when the registry itself is malformed', async () => {
    const badEnv = { API_KEYS: '{broken json;' };
    const app = makeApp(authenticateApiKey({ env: badEnv }));
    const res = await request(app).get('/test').set('X-API-Key', 'lf_anything000');
    // The registry load throws; Express default error handler returns 500
    expect(res.status).toBe(500);
  });
});
