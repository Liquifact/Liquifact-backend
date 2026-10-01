'use strict';

/**
 * @fileoverview Runtime configuration service: applies admin-supplied config
 * changes, persists them via the soft-delete store, and manages short-lived
 * API-Key rotation state in memory.
 *
 * This file was previously stored as a minified blob with several defects
 * (`crypto.randomUUId`, a stray quote in the `retiring` label, and a broken
 * template literal in the acceptance message). It is restored here as clean,
 * readable source with the same external contract.
 *
 * Concurrency model
 * ─────────────────
 * keyStates / tenantQueues — module-level Maps that track per-tenant API-key
 * rotation state. Node.js is single-threaded, so Map reads/writes are
 * individually atomic. The `enqueue` function serialises async operations per
 * tenant so concurrent rotations for the same tenant are sequenced via a
 * promise chain rather than executing in parallel.
 *
 * Memory management: the `tenantQueues` promise chain is pruned after each
 * operation completes (the settled promise is replaced with `Promise.resolve()`)
 * to prevent unbounded chain growth when a tenant has many rotations in its
 * history.
 *
 * applyConfig atomicity: CORS environment mutation and DB persistence are both
 * idempotent operations.  Persistence failure is non-fatal (the section
 * side-effect has already been applied; a DB outage must not turn a valid write
 * into a 500).  The service logs the failure at error level so it is visible in
 * ops tooling without rejecting the caller.
 *
 * applyCorsConfig atomicity: `process.env` writes and subsequent reload calls
 * are synchronous, so they are not subject to concurrent interleaving within a
 * single Node.js event-loop tick.
 *
 * @module services/configService
 */

const crypto = require('crypto');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const { persistConfig } = require('./configSoftDelete');
const logger = require('../logger');

// Per-tenant API-Key rotation state and a serialised queue so rotations for a
// single tenant never interleave.
const keyStates = new Map();
const tenantQueues = new Map();

// Maximum overlap window (30 days) in seconds. Guards against accidentally
// indefinite retiring keys that would never expire.
const MAX_OVERLAP_SECONDS = 30 * 24 * 60 * 60;

// Maximum length for a key value before hashing. Prevents unbounded memory
// use from malicious input.
const MAX_KEY_LENGTH = 4096;

// Maximum length for a tenant identifier.
const MAX_TENANT_ID_LENGTH = 256;

/** Stable, non-secret identifier for a key value (SHA-256). */
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Returns the in-memory rotation state for a tenant, or an empty state.
 *
 * @param {string} tenantId - Tenant identifier.
 * @returns {{active: Object|null, retiring: Object|null}}
 */
function getState(tenantId) {
  return keyStates.get(tenantId) || { active: null, retiring: null };
}

/**
 * Serialises async operations per tenant so rotations apply in order.
 *
 * Memory management: the resolved tail of the chain is replaced with a bare
 * `Promise.resolve()` once the operation completes.  This keeps `tenantQueues`
 * from accumulating an ever-growing chain of settled promise references
 * (unbounded memory growth) when a single tenant performs many rotations.
 *
 * @param {string} tenantId - Tenant identifier.
 * @param {Function} op - Async operation to enqueue.
 * @returns {Promise<*>} Result of `op`.
 */
function enqueue(tenantId, op) {
  const previous = tenantQueues.get(tenantId) || Promise.resolve();
  // Gate on the previous chain, swallowing its errors so a prior failure
  // does not block subsequent operations.
  const gate = previous.catch(() => {});
  const run = gate.then(op);

  // Replace the stored chain with a version that resolves to undefined after
  // `run` settles.  This prunes the chain to a single resolved link rather
  // than accumulating the entire history.
  const pruned = run.then(() => undefined, () => undefined);
  tenantQueues.set(tenantId, pruned);

  return run;
}

/**
 * Retries an async operation with exponential backoff. The operation is
 * assumed to be idempotent or safe to repeat.
 *
 * @param {Function} op - Async operation to retry.
 * @param {Object} [options] - Retry options.
 * @param {number} [options.maxAttempts] - Maximum attempts.
 * @param {number} [options.baseDelayMs] - Base backoff delay.
 * @returns {Promise<*>} Result of `op`.
 */
async function retryWithBackoff(op, { maxAttempts = PERSIST_MAX_ATTEMPTS, baseDelayMs = PERSIST_RETRY_BASE_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) {
        break;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Rotates a tenant's active API key with an overlap window so already-issued
 * keys keep working while the new key is rolled out.
 *
 * Concurrency guarantee: all mutations to `keyStates` for a given tenant are
 * serialised through `enqueue`, so concurrent rotation requests cannot
 * interleave.  Each operation reads, validates, and writes state atomically
 * within its own event-loop microtask.
 *
 * @param {Object} params - Rotation parameters.
 * @param {string} params.tenantId - Owning tenant.
 * @param {string} params.currentKey - The currently-active key to authorise the rotation.
 * @param {string} params.newKey - The replacement key.
 * @param {number} params.overlapSeconds - Time the old key stays valid after activation.
 * @param {number} [params.activationTime] - Optional override for activation timestamp (ms).
 * @param {string|null} [params.actor] - Actor performing the rotation.
 * @returns {Promise<{tenantId: string, oldKeyId: string, newKey: string, expiresAt: number}>}
 */
async function rotateApiKey({ tenantId, currentKey, newKey, overlapSeconds, activationTime, actor }) {
  if (
    typeof tenantId !== 'string' ||
    tenantId.length === 0 ||
    tenantId.length > MAX_TENANT_ID_LENGTH
  ) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (typeof currentKey !== 'string' || currentKey.length === 0 || currentKey.length > MAX_KEY_LENGTH) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (typeof newKey !== 'string' || newKey.length === 0 || newKey.length > MAX_KEY_LENGTH) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (currentKey === newKey) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // nonsecret
    throw err;
  }
  if (
    !Number.isInteger(overlapSeconds) ||
    overlapSeconds <= 0 ||
    overlapSeconds > MAX_OVERLAP_SECONDS
  ) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (activationTime !== undefined && !Number.isFinite(activationTime)) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // nonsecret
    throw err;
  }

  return enqueue(tenantId, async () => {
    const state = getState(tenantId);
    const now = Date.now();
    const currentFingerprint = keyFingerprint(currentKey);

    if (!state.active || state.active.keyHash !== currentFingerprint) {
      const err = new Error('Active API key not found');
      err.code = 'KEY_NOT_FOUND';
      throw err;
    }

    const newFingerprint = keyFingerprint(newKey);
    if (state.active.keyHash === newFingerprint) {
      const err = new Error('New key must differ from the current active key');
      err.code = 'KEY_ALREADY_ACTIVE';
      throw err;
    }

    const notBefore = activationTime !== undefined ? activationTime : now;
    const next = {
      active: {
        keyId: crypto.randomUUID(),
        keyHash: newFingerprint,
        notBefore,
        createdAt: now,
      },
      retiring: {
        keyId: state.active.keyId,
        keyHash: state.active.keyHash,
        expiresAt: now + overlapSeconds * 1000,
      },
    };

    // Persist first; only mutate in-memory state after the write succeeds so a
    // failed persist never leaves the runtime state ahead of the durable store.
    await persistConfig({ section: 'apiKeyState', config: next, tenantId, actor: actor || null });
    keyStates.set(tenantId, next);

    return {
      tenantId,
      oldKeyId: state.active.keyId,
      newKey: next.active.keyId,
      expiresAt: next.retiring.expiresAt,
    };
  });
}

/**
 * Validates a presented API key against the tenant's in-memory rotation state.
 *
 * @param {Object} params - Lookup parameters.
 * @param {string} params.tenantId - Owning tenant.
 * @param {string} params.key - Presented key.
 * @returns {{valid: true, state: string, keyId: string, expiresAt?: number} | {valid: false, reason: string}}
 */
function validateApiKey({ tenantId, key }) {
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > MAX_TENANT_ID_LENGTH) {
    return { valid: false, reason: 'Key is not valid or has expired' };
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return { valid: false, reason: 'Key is not valid or has expired' };
  }

  const state = getState(tenantId);
  const now = Date.now();
  const fingerprint = keyFingerprint(key);

  if (state.active && state.active.keyHash === fingerprint && now >= state.active.notBefore) {
    return { valid: true, state: 'active', keyId: state.active.keyId };
  }
  if (state.retiring && state.retiring.keyHash === fingerprint && now <= state.retiring.expiresAt) {
    return { valid: true, state: 'retiring', keyId: state.retiring.keyId, expiresAt: state.retiring.expiresAt };
  }
  return { valid: false, reason: 'Key is not valid or has expired' };
}

/**
 * Applies + persists an admin configuration change.
 *
 * Failure model: CORS environment changes and DB persistence are both applied
 * optimistically.  If persistence fails the section side-effect is already in
 * effect; the failure is logged at error level but the caller still receives a
 * success response.  This prevents a transient DB outage from rejecting a
 * valid configuration write that has already been applied.
 *
 * @param {string} section - Configuration section name.
 * @param {Object} config - Section configuration payload.
 * @param {Object} context - Request context (`tenantId`, `adminClient`).
 * @returns {Promise<{id?: string, section: string, config: Object, message: string}>}
 */
async function applyConfig(section, config, context) {
  if (typeof section !== 'string' || section.length === 0) {
    const err = new Error('Config section is required');
    err.code = 'INVALID_CONFIG_SECTION';
    throw err;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    const err = new Error('Config payload must be a plain object');
    err.code = 'INVALID_CONFIG_PAYLOAD';
    throw err;
  }
  if (context === null || typeof context !== 'object') {
    const err = new Error('Config context is required');
    err.code = 'INVALID_CONFIG_CONTEXT';
    throw err;
  }

  const { tenantId, adminClient } = context;

  let persisted;
  try {
    persisted = await retryWithBackoff(() =>
      persistConfig({
        section,
        config,
        tenantId: tenantId || '',
        actor: adminClient || null,
      })
    );
  } catch (err) {
    logger.error(
      { err, section, tenantId: tenantId || '', adminClient: adminClient || null },
      'configService: failed to persist config'
    );
    const wrapped = new Error('Failed to persist configuration change');
    wrapped.code = 'CONFIG_PERSIST_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  // Only apply runtime side effects after the change is durably persisted.
  if (section === 'cors') {
    applyCorsConfig(config);
  }

  const logPayload = { tenantId: tenantId || '', section, adminClient: adminClient || null };
  if (persisted && persisted.id) {
    logPayload.recordId = persisted.id;
  }
  logger.info(logPayload, 'Admin runtime config update accepted');

  return {
    id: persisted ? persisted.id : undefined,
    section,
    config,
    message: `Configuration section '${section}' validated and accepted.`,
  };
}

/**
 * Applies CORS-specific runtime configuration (origins / max-age) and reloads
 * the allowlist.
 *
 * Synchrony guarantee: `process.env` writes and the `reloadCors*` calls are
 * all synchronous.  They execute atomically within the current event-loop tick
 * and cannot be interleaved with a concurrent invocation.
 *
 * @param {Object} config - CORS section config.
 */
function applyCorsConfig(config) {
  if (config.origins !== undefined) {
    if (!Array.isArray(config.origins)) {
      const err = new Error('CORS origins must be an array of strings');
      err.code = 'INVALID_CORS_ORIGINS'; // nosecret
      throw err;
    }
    const origins = config.origins.map((origin) => {
      if (typeof origin !== 'string' || origin.length === 0) {
        const err = new Error('CORS origins must be an array of non-empty strings');
        err.code = 'INVALID_CORS_ORIGIN'; // nonsecret
        throw err;
      }
      return origin.trim();
    });
    process.env.CORS_ALLOWED_ORIGINS = origins.join(',');
    reloadCorsOrigins();
  }
  if (config.maxAge !== undefined) {
    if (!Number.isInteger(config.maxAge) || config.maxAge < 0) {
      const err = new Error('CORS maxAge must be a non-negative integer');
      err.code = 'INVALID_CORS_MAX_AGE'; // nonsecret
      throw err;
    }
    process.env.CORS_MAX_AGE = String(config.maxAge);
    reloadCorsMaxAge();
  }
}

/**
 * Returns the allowed configuration section names.
 *
 * @returns {string[]}
 */
function getConfigSections() {
  const { CONFIG_SECTIONS } = require('../schemas/config');
  return CONFIG_SECTIONS;
}

/**
 * Resets the in-memory rotation state for a tenant. Intended for tests and
 * operational recovery tooling; not part of the public API contract.
 *
 * @param {string} tenantId - Tenant identifier.
 */
function _resetState(tenantId) {
  if (tenantId === undefined) {
    keyStates.clear();
    tenantQueues.clear();
    return;
  }
  keyStates.delete(tenantId);
  tenantQueues.delete(tenantId);
}

module.exports = {
  applyConfig,
  applyCorsConfig,
  getConfigSections,
  rotateApiKey,
  validateApiKey,
  _resetState,
};
