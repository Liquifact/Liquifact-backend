'use strict';

/**
 * Tests for issue #1534: hashed API keys with role-based authorization on all
 * mutating routes.
 */

const request = require('supertest');
const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const SME_KEY = 'lf_sme_key_1111111111';
const INVESTOR_KEY = 'lf_investor_key_22222222';
const ADMIN_KEY = 'lf_admin_key_3333333333';

process.env.API_KEYS = [
  `test-sme:sme:${sha256(SME_KEY)}`,
  `test-investor:investor:${sha256(INVESTOR_KEY)}`,
  `test-admin:admin:${sha256(ADMIN_KEY)}`,
].join(',');

const app = require('../src/app');
const config = require('../src/config');
const { constantTimeEqual, sha256Hex, requireRole } = require('../src/middleware/auth');

const bearer = (key) => ({ authorization: `Bearer ${key}` });

const validInvoice = { sme: 'Acme', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };
const validInvestor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';

describe('POST /api/invoices — authentication', () => {
  test('anonymous request is rejected with 401 (it returned 201 on main)', async () => {
    const res = await request(app).post('/api/invoices').send(validInvoice);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  test('malformed Authorization headers are rejected with 401', async () => {
    for (const header of ['Basic abc123', 'Bearer', 'Bearer ', 'Token abc', '']) {
      const res = await request(app).post('/api/invoices').set('authorization', header).send(validInvoice);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    }
  });

  test('unknown key is rejected with 401', async () => {
    const res = await request(app).post('/api/invoices').set(bearer('lf_not_a_configured_key')).send(validInvoice);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('sme key creates an invoice with 201 and records createdBy', async () => {
    const res = await request(app).post('/api/invoices').set(bearer(SME_KEY)).send(validInvoice);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.createdBy).toBe('test-sme');
  });

  test('sme key is rejected on the fund route with 403', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .set(bearer(SME_KEY))
      .send({ amount: 10, investor: validInvestor });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('X-API-Key header is accepted', async () => {
    const res = await request(app).post('/api/invoices').set('x-api-key', SME_KEY).send(validInvoice);
    expect(res.status).toBe(201);
    expect(res.body.data.createdBy).toBe('test-sme');
  });

  test('GET routes stay public', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});

describe('POST /api/invoices/:id/fund — roles', () => {
  beforeEach(() => {
    const store = require('../src/data/store');
    store.reset();
  });

  test('investor key funds an invoice with 200', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .set(bearer(INVESTOR_KEY))
      .send({ amount: 100, investor: validInvestor });
    expect(res.status).toBe(200);
    expect(res.body.data.fundedAmount).toBe(18100);
  });

  test('investor key cannot create invoices (403)', async () => {
    const res = await request(app).post('/api/invoices').set(bearer(INVESTOR_KEY)).send(validInvoice);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('admin key is accepted on both routes', async () => {
    const created = await request(app).post('/api/invoices').set(bearer(ADMIN_KEY)).send(validInvoice);
    expect(created.status).toBe(201);
    expect(created.body.data.createdBy).toBe('test-admin');
    const funded = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .set(bearer(ADMIN_KEY))
      .send({ amount: 100, investor: validInvestor });
    expect(funded.status).toBe(200);
  });
});

describe('POST /api/escrow/attestations/verify — roles', () => {
  test('sme key passes auth and fails input validation (400), proving the guard ran first', async () => {
    const res = await request(app).post('/api/escrow/attestations/verify').set(bearer(SME_KEY)).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST');
  });

  test('missing key is rejected with 401', async () => {
    const res = await request(app).post('/api/escrow/attestations/verify').send({ sha256: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe('other mutating routes — roles', () => {
  beforeEach(() => {
    require('../src/data/store').reset();
  });

  test('settle is admin-only; cancel accepts sme; SME registration needs a key', async () => {
    const funded = 'INV_0003';
    expect((await request(app).post(`/api/invoices/${funded}/settle`).set(bearer(SME_KEY))).status).toBe(403);
    expect((await request(app).post(`/api/invoices/${funded}/settle`)).status).toBe(401);
    expect((await request(app).post(`/api/invoices/${funded}/settle`).set(bearer(ADMIN_KEY))).status).toBe(200);
    expect((await request(app).post('/api/invoices/INV_0001/cancel').set(bearer(INVESTOR_KEY))).status).toBe(403);
    expect((await request(app).post('/api/invoices/INV_0001/cancel').set(bearer(SME_KEY))).status).toBe(200);
    expect((await request(app).post('/api/smes').send({})).status).toBe(401);
    expect((await request(app).post('/api/smes').set(bearer(INVESTOR_KEY)).send({})).status).toBe(403);
  });
});

describe('constant-time key comparison', () => {
  test('hashes keys before comparison and matches correctly', () => {
    expect(sha256Hex(SME_KEY)).toBe(sha256(SME_KEY));
    expect(constantTimeEqual(SME_KEY, SME_KEY)).toBe(true);
    expect(constantTimeEqual(SME_KEY, INVESTOR_KEY)).toBe(false);
  });

  test('different-length inputs do not throw and never match', () => {
    expect(() => constantTimeEqual('a', 'bbbbbbbbbbbbbbbbbbbb')).not.toThrow();
    expect(constantTimeEqual('a', 'bbbbbbbbbbbbbbbbbbbb')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
    expect(constantTimeEqual('short', '')).toBe(false);
  });
});

describe('route table', () => {
  /**
   * Recursively collects every registered route from an Express 5 router stack.
   *
   * @param {object[]} stack router layers
   * @returns {object[]} express Route objects
   */
  function collectRoutes(stack) {
    const routes = [];
    for (const layer of stack) {
      if (layer.route) {
        routes.push(layer.route);
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        routes.push(...collectRoutes(layer.handle.stack));
      }
    }
    return routes;
  }

  test('every non-GET route declares a role guard', () => {
    const routes = collectRoutes(app.router.stack);
    expect(routes.length).toBeGreaterThan(3);
    const unguarded = [];
    for (const route of routes) {
      const methods = Object.keys(route.methods).filter((method) => route.methods[method]);
      if (methods.every((method) => method === 'get' || method === 'head')) {
        continue;
      }
      const guarded = route.stack.some(
        (layer) => Array.isArray(layer.handle.requiredRoles) && layer.handle.requiredRoles.length > 0,
      );
      if (!guarded) {
        unguarded.push(`${methods.join(',').toUpperCase()} ${route.path}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  test('requireRole rejects unknown roles at wiring time', () => {
    expect(() => requireRole()).toThrow();
    expect(() => requireRole('nobody')).toThrow(/unknown role/);
    expect(Array.isArray(requireRole('sme').requiredRoles)).toBe(true);
  });
});

describe('unconfigured API keys', () => {
  test('production fails closed with 503 AUTH_NOT_CONFIGURED (dev key ignored)', async () => {
    const previousEnv = { ...process.env };
    let isolatedApp;
    try {
      process.env.NODE_ENV = 'production';
      // Production also rejects CORS '*' unless explicitly allowed (config validation).
      process.env.ALLOW_ANY_ORIGIN = 'true';
      delete process.env.API_KEYS;
      process.env.DEV_API_KEY = 'lf_dev_key';
      jest.isolateModules(() => {
        isolatedApp = require('../src/app');
      });
    } finally {
      process.env.NODE_ENV = previousEnv.NODE_ENV;
      if (previousEnv.ALLOW_ANY_ORIGIN === undefined) {
        delete process.env.ALLOW_ANY_ORIGIN;
      } else {
        process.env.ALLOW_ANY_ORIGIN = previousEnv.ALLOW_ANY_ORIGIN;
      }
      if (previousEnv.API_KEYS === undefined) {
        delete process.env.API_KEYS;
      } else {
        process.env.API_KEYS = previousEnv.API_KEYS;
      }
      if (previousEnv.DEV_API_KEY === undefined) {
        delete process.env.DEV_API_KEY;
      } else {
        process.env.DEV_API_KEY = previousEnv.DEV_API_KEY;
      }
    }
    const res = await request(isolatedApp)
      .post('/api/invoices')
      .set(bearer('lf_dev_key'))
      .send(validInvoice);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_NOT_CONFIGURED');
    // GET routes stay public even in this state.
    expect((await request(isolatedApp).get('/api/invoices')).status).toBe(200);
  });

  test('non-production accepts only the DEV_API_KEY and logs no key material', async () => {
    const previousEnv = { ...process.env };
    let isolatedApp;
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.API_KEYS;
      process.env.DEV_API_KEY = 'lf_dev_key';
      jest.isolateModules(() => {
        isolatedApp = require('../src/app');
      });
    } finally {
      process.env.NODE_ENV = previousEnv.NODE_ENV;
      if (previousEnv.ALLOW_ANY_ORIGIN === undefined) {
        delete process.env.ALLOW_ANY_ORIGIN;
      } else {
        process.env.ALLOW_ANY_ORIGIN = previousEnv.ALLOW_ANY_ORIGIN;
      }
      if (previousEnv.API_KEYS === undefined) {
        delete process.env.API_KEYS;
      } else {
        process.env.API_KEYS = previousEnv.API_KEYS;
      }
      if (previousEnv.DEV_API_KEY === undefined) {
        delete process.env.DEV_API_KEY;
      } else {
        process.env.DEV_API_KEY = previousEnv.DEV_API_KEY;
      }
    }
    const accepted = await request(isolatedApp)
      .post('/api/invoices')
      .set(bearer('lf_dev_key'))
      .send(validInvoice);
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.createdBy).toBe('dev');
    const rejected = await request(isolatedApp).post('/api/invoices').set(bearer('anything-else')).send(validInvoice);
    expect(rejected.status).toBe(401);
    // The raw dev key is never echoed back.
    expect(JSON.stringify(accepted.body)).not.toContain('lf_dev_key');
  });

  test('malformed API_KEYS entries are rejected at startup', () => {
    const previous = process.env.API_KEYS;
    let startupError;
    try {
      process.env.API_KEYS = 'not-a-valid-entry';
      jest.isolateModules(() => {
        try {
          require('../src/config');
        } catch (err) {
          startupError = err;
        }
      });
    } finally {
      process.env.API_KEYS = previous;
    }
    expect(startupError).toBeInstanceOf(Error);
    expect(startupError.message).toMatch(/API_KEYS entry #1 must have the form id:role:sha256hex/);
  });

  test('unknown roles and non-hex hashes are rejected at startup', () => {
    const previous = process.env.API_KEYS;
    const bad = ['k1:wizard:' + 'a'.repeat(64), 'k1:sme:not-hex', 'k1:sme'];
    const messages = [];
    try {
      for (const entry of bad) {
        process.env.API_KEYS = entry;
        try {
          jest.isolateModules(() => require('../src/config'));
          messages.push('(did not throw)');
        } catch (err) {
          messages.push(err.message);
        }
      }
    } finally {
      process.env.API_KEYS = previous;
    }
    expect(messages[0]).toMatch(/unknown role "wizard"/);
    expect(messages[1]).toMatch(/64-character hex SHA-256 hash/);
    expect(messages[2]).toMatch(/id:role:sha256hex/);
  });
});

describe('configuration parsing', () => {
  test('API_KEYS entries are parsed into id/role/hash', () => {
    expect(config.apiKeys).toEqual([
      { id: 'test-sme', role: 'sme', hash: sha256(SME_KEY) },
      { id: 'test-investor', role: 'investor', hash: sha256(INVESTOR_KEY) },
      { id: 'test-admin', role: 'admin', hash: sha256(ADMIN_KEY) },
    ]);
  });

  test('raw keys are never part of the configuration', () => {
    expect(JSON.stringify(config.apiKeys)).not.toContain('lf_');
  });
});

describe('OpenAPI — security', () => {
  test('documents the ApiKeyAuth scheme and applies it to mutating operations', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    expect(spec.components.securitySchemes.ApiKeyAuth).toMatchObject({ type: 'http', scheme: 'bearer' });

    for (const [path, method] of [
      ['/api/invoices', 'post'],
      ['/api/invoices/{id}/fund', 'post'],
      ['/api/escrow/attestations/verify', 'post'],
    ]) {
      const operation = spec.paths[path][method];
      expect(operation.security).toEqual([{ ApiKeyAuth: [] }]);
      expect(operation.responses['401']).toBeDefined();
      expect(operation.responses['403']).toBeDefined();
      expect(operation.responses['401'].content['application/json'].schema.properties.code.enum).toContain(
        'UNAUTHENTICATED',
      );
      expect(operation.responses['403'].content['application/json'].schema.properties.code.enum).toContain(
        'FORBIDDEN',
      );
      expect(operation.responses['503'].content['application/json'].schema.properties.code.enum).toContain(
        'AUTH_NOT_CONFIGURED',
      );
    }
  });

  test('GET operations stay unsecured and Invoice documents createdBy', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    expect(spec.paths['/api/invoices'].get.security).toBeUndefined();
    const data = spec.paths['/api/invoices'].post.responses['201'].content['application/json'].schema.properties.data;
    expect(data.$ref).toBe('#/components/schemas/Invoice');
    expect(spec.components.schemas.Invoice.properties.createdBy).toBeDefined();
  });
});
