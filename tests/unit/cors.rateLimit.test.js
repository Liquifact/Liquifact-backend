'use strict';

/**
 * @fileoverview Unit tests for the CORS request rate limiter.
 *
 * Coverage:
 *  • `corsLimiter` module export and env-var parsing.
 *  • 429 body shape and `Retry-After` header on over-limit.
 *  • Browser requests with an Origin header are rate limited.
 *  • Non-browser requests without Origin bypass the CORS limiter.
 *  • API keys get separate buckets from IP-only clients.
 *  • Window reset restores the bucket after the configured period.
 */

process.env.NODE_ENV = 'test';
process.env.CORS_RATE_LIMIT_WINDOW_MS = '60000';
process.env.CORS_RATE_LIMIT_MAX = '2';

jest.unmock('../../src/middleware/rateLimit');

const express = require('express');
const request = require('supertest');
const cors = require('cors');
const rateLimitModule = require('../../src/middleware/rateLimit');
const { createCorsOptions } = require('../../src/config/cors');

function buildApp() {
  const app = express();
  app.use(rateLimitModule.createCorsRateLimiter());
  app.use(cors(createCorsOptions({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example.com' })));
  app.get('/hello', (req, res) => {
    res.json({ message: 'ok' });
  });
  app.options('/hello', cors(createCorsOptions({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example.com' })));
  return app;
}

let app;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  app = buildApp();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('corsLimiter', () => {
  it('allows requests with an allowed origin until the limit is reached', async () => {
    const first = await request(app).get('/hello').set('Origin', 'https://app.example.com');
    const second = await request(app).get('/hello').set('Origin', 'https://app.example.com');
    const third = await request(app).get('/hello').set('Origin', 'https://app.example.com');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toMatch(/^\d+$/);
    expect(third.body).toMatchObject({
      code: 'RATE_LIMITED',
      scope: 'cors',
      retryable: true,
      title: 'Too Many Requests',
    });
  });

  it('skips rate limiting for requests without an Origin header', async () => {
    const r1 = await request(app).get('/hello');
    const r2 = await request(app).get('/hello');
    const r3 = await request(app).get('/hello');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it('separates buckets by X-API-Key when present', async () => {
    const r1 = await request(app).get('/hello').set('Origin', 'https://app.example.com').set('x-api-key', 'key-a');
    const r2 = await request(app).get('/hello').set('Origin', 'https://app.example.com').set('x-api-key', 'key-a');
    const r3 = await request(app).get('/hello').set('Origin', 'https://app.example.com').set('x-api-key', 'key-a');
    const other = await request(app).get('/hello').set('Origin', 'https://app.example.com').set('x-api-key', 'key-b');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(other.status).toBe(200);
  });

  it('resets the bucket after the configured window elapses', async () => {
    const r1 = await request(app).get('/hello').set('Origin', 'https://app.example.com');
    const r2 = await request(app).get('/hello').set('Origin', 'https://app.example.com');
    const blocked = await request(app).get('/hello').set('Origin', 'https://app.example.com');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(blocked.status).toBe(429);

    jest.advanceTimersByTime(60_001);

    const recovered = await request(app).get('/hello').set('Origin', 'https://app.example.com');
    expect(recovered.status).toBe(200);
  });

  it('applies to CORS preflight requests as well as actual browser requests', async () => {
    const preflight1 = await request(app)
      .options('/hello')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');
    const preflight2 = await request(app)
      .options('/hello')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');
    const preflight3 = await request(app)
      .options('/hello')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');

    expect(preflight1.status).toBe(204);
    expect(preflight2.status).toBe(204);
    expect(preflight3.status).toBe(429);
  });
});
