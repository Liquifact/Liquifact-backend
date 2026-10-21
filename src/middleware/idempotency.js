'use strict';

const crypto = require('crypto');

const MAX_ENTRIES = parseInt(process.env.IDEMPOTENCY_MAX_ENTRIES, 10) || 10000;
const TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS, 10) || 86400; // 24 hours
const REQUIRED = process.env.IDEMPOTENCY_REQUIRED === 'true';

/**
 * Simple LRU cache implementation for idempotency store.
 */
class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value, ttl) {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

const idempotencyStore = new LRUCache(MAX_ENTRIES);

/**
 * Computes SHA256 hash of canonical JSON (sorted keys).
 *
 * @param {object} body request body
 * @returns {string} hex hash
 */
function fingerprint(body) {
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Validates idempotency key format.
 *
 * @param {string} key the idempotency key
 * @returns {boolean} valid
 */
function isValidKey(key) {
  if (typeof key !== 'string') {
    return false;
  }
  if (key.length < 8 || key.length > 128) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/**
 * Scopes the idempotency key by method + route + principal/IP.
 *
 * @param {import('express').Request} req
 * @param {string} key the idempotency key
 * @returns {string} scoped key
 */
function scopeKey(req, key) {
  const principal = req.user?.id || req.ip;
  return `${req.method}:${req.path}:${principal}:${key}`;
}

/**
 * Idempotency middleware for POST routes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function idempotency(req, res, next) {
  const idempotencyKey = req.get('Idempotency-Key');

  // Check if key is required
  if (REQUIRED && !idempotencyKey) {
    return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
  }

  // If no key provided and not required, proceed normally
  if (!idempotencyKey) {
    return next();
  }

  // Validate key format
  if (!isValidKey(idempotencyKey)) {
    return res.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY' });
  }

  const scopedKey = scopeKey(req, idempotencyKey);
  const fp = fingerprint(req.body);
  const existing = idempotencyStore.get(scopedKey);

  // Check for in-flight request
  if (existing && existing.state === 'in_flight') {
    res.set('Retry-After', '1');
    return res.status(409).json({ error: 'IDEMPOTENCY_IN_PROGRESS' });
  }

  // Check for key reuse with different payload
  if (existing && existing.fingerprint !== fp) {
    return res.status(422).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
  }

  // Replay cached response
  if (existing && existing.state === 'done') {
    res.set('Idempotent-Replayed', 'true');
    res.set('Idempotency-Key', idempotencyKey);
    return res.status(existing.status).json(existing.body);
  }

  // Mark as in-flight and wrap res.json to capture response
  idempotencyStore.set(scopedKey, {
    fingerprint: fp,
    state: 'in_flight',
  }, TTL_SECONDS);

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const status = res.statusCode;

    // Only cache 2xx and 4xx (except 409, 429), never 5xx
    const shouldCache = (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 409 && status !== 429);

    if (shouldCache) {
      idempotencyStore.set(scopedKey, {
        fingerprint: fp,
        status,
        body,
        state: 'done',
        createdAt: new Date().toISOString(),
      }, TTL_SECONDS);
    } else {
      // Remove in-flight entry if not caching
      idempotencyStore.set(scopedKey, {
        fingerprint: fp,
        state: 'done',
        body: null,
        status: null,
      }, 0); // Expire immediately
    }

    res.set('Idempotency-Key', idempotencyKey);
    return originalJson(body);
  };

  next();
}

/**
 * Clears the idempotency store (for tests).
 */
function resetStore() {
  idempotencyStore.clear();
}

module.exports = idempotency;
module.exports.resetStore = resetStore;
