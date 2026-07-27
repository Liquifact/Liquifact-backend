'use strict';

jest.unmock('../../src/middleware/rateLimit');

const request = require('supertest');
const express = require('express');
const { createApiKeysRateLimiter } = require('../../src/middleware/rateLimit');

describe('apiKeysLimiter middleware', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(createApiKeysRateLimiter());
    app.get('/api-keys', (req, res) => res.status(200).json({ ok: true }));
  });

  it('returns 429 and Retry-After header when rate limit is exceeded', async () => {
    for (let i = 0; i < 60; i++) {
      await request(app).get('/api-keys').expect(200);
    }
    const res = await request(app).get('/api-keys').expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});
