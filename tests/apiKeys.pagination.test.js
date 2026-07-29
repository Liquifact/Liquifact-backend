'use strict';

const request = require('supertest');
const express = require('express');
const apiKeysRouter = require('../src/routes/apiKeys');

const app = express();
app.use(express.json());
// Mock standard envelope formatting normally provided by app.js
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (payload) {
    if (res.statusCode < 400) {
      if (!payload.data) return originalJson(payload);
      return originalJson(payload);
    }
    return originalJson(payload);
  };
  next();
});
app.use('/api', apiKeysRouter);

describe('API Keys Cursor Pagination', () => {
  beforeEach(() => {
    // Generate a set of test API keys
    apiKeysRouter.resetRuntimeEntries();
    process.env.API_KEYS = Array.from({ length: 45 }, (_, i) => {
      const idx = i.toString().padStart(3, '0');
      return JSON.stringify({ key: `key_${idx}`, clientId: `client_${idx}`, scopes: [] });
    }).join(';');
  });

  afterEach(() => {
    delete process.env.API_KEYS;
    apiKeysRouter.resetRuntimeEntries();
  });

  it('paginates with default bounded page size', async () => {
    const res = await request(app).get('/api/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(20);
    expect(res.body.meta.limit).toBe(20);
    expect(res.body.meta.hasMore).toBe(true);
    expect(res.body.meta.nextCursor).toBeTruthy();
  });

  it('over-limit clamp correctly clamps limit to max 100', async () => {
    const res = await request(app).get('/api/api-keys?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(100);
    expect(res.body.data.length).toBe(45);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it('handles next-cursor to get subsequent pages', async () => {
    const res1 = await request(app).get('/api/api-keys?limit=15');
    const cursor = res1.body.meta.nextCursor;
    
    const res2 = await request(app).get(`/api/api-keys?limit=15&cursor=${cursor}`);
    expect(res2.status).toBe(200);
    expect(res2.body.data.length).toBe(15);
    expect(res2.body.data[0].key).toBe('key_015');
    expect(res2.body.meta.hasMore).toBe(true);
  });

  it('returns 400 for invalid cursor', async () => {
    const res = await request(app).get('/api/api-keys?cursor=invalid_base64_or_tampered');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  it('handles exact-page boundary correctly', async () => {
    // 45 items total. 3 pages of 15.
    const res1 = await request(app).get('/api/api-keys?limit=45');
    expect(res1.body.data.length).toBe(45);
    expect(res1.body.meta.hasMore).toBe(false);
    expect(res1.body.meta.nextCursor).toBeNull();
  });

  it('handles empty set correctly', async () => {
    delete process.env.API_KEYS;
    const res = await request(app).get('/api/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
  });
});
