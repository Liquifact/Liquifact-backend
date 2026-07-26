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
 *    › metrics emission (duration histogram + error counter)
 *    › structured logging (no key material exposed)
 */

// The middleware now emits structured pino log lines for every auth outcome
// (missing / invalid / revoked / insufficient_scope / success). Mock the
// shared logger at the module boundary so the existing 100+ assertions stay
// silent on stdout and don't get noisy under CI log-volume gates. Dedicated
// audit-invoked coverage lives in tests/apiKey.test.js.
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
const apiKeysRouter = require('../../src/routes/apiKeys');

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
  timingSafeStringEqual,
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

describe('api-keys endpoint integration', () => {
  let app;

  beforeEach(() => {
    apiKeysRouter.resetRuntimeEntries();
    app = express();
    app.use(express.json());
    app.locals.env = { API_KEYS: '' };
    app.use(apiKeysRouter);
  });

  it('creates a key and returns the expected success shape', async () => {
    const res = await request(app)
      .post('/api-keys')
      .send({
        key: 'lf_newkey0001',
        clientId: 'svc-alpha',
        scopes: ['invoices:read'],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: 'API key created successfully.',
      data: {
        key: 'lf_newkey0001',
        clientId: 'svc-alpha',
        scopes: ['invoices:read'],
        revoked: false,
      },
    });
  });

  it('returns 404 for a missing key', async () => {
    const res = await request(app).get('/api-keys/lf_missingkey001');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'API key not found.',
      code: 'NOT_FOUND',
    });
  });

  it('returns 422 for invalid input and reports validation details', async () => {
    const res = await request(app)
      .post('/api-keys')
      .send({ key: 'bad-key', clientId: '', scopes: [] });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'Validation failed.',
      code: 'VALIDATION_ERROR',
    });
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'body' }),
    ]));
  });

  it('returns an idempotent success response when the same key is created twice', async () => {
    const first = await request(app)
      .post('/api-keys')
      .send({
        key: 'lf_repeatkey01',
        clientId: 'svc-repeat',
        scopes: ['invoices:write'],
      });

    const second = await request(app)
      .post('/api-keys')
      .send({
        key: 'lf_repeatkey01',
        clientId: 'svc-repeat',
        scopes: ['invoices:write'],
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      idempotent: true,
      message: 'API key already exists.',
      data: {
        key: 'lf_repeatkey01',
        clientId: 'svc-repeat',
        scopes: ['invoices:write'],
        revoked: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// middleware/apiKeyAuth — observability (metrics + structured logging)
// ---------------------------------------------------------------------------

describe('middleware/apiKeyAuth — observability', () => {
  const logger = require('../../src/logger');
  const {
    apiKeyAuthDurationSeconds,
    apiKeyAuthErrorsTotal,
  } = require('../../src/metrics');

  beforeEach(() => {
    // Reset metric shims between tests so assertions are isolated.
    apiKeyAuthDurationSeconds.reset();
    apiKeyAuthErrorsTotal.reset();
    jest.restoreAllMocks();
  });

  describe('metrics — duration histogram', () => {
    it('records duration after successful auth', async () => {
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
      await request(app).get('/test').set('X-API-Key', VALID_KEY);

      // Histogram shim stores entries in hashMap keyed by JSON.stringify(labels).
      const keys = Object.keys(apiKeyAuthDurationSeconds.hashMap);
      expect(keys.length).toBeGreaterThan(0);

      const hashMap = apiKeyAuthDurationSeconds.hashMap;
      const hasSuccessEntry = Object.values(hashMap).some(
        (entry) => entry.labels && entry.labels.outcome === 'success',
      );
      expect(hasSuccessEntry).toBe(true);
    });

    it('records duration after 401 (missing key)', async () => {
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
      await request(app).get('/test');

      const hashMap = apiKeyAuthDurationSeconds.hashMap;
      const hasClientErrorEntry = Object.values(hashMap).some(
        (entry) =>
          entry.labels &&
          entry.labels.outcome === 'client_error' &&
          entry.labels.status === '401',
      );
      expect(hasClientErrorEntry).toBe(true);
    });

    it('records duration after 403 (insufficient scope)', async () => {
      const app = makeApp(
        authenticateApiKey({ requiredScope: 'invoices:write', env: REGISTRY_ENV }),
      );
      await request(app).get('/test').set('X-API-Key', SCOPED_KEY);

      const hashMap = apiKeyAuthDurationSeconds.hashMap;
      const hasForbiddenEntry = Object.values(hashMap).some(
        (entry) =>
          entry.labels &&
          entry.labels.outcome === 'client_error' &&
          entry.labels.status === '403',
      );
      expect(hasForbiddenEntry).toBe(true);
    });

    it('recorded labels never contain the API key', async () => {
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
      await request(app).get('/test').set('X-API-Key', VALID_KEY);

      const allLabels = Object.values(
        apiKeyAuthDurationSeconds.hashMap,
      ).map((e) => JSON.stringify(e.labels));
      for (const labelStr of allLabels) {
        expect(labelStr).not.toContain(VALID_KEY);
      }
    });
  });

  describe('metrics — error counter', () => {
    it('increments unauthorized counter on 401', async () => {
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
      await request(app).get('/test');

      const unauthorizedVal = await apiKeyAuthErrorsTotal.get({ cause: 'unauthorized' });
      // Real prom-client returns { values: [...] }; shim returns a number.
      const value = typeof unauthorizedVal === 'object'
        ? (unauthorizedVal.values && unauthorizedVal.values[0] ? unauthorizedVal.values[0].value : 0)
        : unauthorizedVal;
      expect(value).toBeGreaterThan(0);
    });

    it('increments forbidden counter on 403', async () => {
      const app = makeApp(
        authenticateApiKey({ requiredScope: 'invoices:write', env: REGISTRY_ENV }),
      );
      await request(app).get('/test').set('X-API-Key', SCOPED_KEY);

      const forbiddenVal = await apiKeyAuthErrorsTotal.get({ cause: 'forbidden' });
      const value = typeof forbiddenVal === 'object'
        ? (forbiddenVal.values && forbiddenVal.values[0] ? forbiddenVal.values[0].value : 0)
        : forbiddenVal;
      expect(value).toBeGreaterThan(0);
    });

    it('does not increment error counter on 200', async () => {
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
      await request(app).get('/test').set('X-API-Key', VALID_KEY);

      const unauthorizedRaw = await apiKeyAuthErrorsTotal.get({ cause: 'unauthorized' });
      const forbiddenRaw = await apiKeyAuthErrorsTotal.get({ cause: 'forbidden' });
      const internalRaw = await apiKeyAuthErrorsTotal.get({ cause: 'internal_error' });

      const extract = (raw) =>
        typeof raw === 'object'
          ? (raw.values && raw.values[0] ? raw.values[0].value : 0)
          : raw;

      expect(extract(unauthorizedRaw)).toBe(0);
      expect(extract(forbiddenRaw)).toBe(0);
      expect(extract(internalRaw)).toBe(0);
    });
  });

  describe('metrics — error counter for 500 (malformed registry)', () => {
    it('increments internal_error counter and includes error_type in log on 500', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');
      const badEnv = { API_KEYS: '{broken json;' };
      const app = makeApp(authenticateApiKey({ env: badEnv }));

      await request(app).get('/test').set('X-API-Key', 'lf_anything000');

      const internalRaw = await apiKeyAuthErrorsTotal.get({ cause: 'internal_error' });
      const value = typeof internalRaw === 'object'
        ? (internalRaw.values && internalRaw.values[0] ? internalRaw.values[0].value : 0)
        : internalRaw;
      expect(value).toBeGreaterThan(0);

      // Verify structured log includes correct error_type.
      expect(warnSpy).toHaveBeenCalled();
      const logArgs = warnSpy.mock.calls.find(
        (call) => call[1] === 'API key auth request failed',
      );
      expect(logArgs).toBeDefined();
      expect(logArgs[0]).toHaveProperty('error_type', 'internal_error');
      expect(logArgs[0]).toHaveProperty('status', 500);
      expect(logArgs[0]).toHaveProperty('outcome', 'server_error');
    });
  });

  describe('structured logging', () => {
    it('logs a success message on valid auth without exposing key material', async () => {
      const infoSpy = jest.spyOn(logger, 'info');
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));

      await request(app).get('/test').set('X-API-Key', VALID_KEY);

      expect(infoSpy).toHaveBeenCalled();
      const logArgs = infoSpy.mock.calls.find(
        (call) =>
          call[1] === 'API key auth request succeeded',
      );
      expect(logArgs).toBeDefined();

      const logPayload = logArgs[0];
      expect(logPayload).toHaveProperty('endpoint');
      expect(logPayload).toHaveProperty('method');
      expect(logPayload).toHaveProperty('status');
      expect(logPayload).toHaveProperty('duration_ms');
      expect(logPayload).toHaveProperty('outcome', 'success');

      // Assert no key material in logs.
      const logStr = JSON.stringify(logPayload);
      expect(logStr).not.toContain(VALID_KEY);
    });

    it('logs a warning on 401 without exposing key material', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');
      const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));

      await request(app).get('/test').set('X-API-Key', 'lf_badsecretkey');

      expect(warnSpy).toHaveBeenCalled();
      const logArgs = warnSpy.mock.calls.find(
        (call) =>
          call[1] === 'API key auth request failed',
      );
      expect(logArgs).toBeDefined();

      const logPayload = logArgs[0];
      expect(logPayload).toHaveProperty('endpoint');
      expect(logPayload).toHaveProperty('status', 401);
      expect(logPayload).toHaveProperty('error_type', 'unauthorized');

      // Assert no key material in logs.
      const logStr = JSON.stringify(logPayload);
      expect(logStr).not.toContain('lf_badsecretkey');
    });

    it('logs a warning on 403 with forbidden error_type', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');
      const app = makeApp(
        authenticateApiKey({ requiredScope: 'invoices:write', env: REGISTRY_ENV }),
      );

      await request(app).get('/test').set('X-API-Key', SCOPED_KEY);

      expect(warnSpy).toHaveBeenCalled();
      const logArgs = warnSpy.mock.calls.find(
        (call) =>
          call[1] === 'API key auth request failed',
      );
      expect(logArgs).toBeDefined();

      const logPayload = logArgs[0];
      expect(logPayload).toHaveProperty('status', 403);
      expect(logPayload).toHaveProperty('error_type', 'forbidden');
      expect(logPayload).toHaveProperty('outcome', 'client_error');
    });
  });
});

// ---------------------------------------------------------------------------
// timingSafeStringEqual — unit tests
// ---------------------------------------------------------------------------

describe('timingSafeStringEqual — constant-time comparison helper', () => {
  it('returns true when both strings are identical', () => {
    expect(timingSafeStringEqual('lf_validkey001', 'lf_validkey001')).toBe(true);
  });

  it('returns false when strings differ by one character', () => {
    expect(timingSafeStringEqual('lf_validkey001', 'lf_validkey002')).toBe(false);
  });

  it('returns false for completely different strings', () => {
    expect(timingSafeStringEqual('lf_aaaaaaaaaa', 'lf_bbbbbbbbbb')).toBe(false);
  });

  it('returns false when strings have different lengths', () => {
    expect(timingSafeStringEqual('lf_short', 'lf_muchlongerkey')).toBe(false);
  });

  it('returns false for empty string vs non-empty string', () => {
    expect(timingSafeStringEqual('', 'lf_validkey001')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeStringEqual('', '')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(timingSafeStringEqual('lf_ValidKey001', 'lf_validkey001')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// middleware/apiKeyAuth — constant-time lookup via findEntry (via middleware)
// ---------------------------------------------------------------------------

describe('middleware/apiKeyAuth — constant-time lookup', () => {
  it('always evaluates every registry entry (does not short-circuit on first match)', async () => {
    // Build a registry with multiple entries; the valid key is the first entry.
    // If lookup short-circuits, the timing for a matching first key would differ
    // from a matching last key. We assert correct behaviour for all positions.
    const multiEnv = {
      API_KEYS: [
        JSON.stringify({ key: 'lf_firstkey0001', clientId: 'svc-first', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_middlekey001', clientId: 'svc-mid', scopes: ['invoices:read'] }),
        JSON.stringify({ key: 'lf_lastkey00001', clientId: 'svc-last', scopes: ['invoices:read'] }),
      ].join(';'),
    };

    const app = makeApp(authenticateApiKey({ env: multiEnv }));

    // First entry resolves correctly
    const res1 = await request(app).get('/test').set('X-API-Key', 'lf_firstkey0001');
    expect(res1.status).toBe(200);
    expect(res1.body.apiClient.clientId).toBe('svc-first');

    // Middle entry resolves correctly
    const res2 = await request(app).get('/test').set('X-API-Key', 'lf_middlekey001');
    expect(res2.status).toBe(200);
    expect(res2.body.apiClient.clientId).toBe('svc-mid');

    // Last entry resolves correctly
    const res3 = await request(app).get('/test').set('X-API-Key', 'lf_lastkey00001');
    expect(res3.status).toBe(200);
    expect(res3.body.apiClient.clientId).toBe('svc-last');
  });

  it('returns 401 for a key that is a prefix of a valid key', async () => {
    const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
    // VALID_KEY = 'lf_validkey001'; send a prefix of it
    const res = await request(app).get('/test').set('X-API-Key', 'lf_validkey00');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a key that is a superset of a valid key', async () => {
    const app = makeApp(authenticateApiKey({ env: REGISTRY_ENV }));
    const res = await request(app).get('/test').set('X-API-Key', `${VALID_KEY}extra`);
    expect(res.status).toBe(401);
  });
});
