'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 128;
const MIN_KEY_LENGTH = 8;
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

class InvoiceIdempotencyError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = 'InvoiceIdempotencyError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

/** Canonicalize JSON-like values without relying on object insertion order. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Scope a key with tenant and route identity, then hash the canonical request.
 * The raw body never enters the store and equal JSON objects have equal hashes.
 */
function requestFingerprint({ method = 'POST', path = '/v1/invoices', tenantId, body }) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new InvoiceIdempotencyError('TENANT_REQUIRED', 'Tenant context is required.', 400);
  }
  const material = canonicalJson({
    method: method.toUpperCase(),
    path,
    tenantId,
    body: body ?? null,
  });
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

function validateKey(key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new InvoiceIdempotencyError('KEY_REQUIRED', 'Idempotency-Key header is required.', 400);
  }
  const normalized = key.trim();
  if (normalized.length < MIN_KEY_LENGTH || normalized.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(normalized)) {
    throw new InvoiceIdempotencyError(
      'KEY_INVALID',
      `Idempotency-Key must be ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} URL-safe characters.`,
      400,
    );
  }
  return normalized;
}

function scopedKey(tenantId, key) {
  return `${tenantId}\u0000${key}`;
}

/**
 * In-memory implementation of the invoice idempotency store.
 *
 * `claim` is synchronous and therefore atomic within a Node event loop turn.
 * A pending record is visible immediately before the handler is invoked,
 * closing the read-then-write race between concurrent HTTP requests.
 */
class InvoiceIdempotencyStore {
  constructor({ clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxEntries = 10000 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.records = new Map();
  }

  _removeExpired(now = this.clock()) {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }

  claim({ tenantId, key, fingerprint, now = this.clock() }) {
    this._removeExpired(now);
    const storageKey = scopedKey(tenantId, key);
    const existing = this.records.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { state: 'conflict', record: { ...existing } };
      }
      if (existing.state === 'pending') {
        return { state: 'in_progress', record: { ...existing } };
      }
      return { state: 'replay', record: { ...existing } };
    }
    if (this.records.size >= this.maxEntries) this.evictOldest();
    const record = {
      tenantId,
      key,
      fingerprint,
      state: 'pending',
      statusCode: null,
      responseBody: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.records.set(storageKey, record);
    return { state: 'claimed', record: { ...record } };
  }

  complete(tenantId, key, fingerprint, statusCode, responseBody, now = this.clock()) {
    const storageKey = scopedKey(tenantId, key);
    const current = this.records.get(storageKey);
    if (!current || current.fingerprint !== fingerprint || current.expiresAt <= now) {
      throw new InvoiceIdempotencyError('RECORD_MISSING', 'Idempotency record is no longer available.', 500);
    }
    const record = {
      ...current,
      state: 'completed',
      statusCode,
      responseBody,
      completedAt: now,
    };
    this.records.set(storageKey, record);
    return { ...record };
  }

  abandon(tenantId, key, fingerprint) {
    const storageKey = scopedKey(tenantId, key);
    const current = this.records.get(storageKey);
    if (current && current.fingerprint === fingerprint) this.records.delete(storageKey);
  }

  get(tenantId, key, now = this.clock()) {
    this._removeExpired(now);
    const record = this.records.get(scopedKey(tenantId, key));
    return record ? { ...record } : undefined;
  }

  purge(now = this.clock()) {
    const before = this.records.size;
    this._removeExpired(now);
    return before - this.records.size;
  }

  evictOldest() {
    let oldestKey;
    let oldestTime = Infinity;
    for (const [key, record] of this.records) {
      if (record.createdAt < oldestTime) {
        oldestTime = record.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.records.delete(oldestKey);
  }

  size() { return this.records.size; }
  clear() { this.records.clear(); }
}

const invoiceIdempotencyStore = new InvoiceIdempotencyStore();

function errorBody(error) {
  return {
    error: error.code === 'KEY_CONFLICT' ? 'idempotency_conflict' : error.code.toLowerCase(),
    code: error.code,
    message: error.message,
    ...(error.currentStatusCode === undefined ? {} : { currentStatusCode: error.currentStatusCode }),
  };
}

function invoiceIdempotencyMiddleware({ store = invoiceIdempotencyStore } = {}) {
  return (req, res, next) => {
    let key;
    let fingerprint;
    try {
      key = validateKey(req.get('Idempotency-Key'));
      fingerprint = requestFingerprint({
        method: req.method,
        path: req.baseUrl ? `${req.baseUrl}${req.path}` : req.path,
        tenantId: req.tenantId,
        body: req.body,
      });
    } catch (error) {
      if (error instanceof InvoiceIdempotencyError) return res.status(error.statusCode).json(errorBody(error));
      return next(error);
    }

    const claim = store.claim({ tenantId: req.tenantId, key, fingerprint });
    if (claim.state === 'conflict') {
      const error = new InvoiceIdempotencyError('KEY_CONFLICT', 'Idempotency-Key was reused with a different request.', 409);
      return res.status(409).json(errorBody(error));
    }
    if (claim.state === 'in_progress') {
      const error = new InvoiceIdempotencyError('REQUEST_IN_PROGRESS', 'A request with this key is currently processing.', 409);
      return res.status(409).json(errorBody(error));
    }
    if (claim.state === 'replay') {
      return res.status(claim.record.statusCode).json(claim.record.responseBody);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        store.complete(req.tenantId, key, fingerprint, res.statusCode, body);
      } catch (error) {
        store.abandon(req.tenantId, key, fingerprint);
        return next(error);
      }
      return originalJson(body);
    };
    res.on('close', () => {
      if (!res.writableEnded) store.abandon(req.tenantId, key, fingerprint);
    });
    return next();
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_KEY_LENGTH,
  MIN_KEY_LENGTH,
  KEY_PATTERN,
  InvoiceIdempotencyError,
  InvoiceIdempotencyStore,
  canonicalize,
  canonicalJson,
  requestFingerprint,
  validateKey,
  scopedKey,
  errorBody,
  invoiceIdempotencyStore,
  invoiceIdempotencyMiddleware,
};
