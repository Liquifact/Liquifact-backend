'use strict';

/**
 * @fileoverview API Key authentication middleware for service-to-service calls.
 * Validates X-API-KEY header against hashed keys in database.
 * Updates audit log on successful authentication.
 */

const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const AppError = require('../errors/AppError');
const logger = require('../logger');

// Database path - use environment variable or default
const DB_PATH = process.env.API_KEYS_DB_PATH || path.join(__dirname, '../../data/api_keys.db');

/**
 * Hash API key using SHA-256 for storage/comparison.
 * @param {string} apiKey - Plain API key.
 * @returns {string} Hex hash.
 */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Initialize database connection and run migrations if needed.
 * @returns {sqlite3.Database} DB instance.
 */
function initDb() {
  const db = new sqlite3.Database(DB_PATH);
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
  `);
  return db;
}

/**
 * Validate API key against database.
 * @param {string} apiKey - Plain API key from header.
 * @returns {Promise<object|null>} Key data or null if invalid.
 */
function validateApiKey(apiKey) {
  return new Promise((resolve, reject) => {
    const db = initDb();
    const keyHash = hashApiKey(apiKey);
    db.get('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1', [keyHash], (err, row) => {
      db.close();
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/**
 * Update last used and audit log for a key.
 * @param {number} keyId - Key ID.
 * @param {string} action - Action performed.
 */
function updateAudit(keyId, action) {
  const db = initDb();
  const now = new Date().toISOString();
  const auditEntry = JSON.stringify({ timestamp: now, action });
  db.run(
    'UPDATE api_keys SET last_used_at = ?, audit_log = COALESCE(audit_log || ?, ?) WHERE id = ?',
    [now, ',' + auditEntry, auditEntry, keyId]
  );
  db.close();
}

/**
 * Middleware to authenticate API key for service-to-service calls.
 * Checks X-API-KEY header, validates against DB, sets req.apiKey on success.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Next middleware.
 */
async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    const err = new Error('Missing X-API-KEY header');
    err.status = 401;
    return next(err);
  }

  try {
    const keyData = await validateApiKey(apiKey);
    if (!keyData) {
      logger.warn({ apiKeyHash: hashApiKey(apiKey) }, 'Invalid API key attempt');
      const err = new Error('Invalid API key');
      err.status = 401;
      return next(err);
    }

    req.apiKey = { id: keyData.id, name: keyData.name };
    updateAudit(keyData.id, `${req.method} ${req.path}`);
    next();
  } catch (err) {
    logger.error(err, 'API key validation error');
    const e = new Error('Authentication error');
    e.status = 500;
    next(e);
  }
}

module.exports = { apiKeyAuth, hashApiKey, initDb };