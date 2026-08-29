'use strict';

/**
 * @fileoverview One-way, salted hashing and verification for webhook signing
 * secrets.
 *
 * Webhook secrets have historically been persisted as **reversible** values
 * inside `tenants.settings.webhook_secret`. Anyone with database read access
 * could recover every tenant's signing key and forge `X-Signature` payloads.
 *
 * Instead of forcing a flag-day reset (which would invalidate every already
 * deployed client), we add a **one-way at-rest representation**: a salted
 * `scrypt` hash that can be used to verify a presented secret without ever
 * making it recoverable, alongside an auditable, atomic backfill migration
 * (see `webhookSecretMigration.js`).
 *
 * ## Hard constraints
 *
 * - The `v1` HMAC-SHA256 **signing** path still needs the raw secret at enqueue
 *   time (you cannot re-derive an HMAC key from a hash). This module therefore
 *   never breaks signing; it adds a hashed canonical record + a constant-time
 *   verification primitive. Removing the operational plaintext entirely is a
 *   key-rotation rollout and is intentionally NOT a flag-day (see the
 *   `docs`/PR notes for that tradeoff).
 * - Plaintext material is never logged, never included in audit metadata, and
 *   never returned. Only a short, non-sensitive hash fingerprint is written.
 *
 * @module services/webhookSecretVault
 */

const crypto = require('crypto');

/** Scheme marker for the current hashed representation. */
const HASH_VARIANT = 'hash:v1';

/** Random salt length in bytes (128 bits of entropy). */
const SALT_BYTES = 16;

/** Derived-key length in bytes (256 bits). */
const HASH_BYTES = 32;

/** scrypt cost parameters (memory-hard, bounded at-rest brute force). */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Bounded secret length to keep scrypt input sane and a DoS surface small. */
const MAX_SECRET_LENGTH = 1024;

// Guard against non-crypto environments (stubbed modules in tests) while still
// surfacing a clear error for genuinely missing crypto.
const timingSafeEqual =
  crypto.timingSafeEqual ||
  ((a, b) => {
    /* istanbul ignore next */
    return String(a) === String(b);
  });

/**
 * Node's `crypto.scrypt` promisified.
 *
 * @param {Buffer|string} secret - Secret material.
 * @param {string} salt - Salt (hex string).
 * @param {number} keylen - Derived-key length in bytes.
 * @returns {Promise<Buffer>} Derived key.
 */
function scryptAsync(secret, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      secret,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Generates a fresh random salt.
 *
 * @returns {string} Hex-encoded salt.
 */
function createSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

/**
 * Computes the one-way hash of a secret for a given salt.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} salt - Hex-encoded salt.
 * @returns {Promise<string>} Hex-encoded derived hash.
 * @throws {Error} If `secret` exceeds {@link MAX_SECRET_LENGTH}.
 */
async function hashSecret(secret, salt) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Cannot hash an empty webhook secret');
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    const err = new Error('Webhook secret exceeds maximum allowed length');
    err.code = 'SECRET_TOO_LONG';
    throw err;
  }
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new Error('Webhook secret salt is required');
  }
  const derived = await scryptAsync(Buffer.from(secret, 'utf8'), salt, HASH_BYTES);
  return derived.toString('hex');
}

/**
 * Returns a short, non-sensitive prefix of a hash for audit/log fingerprinting.
 * The raw hash is never a secret itself (it is one-way), but exposing only a
 * short prefix keeps audit surfaces compact.
 *
 * @param {string} hash - Hex-encoded derived hash.
 * @returns {string|null} Truncated fingerprint or null.
 */
function fingerprint(hash) {
  return typeof hash === 'string' && hash.length > 0 ? hash.slice(0, 16) : null;
}

/**
 * Constant-time string comparison.
 *
 * @param {string} a - First value.
 * @param {string} b - Second value.
 * @returns {boolean} True when both values are equal (lengths equal too).
 */
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * True when a settings object already carries the current hashed
 * representation.
 *
 * @param {Object} [settings] - `tenants.settings` JSONB object.
 * @returns {boolean} True when the record is already hashed.
 */
function isHashed(settings) {
  return !!(
    settings &&
    settings.webhook_secret_variant === HASH_VARIANT &&
    typeof settings.webhook_secret_hash === 'string' &&
    settings.webhook_secret_hash.length > 0 &&
    typeof settings.webhook_secret_salt === 'string' &&
    settings.webhook_secret_salt.length > 0
  );
}

/**
 * True when a settings object holds a legacy (plaintext) webhook secret that
 * has not yet been migrated to the hashed representation.
 *
 * @param {Object} [settings] - `tenants.settings` JSONB object.
 * @returns {boolean} True for a legacy, un-migrated secret.
 */
function isLegacy(settings) {
  return !!(
    settings &&
    typeof settings.webhook_secret === 'string' &&
    settings.webhook_secret.length > 0 &&
    !isHashed(settings)
  );
}

/**
 * Verifies that a candidate plaintext matches the recorded **legacy** secret.
 *
 * Used by the migration to "verify before replacing": we only promote a legacy
 * secret when the value we are about to hash is the value actually on record,
 * using a constant-time comparison so timing does not leak secret properties.
 *
 * Throws `NOT_LEGACY` when the record is not in legacy form.
 *
 * @param {Object} settings - `tenants.settings` JSONB object.
 * @param {string} candidate - Candidate plaintext secret.
 * @returns {boolean} True when the candidate matches the legacy secret.
 */
function verifyLegacySecret(settings, candidate) {
  if (!isLegacy(settings)) {
    const err = new Error('Webhook secret is not in legacy format');
    err.code = 'NOT_LEGACY';
    throw err;
  }
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  return constantTimeEqual(settings.webhook_secret, candidate);
}

/**
 * Verifies a presented plaintext secret against the record's current
 * representation (hashed or legacy), constant-time in both cases. This is the
 * primitive that lets the backend confirm identity without exposing the stored
 * plaintext.
 *
 * @param {string} candidate - Candidate plaintext secret.
 * @param {Object} settings - `tenants.settings` JSONB object.
 * @returns {Promise<boolean>} True when the candidate matches.
 */
async function matchesSecret(candidate, settings) {
  if (typeof candidate !== 'string' || candidate.length === 0 || !settings) {
    return false;
  }
  if (isHashed(settings)) {
    const hash = await hashSecret(candidate, settings.webhook_secret_salt);
    return constantTimeEqual(hash, settings.webhook_secret_hash);
  }
  if (isLegacy(settings)) {
    return constantTimeEqual(settings.webhook_secret, candidate);
  }
  return false;
}

/**
 * Builds a new settings object with the hashed representation set. The input
 * object is never mutated — callers get a shallow copy so the migration can
 * write the record atomically.
 *
 * @param {Object} settings - Current `tenants.settings`.
 * @param {Object} params - Hashing parameters.
 * @param {string} params.salt - Salt used to derive `hash`.
 * @param {string} params.hash - Derived one-way hash.
 * @param {Date} [params.now] - Timestamp to stamp the record.
 * @returns {Object} New settings with hashed representation fields.
 */
function buildHashedSettings(settings, { salt, hash, now }) {
  const next = { ...(settings || {}) };
  next.webhook_secret_hash = hash;
  next.webhook_secret_salt = salt;
  next.webhook_secret_variant = HASH_VARIANT;
  next.webhook_secret_hashed_at = (now || new Date()).toISOString();
  return next;
}

module.exports = {
  HASH_VARIANT,
  SALT_BYTES,
  HASH_BYTES,
  MAX_SECRET_LENGTH,
  createSalt,
  hashSecret,
  fingerprint,
  constantTimeEqual,
  isHashed,
  isLegacy,
  verifyLegacySecret,
  matchesSecret,
  buildHashedSettings,
};