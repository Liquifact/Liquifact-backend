'use strict';

const express = require('express');
const request = require('supertest');
const { createAccessLogMiddleware } = require('../src/middleware/access-log');

describe('structured access logging middleware', () => {
  let mockLogger;
  let loggedEntries;

  beforeEach(() => {
    loggedEntries = [];
    mockLogger = {
      info: jest.fn((msg, meta) => {
        loggedEntries.push({ msg, meta });
      }),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  function buildTestApp(middlewareOptions = {}) {
    const app = express();
    app.use(createAccessLogMiddleware({ logger: mockLogger, enabled: true, ...middlewareOptions }));

    app.get('/api/test/:id', (req, res) => {
      res.status(200).json({ ok: true, id: req.params.id });
    });

    app.post('/api/action', (req, res) => {
      res.status(201).json({ created: true });
    });

    app.get('/api/error', (req, res) => {
      res.status(500).json({ error: 'fail' });
    });

    return app;
  }

  test('logs one structured entry on response finish with method, route pattern, status and durationMs', async () => {
    const app = buildTestApp();

    const res = await request(app)
      .get('/api/test/123?secret=dontlogme')
      .set('Authorization', 'Bearer sensitive-token')
      .set('X-Api-Key', 'secret-api-key')
      .set('X-Request-Id', 'req-abc-123');

    expect(res.status).toBe(200);
    expect(loggedEntries).toHaveLength(1);

    const { msg, meta } = loggedEntries[0];
    expect(msg).toBe('HTTP request completed');
    expect(meta.method).toBe('GET');
    // Route pattern used, not raw parameter value
    expect(meta.route).toBe('/api/test/:id');
    expect(meta.status).toBe(200);
    expect(typeof meta.durationMs).toBe('number');
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(meta.requestId).toBe('req-abc-123');

    // Verify sensitive data (query, headers, body) never appear in the logged metadata
    const metaString = JSON.stringify(meta);
    expect(metaString).not.toContain('secret=dontlogme');
    expect(metaString).not.toContain('sensitive-token');
    expect(metaString).not.toContain('secret-api-key');
  });

  test('logs unmatched routes with fixed label "unmatched"', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/unknown-path/foo/bar?query=1');
    expect(res.status).toBe(404);

    expect(loggedEntries).toHaveLength(1);
    const { meta } = loggedEntries[0];
    expect(meta.method).toBe('GET');
    expect(meta.route).toBe('unmatched');
    expect(meta.status).toBe(404);
  });

  test('disabled by default in test environment when not explicitly enabled', async () => {
    const app = express();
    // Default options (enabled not passed, NODE_ENV is test)
    app.use(createAccessLogMiddleware({ logger: mockLogger }));
    app.get('/api/silent', (req, res) => res.json({ ok: true }));

    await request(app).get('/api/silent');
    expect(loggedEntries).toHaveLength(0);
  });

  test('enabled when ACCESS_LOG=true environment variable is set', async () => {
    const prevAccessLog = process.env.ACCESS_LOG;
    process.env.ACCESS_LOG = 'true';

    try {
      const app = express();
      app.use(createAccessLogMiddleware({ logger: mockLogger }));
      app.get('/api/env-enabled', (req, res) => res.json({ ok: true }));

      await request(app).get('/api/env-enabled');
      expect(loggedEntries).toHaveLength(1);
      expect(loggedEntries[0].meta.route).toBe('/api/env-enabled');
    } finally {
      process.env.ACCESS_LOG = prevAccessLog;
    }
  });

  test('captures error status codes correctly', async () => {
    const app = buildTestApp();
    await request(app).get('/api/error');

    expect(loggedEntries).toHaveLength(1);
    expect(loggedEntries[0].meta.status).toBe(500);
  });
});
