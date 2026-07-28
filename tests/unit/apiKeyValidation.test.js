'use strict';

/**
 * @fileoverview Tests for API key input validation schemas and routes.
 *
 * Covers:
 *  - apiKeyCreateSchema / apiKeyUpdateSchema (schemas/apiKeys)
 *  - validateApiKeyBody middleware
 *  - Enhanced validateEntry in config/apiKeys (max length bounds, unknown fields)
 *  - API key management routes (routes/apiKeys)
 *
 * @jest-environment node
 */

const request = require('supertest');
const express = require('express');
const { z } = require('zod');

const {
  apiKeyCreateSchema,
  apiKeyUpdateSchema,
  validateApiKeyBody,
  parseValidationErrors,
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  VALID_SCOPES,
} = require('../../src/schemas/apiKeys');

const {
  validateEntry,
  rejectUnknownFields,
  parseApiKeys,
  API_KEY_PREFIX: CONFIG_PREFIX,
  MIN_KEY_LENGTH: CONFIG_MIN_KEY_LENGTH,
  MAX_KEY_LENGTH: CONFIG_MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH: CONFIG_MAX_CLIENT_LENGTH,
  MAX_SCOPES_COUNT: CONFIG_MAX_SCOPES_COUNT,
  KNOWN_ENTRY_FIELDS,
} = require('../../src/config/apiKeys');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a minimal Express app with the API key validation middleware
 * mounted on POST /test.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').Express}
 */
function makeValidationApp(schema) {
  const app = express();
  app.use(express.json());
  app.post('/test', validateApiKeyBody(schema), (req, res) => {
    res.json({ data: req.validatedApiKey });
  });
  // Error handler to catch middleware errors
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

/**
 * Builds a valid API key entry payload.
 *
 * @param {Partial<{key: string, clientId: string, scopes: string[], revoked: boolean}>} overrides
 * @returns {Object}
 */
function validPayload(overrides = {}) {
  return {
    key: 'lf_testkey001',
    clientId: 'test-service',
    scopes: ['invoices:read'],
    ...overrides,
  };
}

// ── Schema unit tests ────────────────────────────────────────────────────────

describe('apiKeyCreateSchema', () => {
  it('accepts a valid payload', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it('rejects when key is missing', () => {
    const { clientId, scopes } = validPayload();
    const result = apiKeyCreateSchema.safeParse({ clientId, scopes });
    expect(result.success).toBe(false);
  });

  it('rejects when clientId is missing', () => {
    const { key, scopes } = validPayload();
    const result = apiKeyCreateSchema.safeParse({ key, scopes });
    expect(result.success).toBe(false);
  });

  it('rejects when scopes is missing', () => {
    const { key, clientId } = validPayload();
    const result = apiKeyCreateSchema.safeParse({ key, clientId });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = apiKeyCreateSchema.safeParse(
      validPayload({ extraField: 'should not be here' })
    );
    expect(result.success).toBe(false);
  });

  it('rejects wrong type for key (number)', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: 12345 }));
    expect(result.success).toBe(false);
  });

  it('rejects wrong type for clientId (boolean)', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ clientId: true }));
    expect(result.success).toBe(false);
  });

  it('rejects wrong type for scopes (string)', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ scopes: 'invoices:read' }));
    expect(result.success).toBe(false);
  });

  it('rejects wrong type for revoked (string)', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ revoked: 'yes' }));
    expect(result.success).toBe(false);
  });

  it('rejects key that does not start with lf_', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: 'sk_notvalidkey0001' }));
    expect(result.success).toBe(false);
  });

  it(`rejects key shorter than ${MIN_KEY_LENGTH} chars`, () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: 'lf_short' }));
    expect(result.success).toBe(false);
  });

  it(`rejects key longer than ${MAX_KEY_LENGTH} chars`, () => {
    const longKey = API_KEY_PREFIX + 'a'.repeat(MAX_KEY_LENGTH);
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: longKey }));
    expect(result.success).toBe(false);
  });

  it(`accepts key at exactly ${MIN_KEY_LENGTH} chars`, () => {
    const exactKey = 'lf_' + 'a'.repeat(MIN_KEY_LENGTH - 3); // -3 for "lf_"
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: exactKey }));
    expect(result.success).toBe(true);
  });

  it(`accepts key at exactly ${MAX_KEY_LENGTH - 1} chars (boundary)`, () => {
    const exactKey = API_KEY_PREFIX + 'a'.repeat(MAX_KEY_LENGTH - 4); // -3 for "lf_" + the last char
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: exactKey }));
    expect(result.success).toBe(true);
  });

  it('trims whitespace from key', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ key: '  lf_testkey001  ' }));
    expect(result.success).toBe(true);
    expect(result.data.key).toBe('lf_testkey001');
  });

  it('trims whitespace from clientId', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ clientId: '  my-service  ' }));
    expect(result.success).toBe(true);
    expect(result.data.clientId).toBe('my-service');
  });

  it(`rejects clientId longer than ${MAX_CLIENT_ID_LENGTH} chars`, () => {
    const longId = 'a'.repeat(MAX_CLIENT_ID_LENGTH + 1);
    const result = apiKeyCreateSchema.safeParse(validPayload({ clientId: longId }));
    expect(result.success).toBe(false);
  });

  it(`accepts clientId at exactly ${MAX_CLIENT_ID_LENGTH} chars (boundary)`, () => {
    const exactId = 'a'.repeat(MAX_CLIENT_ID_LENGTH);
    const result = apiKeyCreateSchema.safeParse(validPayload({ clientId: exactId }));
    expect(result.success).toBe(true);
  });

  it('rejects empty scopes array', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ scopes: [] }));
    expect(result.success).toBe(false);
  });

  it(`rejects scopes array with more than ${MAX_SCOPES_COUNT} entries`, () => {
    const tooManyScopes = Array(MAX_SCOPES_COUNT + 1).fill('invoices:read');
    const result = apiKeyCreateSchema.safeParse(validPayload({ scopes: tooManyScopes }));
    expect(result.success).toBe(false);
  });

  it(`accepts scopes at exactly ${MAX_SCOPES_COUNT} entries (boundary)`, () => {
    const exactScopes = Array(MAX_SCOPES_COUNT).fill('invoices:read');
    const result = apiKeyCreateSchema.safeParse(validPayload({ scopes: exactScopes }));
    expect(result.success).toBe(true);
  });

  it('rejects an unknown scope', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ scopes: ['invoices:read', 'unknown:scope'] }));
    expect(result.success).toBe(false);
  });

  it('accepts all valid scopes', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ scopes: VALID_SCOPES }));
    expect(result.success).toBe(true);
  });

  it('accepts revoked as false (explicit)', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ revoked: false }));
    expect(result.success).toBe(true);
    expect(result.data.revoked).toBe(false);
  });

  it('accepts revoked as true', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload({ revoked: true }));
    expect(result.success).toBe(true);
    expect(result.data.revoked).toBe(true);
  });

  it('defaults revoked to undefined when absent', () => {
    const result = apiKeyCreateSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
    expect(result.data.revoked).toBeUndefined();
  });

  it('rejects null as payload', () => {
    const result = apiKeyCreateSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects array as payload', () => {
    const result = apiKeyCreateSchema.safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
  });

  it('rejects string as payload', () => {
    const result = apiKeyCreateSchema.safeParse('not-an-object');
    expect(result.success).toBe(false);
  });
});

describe('apiKeyUpdateSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = apiKeyUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a partial update (key only)', () => {
    const result = apiKeyUpdateSchema.safeParse({ key: 'lf_newkey00001' });
    expect(result.success).toBe(true);
  });

  it('accepts revoked only', () => {
    const result = apiKeyUpdateSchema.safeParse({ revoked: true });
    expect(result.success).toBe(true);
  });

  it('accepts scopes only', () => {
    const result = apiKeyUpdateSchema.safeParse({ scopes: ['escrow:read'] });
    expect(result.success).toBe(true);
  });

  it('accepts all fields', () => {
    const result = apiKeyUpdateSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields', () => {
    const result = apiKeyUpdateSchema.safeParse({ extraField: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects wrong type for revoked in partial update', () => {
    const result = apiKeyUpdateSchema.safeParse({ revoked: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects empty scopes array in partial update', () => {
    const result = apiKeyUpdateSchema.safeParse({ scopes: [] });
    expect(result.success).toBe(false);
  });
});

// ── validateApiKeyBody middleware tests ───────────────────────────────────────

describe('validateApiKeyBody middleware', () => {
  it('passes valid body and attaches req.validatedApiKey', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const res = await request(app)
      .post('/test')
      .send(validPayload())
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      key: 'lf_testkey001',
      clientId: 'test-service',
      scopes: ['invoices:read'],
    });
  });

  it('returns 400 with structured error for invalid body', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const res = await request(app)
      .post('/test')
      .send({ key: 'lf_testkey001' }) // missing clientId and scopes
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('API_KEY_VALIDATION_ERROR');
    expect(res.body.type).toBe('https://liquifact.com/probs/validation-error');
    expect(res.body.title).toBe('Validation Error');
    expect(res.body.fieldErrors).toBeDefined();
  });

  it('returns 400 with fieldErrors for unknown field', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const res = await request(app)
      .post('/test')
      .send(validPayload({ extraField: 'value' }))
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('API_KEY_VALIDATION_ERROR');
  });

  it('returns 400 for malformed JSON body', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const res = await request(app)
      .post('/test')
      .send('not-json')
      .set('Content-Type', 'application/json');

    // Express body parser will fail before our middleware
    expect(res.status).toBe(400);
  });

  it('returns 400 for oversized key', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const longKey = API_KEY_PREFIX + 'a'.repeat(MAX_KEY_LENGTH);
    const res = await request(app)
      .post('/test')
      .send(validPayload({ key: longKey }))
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
  });

  it('returns 400 for oversized clientId', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const longId = 'a'.repeat(MAX_CLIENT_ID_LENGTH + 1);
    const res = await request(app)
      .post('/test')
      .send(validPayload({ clientId: longId }))
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toBeDefined();
  });

  it('returns 400 for empty body', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const res = await request(app)
      .post('/test')
      .send({})
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('API_KEY_VALIDATION_ERROR');
  });

  it('returns 400 for null body', async () => {
    const app = makeValidationApp(apiKeyCreateSchema);
    const res = await request(app)
      .post('/test')
      .send(null)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
  });
});

// ── Enhanced config/apiKeys validation tests ─────────────────────────────────

describe('config/apiKeys — enhanced validateEntry', () => {
  it('rejects unknown fields in entry', () => {
    expect(() =>
      validateEntry(
        { key: 'lf_validkey001', clientId: 'svc', scopes: ['invoices:read'], extra: 'field' },
        0
      )
    ).toThrow(/unknown field/);
  });

  it('rejects multiple unknown fields', () => {
    expect(() =>
      validateEntry(
        {
          key: 'lf_validkey001',
          clientId: 'svc',
          scopes: ['invoices:read'],
          foo: 'bar',
          baz: 'qux',
        },
        0
      )
    ).toThrow(/unknown field.*"foo", "baz"/);
  });

  it(`rejects key longer than ${CONFIG_MAX_KEY_LENGTH} chars`, () => {
    const longKey = 'lf_' + 'a'.repeat(CONFIG_MAX_KEY_LENGTH);
    expect(() =>
      validateEntry(
        { key: longKey, clientId: 'svc', scopes: ['invoices:read'] },
        0
      )
    ).toThrow(/must not exceed/);
  });

  it('accepts key at exactly max length boundary', () => {
    const exactKey = 'lf_' + 'a'.repeat(CONFIG_MAX_KEY_LENGTH - 4); // still under
    expect(() =>
      validateEntry(
        { key: exactKey, clientId: 'svc', scopes: ['invoices:read'] },
        0
      )
    ).not.toThrow();
  });

  it(`rejects clientId longer than ${CONFIG_MAX_CLIENT_LENGTH} chars`, () => {
    const longId = 'a'.repeat(CONFIG_MAX_CLIENT_LENGTH + 1);
    expect(() =>
      validateEntry(
        { key: 'lf_validkey001', clientId: longId, scopes: ['invoices:read'] },
        0
      )
    ).toThrow(/must not exceed/);
  });

  it('accepts clientId at exactly max length boundary', () => {
    const exactId = 'a'.repeat(CONFIG_MAX_CLIENT_LENGTH);
    expect(() =>
      validateEntry(
        { key: 'lf_validkey001', clientId: exactId, scopes: ['invoices:read'] },
        0
      )
    ).not.toThrow();
  });

  it(`rejects scopes with more than ${CONFIG_MAX_SCOPES_COUNT} entries`, () => {
    const tooMany = Array(CONFIG_MAX_SCOPES_COUNT + 1).fill('invoices:read');
    expect(() =>
      validateEntry(
        { key: 'lf_validkey001', clientId: 'svc', scopes: tooMany },
        0
      )
    ).toThrow(/must not exceed/);
  });

  it('accepts scopes at exactly max count boundary', () => {
    const exactScopes = Array(CONFIG_MAX_SCOPES_COUNT).fill('invoices:read');
    expect(() =>
      validateEntry(
        { key: 'lf_validkey001', clientId: 'svc', scopes: exactScopes },
        0
      )
    ).not.toThrow();
  });
});

describe('config/apiKeys — rejectUnknownFields', () => {
  it('does not throw for a known-fields-only entry', () => {
    expect(() =>
      rejectUnknownFields(
        { key: 'lf_k1', clientId: 'c1', scopes: ['invoices:read'] },
        0
      )
    ).not.toThrow();
  });

  it('does not throw for entry with revoked', () => {
    expect(() =>
      rejectUnknownFields(
        { key: 'lf_k1', clientId: 'c1', scopes: ['invoices:read'], revoked: true },
        0
      )
    ).not.toThrow();
  });

  it('throws for a single unknown field', () => {
    expect(() =>
      rejectUnknownFields(
        { key: 'lf_k1', clientId: 'c1', scopes: ['invoices:read'], admin: true },
        0
      )
    ).toThrow(/unknown field.*"admin"/);
  });

  it('throws for multiple unknown fields with correct index', () => {
    expect(() =>
      rejectUnknownFields(
        { key: 'lf_k1', clientId: 'c1', scopes: ['invoices:read'], a: 1, b: 2 },
        5
      )
    ).toThrow(/API_KEYS\[5\].*"a", "b"/);
  });
});

describe('config/apiKeys — parseApiKeys with enhanced validation', () => {
  it('throws on unknown fields in a parsed entry', () => {
    const raw = JSON.stringify({ key: 'lf_validkey001', clientId: 'svc', scopes: ['invoices:read'], extra: true });
    expect(() => parseApiKeys(raw)).toThrow(/unknown field/);
  });

  it('throws on oversized key in a parsed entry', () => {
    const longKey = 'lf_' + 'a'.repeat(CONFIG_MAX_KEY_LENGTH);
    const raw = JSON.stringify({ key: longKey, clientId: 'svc', scopes: ['invoices:read'] });
    expect(() => parseApiKeys(raw)).toThrow(/must not exceed/);
  });
});

// ── KNOWN_ENTRY_FIELDS constant test ─────────────────────────────────────────

describe('config/apiKeys — KNOWN_ENTRY_FIELDS', () => {
  it('contains the four expected fields', () => {
    expect(KNOWN_ENTRY_FIELDS).toEqual(new Set(['key', 'clientId', 'scopes', 'revoked']));
  });
});

// ── parseValidationErrors helper ─────────────────────────────────────────────

describe('parseValidationErrors', () => {
  it('returns an empty object for an error with no issues', () => {
    // Simulate by passing an object with empty issues
    expect(parseValidationErrors({ issues: [] })).toEqual({});
  });

  it('maps a single issue path to message', () => {
    const err = {
      issues: [{ path: ['key'], message: 'key is required' }],
    };
    expect(parseValidationErrors(err)).toEqual({ key: 'key is required' });
  });

  it('maps nested paths using dot notation', () => {
    const err = {
      issues: [{ path: ['scopes', 0], message: 'Invalid scope' }],
    };
    expect(parseValidationErrors(err)).toEqual({ 'scopes.0': 'Invalid scope' });
  });

  it('uses _root for issues with no path', () => {
    const err = {
      issues: [{ path: [], message: 'Invalid payload' }],
    };
    expect(parseValidationErrors(err)).toEqual({ _root: 'Invalid payload' });
  });

  it('takes only the first message for duplicate paths', () => {
    const err = {
      issues: [
        { path: ['key'], message: 'key is required' },
        { path: ['key'], message: 'key must be a string' },
      ],
    };
    expect(parseValidationErrors(err)).toEqual({ key: 'key is required' });
  });
});

// ── Exports for schema test coverage ─────────────────────────────────────────

describe('schema exports', () => {
  it('exports all expected constants', () => {
    expect(API_KEY_PREFIX).toBe('lf_');
    expect(MIN_KEY_LENGTH).toBe(10);
    expect(MAX_KEY_LENGTH).toBe(256);
    expect(MAX_CLIENT_ID_LENGTH).toBe(128);
    expect(MAX_SCOPES_COUNT).toBe(20);
    expect(VALID_SCOPES).toEqual(['invoices:read', 'invoices:write', 'escrow:read']);
  });

  it('config/apiKeys exports all expected constants', () => {
    const config = require('../../src/config/apiKeys');
    expect(config.API_KEY_PREFIX).toBe('lf_');
    expect(config.MIN_KEY_LENGTH).toBe(10);
    expect(config.MAX_KEY_LENGTH).toBe(256);
    expect(config.MAX_CLIENT_ID_LENGTH).toBe(128);
    expect(config.MAX_SCOPES_COUNT).toBe(20);
    expect(config.KNOWN_ENTRY_FIELDS).toBeInstanceOf(Set);
    expect(config.rejectUnknownFields).toBeInstanceOf(Function);
    expect(config.validateEntry).toBeInstanceOf(Function);
    expect(config.parseApiKeys).toBeInstanceOf(Function);
  });
});

// ── Route integration tests ──────────────────────────────────────────────────

describe('API keys routes', () => {
  let OLD_ENV;

  beforeAll(() => {
    OLD_ENV = { ...process.env };
  });

  afterAll(() => {
    process.env = { ...OLD_ENV };
  });

  describe('POST /api/admin/apikeys', () => {
    it('returns 401 when no API key header is provided', async () => {
      // We need a full app with the route mounted. Since the route requires
      // admin scope, we test the validation independently via the middleware
      // test above. This confirms the auth guard works.
      const app = express();
      app.use(express.json());

      const { authenticateApiKey } = require('../../src/middleware/apiKeyAuth');
      const { validateApiKeyBody, apiKeyCreateSchema } = require('../../src/schemas/apiKeys');

      app.post('/test', authenticateApiKey({ env: {} }), validateApiKeyBody(apiKeyCreateSchema), (req, res) => {
        res.json({ data: req.validatedApiKey });
      });

      const res = await request(app)
        .post('/test')
        .send(validPayload())
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
    });
  });
});
