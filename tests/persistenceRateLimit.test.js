'use strict';

const express = require('express');
const request = require('supertest');
const { createPersistenceRateLimiter } = require('../src/middleware/persistenceRateLimit');

describe('Persistence Rate Limiter Middleware', () => {
  let app;
  let limiter;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Create a limiter with tight limits for testing
    process.env.PERSISTENCE_RATE_LIMIT_WINDOW_MS = '1000'; // 1 second
    process.env.PERSISTENCE_RATE_LIMIT_MAX_REQUESTS = '3'; // 3 requests max

    limiter = createPersistenceRateLimiter();

    app.post('/test', limiter, (req, res) => {
      res.json({ success: true });
    });
  });

  afterEach(() => {
    delete process.env.PERSISTENCE_RATE_LIMIT_WINDOW_MS;
    delete process.env.PERSISTENCE_RATE_LIMIT_MAX_REQUESTS;
  });

  it('should allow requests within the limit', async () => {
    const res1 = await request(app).post('/test');
    expect(res1.status).toBe(200);

    const res2 = await request(app).post('/test');
    expect(res2.status).toBe(200);

    const res3 = await request(app).post('/test');
    expect(res3.status).toBe(200);
  });

  it('should reject requests exceeding the limit with 429', async () => {
    // Make max requests
    await request(app).post('/test');
    await request(app).post('/test');
    await request(app).post('/test');

    // Next request should be rate limited
    const res = await request(app).post('/test');
    expect(res.status).toBe(429);
  });

  it('should include Retry-After header on rate limit exceeded', async () => {
    await request(app).post('/test');
    await request(app).post('/test');
    await request(app).post('/test');

    const res = await request(app).post('/test');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('should return proper error response on rate limit', async () => {
    await request(app).post('/test');
    await request(app).post('/test');
    await request(app).post('/test');

    const res = await request(app).post('/test');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too Many Requests');
    expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.body.retryAfter).toBeDefined();
  });

  it('should use API key for rate limit key when available', async () => {
    // Override the limiter with a custom app that includes API key
    const app2 = express();
    app2.use(express.json());

    app2.post('/test', (req, res, next) => {
      // Simulate API key middleware
      req.apiKey = 'test-api-key-123';
      next();
    }, limiter, (req, res) => {
      res.json({ success: true });
    });

    // Make requests with same API key
    const res1 = await request(app2).post('/test');
    expect(res1.status).toBe(200);

    const res2 = await request(app2).post('/test');
    expect(res2.status).toBe(200);

    const res3 = await request(app2).post('/test');
    expect(res3.status).toBe(200);

    // Should be rate limited now
    const res4 = await request(app2).post('/test');
    expect(res4.status).toBe(429);
  });

  it('should use IP address for rate limit key when API key is not available', async () => {
    // Make requests with same IP
    const res1 = await request(app).post('/test').set('X-Forwarded-For', '192.168.1.1');
    expect(res1.status).toBe(200);

    const res2 = await request(app).post('/test').set('X-Forwarded-For', '192.168.1.1');
    expect(res2.status).toBe(200);

    const res3 = await request(app).post('/test').set('X-Forwarded-For', '192.168.1.1');
    expect(res3.status).toBe(200);

    // Should be rate limited now
    const res4 = await request(app).post('/test').set('X-Forwarded-For', '192.168.1.1');
    expect(res4.status).toBe(429);
  });

  it('should use default configuration when env vars are not set', () => {
    delete process.env.PERSISTENCE_RATE_LIMIT_WINDOW_MS;
    delete process.env.PERSISTENCE_RATE_LIMIT_MAX_REQUESTS;

    const limiter2 = createPersistenceRateLimiter();
    expect(limiter2).toBeDefined();

    // Default should be 60000ms window and 10 requests
    // (Can't easily verify without triggering actual limits)
  });

  it('should reset after the configured window expires', (done) => {
    process.env.PERSISTENCE_RATE_LIMIT_WINDOW_MS = '500'; // 500ms window for faster testing
    const fastLimiter = createPersistenceRateLimiter();

    const app2 = express();
    app2.use(express.json());
    app2.post('/test', fastLimiter, (req, res) => {
      res.json({ success: true });
    });

    // Make max requests
    request(app2).post('/test').end(() => {
      request(app2).post('/test').end(() => {
        request(app2).post('/test').end(() => {
          // Should be rate limited
          request(app2).post('/test').end((err, res) => {
            expect(res.status).toBe(429);

            // Wait for window to expire
            setTimeout(() => {
              // After window expires, request should succeed again
              request(app2).post('/test').end((err, res2) => {
                expect(res2.status).toBe(200);
                done();
              });
            }, 600);
          });
        });
      });
    });
  });
});
