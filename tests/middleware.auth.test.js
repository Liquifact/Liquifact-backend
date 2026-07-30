'use strict';

/**
 * Integration-style tests for JWT auth middleware (issue #447).
 * Complements src/__tests__/auth.test.js with tests/ layout expected by CI.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const configModule = require('../src/config');
const { authenticateToken } = require('../src/middleware/auth');

const app = express();
app.use(express.json());
app.get('/protected', authenticateToken, (req, res) => res.json({ ok: true, user: req.user }));
app.use((err, req, res, _next) => {
  res.status(err.status || 500).json({ detail: err.detail || err.message });
});

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('middleware/auth (tests/)', () => {
  const secret = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.NODE_ENV = 'test';
  });

  it('rejects RS256 when only HS256 is allowed', async () => {
    jest.spyOn(configModule, 'get').mockReturnValue({
      JWT_SECRET: secret,
      JWT_ALGORITHMS: 'HS256',
    });
    const token = jwt.sign({ id: 1 }, privateKey, { algorithm: 'RS256' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.detail).toMatch(/algorithm not allowed/i);
  });

  it('accepts HS256 from validated config', async () => {
    jest.spyOn(configModule, 'get').mockReturnValue({
      JWT_SECRET: secret,
      JWT_ALGORITHMS: 'HS256',
    });
    const token = jwt.sign({ id: 1 }, secret, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(1);
  });

  it('parses comma-separated JWT_ALGORITHMS allowlist', async () => {
    jest.spyOn(configModule, 'get').mockReturnValue({
      JWT_SECRET: secret,
      JWT_ALGORITHMS: 'HS256, HS384',
    });
    const token = jwt.sign({ id: 2 }, secret, { algorithm: 'HS384', expiresIn: '1h' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('falls back to env secret only in test mode when config.get throws', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = secret;
    jest.spyOn(configModule, 'get').mockImplementation(() => {
      throw new Error('Config not validated');
    });
    const token = jwt.sign({ id: 3 }, secret, { expiresIn: '1h' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
