'use strict';

/**
 * Tests for API key authentication middleware.
 */

const path = require('path');

// Set DB path before requiring the middleware so it uses the test DB.
const testDbPath = path.join(__dirname, 'test_api_keys.db');
process.env.API_KEYS_DB_PATH = testDbPath;

const { apiKeyAuth, hashApiKey, initDb } = require('../src/middleware/apiKey');
const sqlite3 = require('sqlite3').verbose();

describe('API Key Middleware', () => {
  beforeAll(async () => {
    // Create test DB and insert a test key
    const db = new sqlite3.Database(testDbPath);
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
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const testKey = 'test-api-key-123';
    const hashed = hashApiKey(testKey);
    await new Promise((resolve, reject) => {
      db.run('INSERT INTO api_keys (key_hash, name) VALUES (?, ?)', [hashed, 'test-service'], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    db.close();
  });

  afterAll(() => {
    // Clean up test DB
    require('fs').unlinkSync(testDbPath);
  });

  test('hashApiKey produces consistent hash', () => {
    const key = 'my-api-key';
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  test('apiKeyAuth accepts valid key', async () => {
    const req = {
      headers: { 'x-api-key': 'test-api-key-123' },
    };
    const res = {};
    const next = jest.fn();

    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toEqual({ id: 1, name: 'test-service' });
  });

  test('apiKeyAuth rejects missing key', async () => {
    const req = { headers: {} };
    const res = {};
    const next = jest.fn();

    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('Missing X-API-KEY header');
  });

  test('apiKeyAuth rejects invalid key', async () => {
    const req = { headers: { 'x-api-key': 'invalid-key' } };
    const res = {};
    const next = jest.fn();

    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('Invalid API key');
  });
});