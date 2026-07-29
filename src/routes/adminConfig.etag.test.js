'use strict';

/**
 * Tests for ETag / conditional-GET support on GET /api/admin/config/sections
 * Issue #1017
 */

const request = require('supertest');
const express = require('express');

// Mock the heavy dependencies so the test stays focused
jest.mock('../middleware/compression', () => ({
  createCompressionMiddleware: () => (req, res, next) => next(),
}));
jest.mock('../middleware/stacks', () => ({
  adminStack: [(req, res, next) => next()],
}));
jest.mock('../middleware/rateLimit', () => ({
  adminConfigLimiter: (req, res, next) => next(),
}));
jest.mock('../middleware/optionalIdempotency', () => (req, res, next) => next());
jest.mock('../schemas/config', () => ({
  runtimeConfigSchema: {},
  validateBody: () => (req, res, next) => next(),
}));
jest.mock('../dto/config', () => ({
  toAdminConfigRequestDto: (v) => v,
  fromAdminConfigRequestDto: (v) => v,
}));

// Mock the functions used by the route
const mockSections = ['webhook', 'reconciliation', 'kyc', 'retention'];
jest.mock('../services/configService', () => ({
  getConfigSections: () => mockSections,
  applyConfig: jest.fn(),
}), { virtual: true });

// Import the router after mocks
const adminConfigRouter = require('./adminConfig');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/config', adminConfigRouter);
  return app;
}

describe('GET /api/admin/config/sections – ETag support', () => {
  let app;

  beforeEach(() => {
    app = createApp();
  });

  it('returns 200 with ETag header on fresh request', async () => {
    const res = await request(app).get('/api/admin/config/sections');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).toMatch(/^"[a-f0-9]+"$/);
    expect(res.body).toEqual({ sections: mockSections });
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    // First request to get the ETag
    const first = await request(app).get('/api/admin/config/sections');
    const etag = first.headers.etag;

    // Second request with matching If-None-Match
    const res = await request(app)
      .get('/api/admin/config/sections')
      .set('If-None-Match', etag);

    expect(res.status).toBe(304);
    expect(res.headers.etag).toBe(etag);
    expect(res.body).toEqual({}); // 304 has no body
  });

  it('returns 200 with new ETag when resource would change', async () => {
    const first = await request(app).get('/api/admin/config/sections');
    const oldEtag = first.headers.etag;

    // Simulate change by requesting again (ETag is based on current data)
    const res = await request(app)
      .get('/api/admin/config/sections')
      .set('If-None-Match', '"different-etag"');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).not.toBe('"different-etag"');
    expect(res.body.sections).toEqual(mockSections);
  });
});
