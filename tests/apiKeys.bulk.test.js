'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const testDbPath = path.join(__dirname, 'test_api_keys_bulk.db');
process.env.API_KEYS_DB_PATH = testDbPath;

const { router } = require('../src/routes/apiKeys');
const { hashApiKey, initDb } = require('../src/middleware/apiKey');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/api-keys', router);
  app.use((err, req, res, next) => {
    if (err.type) {
      res.status(err.status || 500).json({ error: { message: err.detail || err.message } });
      return;
    }
    next(err);
  });
  return app;
}

describe('API key bulk operations', () => {
  beforeEach(async () => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    const db = initDb();
    await new Promise((resolve, reject) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_hash TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME,
          is_active BOOLEAN DEFAULT 1,
          audit_log TEXT
        )
      `, (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO api_keys (key_hash, name, is_active) VALUES (?, ?, ?)',
        [hashApiKey('existing-key'), 'existing-service', 1],
        (err) => (err ? reject(err) : resolve())
      );
    });

    await new Promise((resolve) => db.close(() => resolve()));
  });

  afterAll(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('rejects empty batch', async () => {
    const app = createTestApp();
    const response = await request(app).post('/api/api-keys/bulk').send([]);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Batch must contain at least one api-key operation');
  });

  test('rejects over-cap batch', async () => {
    const app = createTestApp();
    const payload = Array.from({ length: 26 }, (_, index) => ({
      action: 'create',
      name: `service-${index}`,
      apiKey: `key-${index}-12345`,
    }));

    const response = await request(app).post('/api/api-keys/bulk').send(payload);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Batch size exceeds maximum of 25');
  });

  test('returns per-item success and failure without failing the batch', async () => {
    const app = createTestApp();
    const response = await request(app)
      .post('/api/api-keys/bulk')
      .send([
        {
          action: 'create',
          name: 'new-service',
          apiKey: 'new-secret-key-12345',
        },
        {
          action: 'rename',
          id: 999,
          name: 'missing-service',
        },
        {
          action: 'deactivate',
          id: 1,
        },
      ]);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
    });
    expect(response.body.data).toHaveLength(3);
    expect(response.body.data[0]).toMatchObject({
      index: 0,
      success: true,
      action: 'create',
    });
    expect(response.body.data[1]).toMatchObject({
      index: 1,
      success: false,
    });
    expect(response.body.data[1].error).toMatch(/API Key Not Found|API key 999 was not found/);
    expect(response.body.data[2]).toMatchObject({
      index: 2,
      success: true,
      action: 'deactivate',
      result: {
        id: 1,
        name: 'existing-service',
        isActive: false,
      },
    });
  });

  test('validates individual items', async () => {
    const app = createTestApp();
    const response = await request(app)
      .post('/api/api-keys/bulk')
      .send([
        {
          action: 'create',
          name: '',
          apiKey: 'bad',
        },
      ]);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      total: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(response.body.data[0].success).toBe(false);
    expect(response.body.data[0].error).toMatch(/Too small|String must contain at least 1 character/);
  });
});
