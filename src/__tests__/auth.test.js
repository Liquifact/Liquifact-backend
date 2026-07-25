'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const configModule = require('../config');
const { authenticateToken } = require('../middleware/auth');

// Build a self-contained Express app so the middleware can be tested in isolation
// without spinning up the full application stack.
const app = express();
app.use(express.json());

app.post('/api/invoices', authenticateToken, (req, res) => {
  res.status(201).json({ data: { id: 'placeholder' } });
});

app.get('/api/escrow/:invoiceId', authenticateToken, (req, res) => {
  res.status(200).json({ data: { invoiceId: req.params.invoiceId } });
});

app.use((err, req, res, _next) => {
  res.status(err.status || 500).json({
    type: err.type,
    title: err.title,
    status: err.status || 500,
    detail: err.detail || err.message,
    instance: err.instance,
  });
});

// RSA key pair used for algorithm-confusion tests
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Authentication Middleware', () => {
  const secret = process.env.JWT_SECRET || 'test-secret';
  const validPayload = { id: 1, role: 'user' };
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;
  let validToken;
  let expiredToken;

  beforeAll(() => {
    validToken = jwt.sign(validPayload, secret, { expiresIn: '1h' });
    expiredToken = jwt.sign(validPayload, secret, { expiresIn: '-1h' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  // ─── Route Protection — POST /api/invoices ────────────────────────────────

  describe('Route Protection — POST /api/invoices', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).post('/api/invoices').send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Authentication token is required');
    });

    it('should return 401 when token format is invalid (missing Bearer)', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `FakeBearer ${validToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
    });

    it('should return 401 when authorization header is malformed (no space)', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer${validToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
    });

    it('should return 401 when token is invalid', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', 'Bearer some.invalid.token')
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid token');
    });

    it('should return 401 when token is expired', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Token has expired');
    });

    it('should return 401 when token is not active yet', async () => {
      const futureToken = jwt.sign(validPayload, secret, { expiresIn: '1h', notBefore: '1h' });

      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${futureToken}`)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Token not yet active');
    });

    it('should return 201 when a valid token is provided', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ amount: 1000, customer: 'Test Corp' });
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty('id');
    });
  });

  // ─── Route Protection — GET /api/escrow/:invoiceId ───────────────────────

  describe('Route Protection — GET /api/escrow/:invoiceId', () => {
    it('should allow escrow read with valid token', async () => {
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${validToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe('test-invoice');
    });

    it('should reject escrow read without token', async () => {
      const res = await request(app).get('/api/escrow/test-invoice');
      expect(res.status).toBe(401);
    });
  });

  // ─── Algorithm allowlist enforcement ─────────────────────────────────────

  describe('Algorithm allowlist enforcement', () => {
    it('should reject token signed with alg: none (crafted header)', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        id: 1, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${noneToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid token');
    });

    it('should reject token signed with a disallowed algorithm (RS256)', async () => {
      const rsToken = jwt.sign(validPayload, privateKey, { algorithm: 'RS256' });
      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${rsToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.detail).toMatch(/algorithm not allowed/i);
    });
  });

  // ─── Issuer enforcement (only when JWT_ISSUER is set) ────────────────────

  const issuer = process.env.JWT_ISSUER;

  (issuer ? describe : describe.skip)('Issuer enforcement', () => {
    it('should accept token with correct issuer', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', issuer });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('should reject token with wrong issuer', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', issuer: 'https://evil.com' });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── Audience enforcement (only when JWT_AUDIENCE is set) ────────────────

  const audience = process.env.JWT_AUDIENCE;

  (audience ? describe : describe.skip)('Audience enforcement', () => {
    it('should accept token with correct audience', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', audience });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('should reject token with wrong audience', async () => {
      const token = jwt.sign(validPayload, secret, { expiresIn: '1h', audience: 'other-api' });
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── Malformed header edge cases ─────────────────────────────────────────

  describe('Malformed header edge cases', () => {
    it('should reject token with Basic scheme', async () => {
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', 'Basic somecreds');
      expect(res.status).toBe(401);
    });

    it('should reject empty Authorization header', async () => {
      const res = await request(app)
        .get('/api/escrow/test-invoice')
        .set('Authorization', '');
      expect(res.status).toBe(401);
    });
  });

  describe('JWT config fallback safety', () => {
    it('rejects test-secret tokens outside test mode when config is unavailable', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      jest.spyOn(configModule, 'get').mockImplementation(() => {
        throw new Error('Config not validated. Call validate() first.');
      });

      const forgedToken = jwt.sign(validPayload, 'test-secret', { expiresIn: '1h' });

      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${forgedToken}`)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Authentication configuration is unavailable');
    });

    it('does not expose the secret or token when config is unavailable', async () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'test-secret';
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(configModule, 'get').mockImplementation(() => {
        throw new Error('Config not validated. Call validate() first.');
      });
      const token = jwt.sign(validPayload, 'test-secret', { expiresIn: '1h' });

      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain('test-secret');
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('allows the fallback secret only while NODE_ENV is test', async () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'test-secret';
      jest.spyOn(configModule, 'get').mockImplementation(() => {
        throw new Error('Config not validated. Call validate() first.');
      });

      const testToken = jwt.sign(validPayload, 'test-secret', { expiresIn: '1h' });

      const res = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ amount: 1000 });

      expect(res.status).toBe(201);
    });

    it('uses validated config instead of the environment fallback when available', async () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'test-secret';
      const validatedSecret = 'validated-secret-at-least-32-characters-long';
      jest.spyOn(configModule, 'get').mockReturnValue({
        JWT_SECRET: validatedSecret,
        JWT_ALGORITHMS: 'HS256',
      });

      const validConfiguredToken = jwt.sign(validPayload, validatedSecret, { expiresIn: '1h' });
      const forgedFallbackToken = jwt.sign(validPayload, 'test-secret', { expiresIn: '1h' });

      const accepted = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${validConfiguredToken}`)
        .send({ amount: 1000 });
      const rejected = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${forgedFallbackToken}`)
        .send({ amount: 1000 });

      expect(accepted.status).toBe(201);
      expect(rejected.status).toBe(401);
    });
  });
});
