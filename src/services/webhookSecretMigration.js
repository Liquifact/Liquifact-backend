'use strict';

/**
 * @fileoverview Atomic, auditable backfill of legacy (plaintext) webhook
 * secrets into the salted one-way representation from `webhookSecretVault.js`.
 *
 * This is the "detect → verify → replace" pipeline required to close the
 * at-rest reversible-secret gap without a flag-day invalidation:
 *
 * 1. **Detect** — tenant records whose `settings.webhook_secret` is a legacy
 *    value that has not yet been promoted (`isLegacy`).
 * 2. **Verify before replacing** — each legacy secret is constant-time matched
 *    against the value actually on record; only a verified value is hashed.
 *    Invalid values are skipped and surfaced, never overwritten.
 * 3. **Replace / promote** — a fresh per-tenant salt is generated and the
 *    one-way hash is written to the same settings blob.
 * 4. **Atomic** — each tenant's update + audit row runs in one transaction. On
 *    any failure the transaction rolls back, leaving the legacy value intact
 *    so a re-run (interrupted migration) simply continues.
 * 5. **Tenant isolation** — salting is per-tenant, so the **same key under two
 *    tenants** yields two distinct hashes and two independent audit events.
 * 6. **Auditable** — one `webhook.secret.hashed` audit event per promotion that
 *    carries only a non-sensitive hash fingerprint, never the plaintext.
 *
 * The runner is idempotent and safe to schedule as a background job or a
 * one-off CLI script. All dependencies (db/audit) are injectable for tests.
 *
 * @module services/webhookSecretMigration
 */

const db = require('../db/knex');
const logger = require('../logger');
const { appendAuditEvent } = require('./auditLogStore');
const vault = require('./webhookSecretVault');

/**
 * Loads one keyed page of tenant candidates, newest-isolated so a persistent
 * failure on an earlier id can't starve later tenants (we key off `id >`).
 *
 * @param {Object} dbClient - Knex instance.
 * @param {Object} opts - Paging options.
 * @param {number} opts.batchSize - Rows per page.
 * @param {string|null} [opts.afterId] - Exclusive lower bound on tenant id.
 * @returns {Promise<Array<{id: string, settings: Object}>>}
 */
function listTenantPage(dbClient, { batchSize, afterId }) {
  let query = dbClient('tenants')
    .select('id', 'settings')
    .orderBy('id', 'asc')
    .limit(batchSize);
  if (afterId) {
    query = query.where('id', '>', afterId);
  }
  return query;
}

/**
 * LEGACY_KEY_VERIFIED — default verifier confirms the candidate secret is the
 * recorded legacy value (constant-time). Callers may substitute a stronger
 * verifier, e.g. one that replays an observed `X-Signature`.
 *
 * @param {Object} settings - `tenants.settings`.
 * @param {string} candidate - Candidate plaintext secret.
 * @returns {boolean} True when verified.
 */
function defaultVerify(settings, candidate) {
  return vault.verifyLegacySecret(settings, candidate);
}

/**
 * Migrates a single legacy tenant: generates a fresh salt, hashes the verified
 * secret, writes the hashed representation and an audit row in one transaction.
 *
 * Rolls back and re-throws on failure so the caller can classify the tenant as
 * errored (leaving the legacy value untouched for a safe re-run).
 *
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.dbClient - Knex instance.
 * @param {Function} deps.audit - `appendAuditEvent`-compatible writer.
 * @param {Function} deps.saltProvider - Salt generator.
 * @param {Function} deps.hashFn - Async hash function `(secret, salt) => hash`.
 * @param {Function} deps.verify - `(settings, candidate) => boolean`.
 * @param {Function} deps.now - Timestamp factory.
 * @param {Object} row - Tenant row `{ id, settings }`.
 * @returns {Promise<void>}
 */
async function migrateTenant(deps, row) {
  const { dbClient, audit, saltProvider, hashFn, verify, now } = deps;
  const { id, settings } = row;

  // Verify before replacing. If the legacy value doesn't match the record we
  // refuse to touch it (legacy key invalid edge case).
  if (!verify(settings, settings.webhook_secret)) {
    logger.warn(
      { tenantId: id },
      'webhook-secret-migration: skipping legacy secret that failed verification',
    );
    return 'invalid';
  }

  const salt = saltProvider();
  const hash = await hashFn(settings.webhook_secret, salt);

  const trx = await dbClient.transaction();
  try {
    const newSettings = vault.buildHashedSettings(settings, { salt, hash, now: now() });
    await trx('tenants').where('id', id).update({ settings: newSettings });
    await audit(
      {
        eventType: 'webhook_secret',
        action: 'webhook.secret.hashed',
        actorType: 'system',
        actorId: 'webhook-secret-migration',
        targetType: 'tenant',
        targetId: id,
        statusCode: 200,
        metadata: {
          tenantId: id,
          hashFingerprint: vault.fingerprint(hash),
          variant: vault.HASH_VARIANT,
        },
      },
      { db: trx },
    );
    await trx.commit();
    return 'hashed';
  } catch (err) {
    try {
      await trx.rollback();
    } catch (_e) {
      // Preserve the original error.
    }
    throw err;
  }
}

/**
 * Runs the migration over all tenants. Idempotent, tenant-isolated, and
 * re-runnable if interrupted.
 *
 * @param {Object} [opts] - Options/overrides (all injectable for tests).
 * @param {Object} [opts.dbClient] - Knex instance (defaults to the app's).
 * @param {Function} [opts.audit] - Audit writer (default `appendAuditEvent`).
 * @param {Function} [opts.saltProvider] - Salt generator.
 * @param {Function} [opts.hashFn] - Async hash function.
 * @param {Function} [opts.verify] - Legacy-secret verifier.
 * @param {Function} [opts.now] - Timestamp factory.
 * @param {number} [opts.batchSize] - Rows per paging batch.
 * @returns {Promise<{
 *   examined: number, legacy: number, hashed: number,
 *   alreadyHashed: number, invalid: number, errored: number,
 * }>} Counts only — never contains secret material.
 */
async function runMigration(opts = {}) {
  const dbClient = opts.dbClient || db;
  const audit = opts.audit || appendAuditEvent;
  const saltProvider = opts.saltProvider || vault.createSalt;
  const hashFn = opts.hashFn || vault.hashSecret;
  const verify = opts.verify || defaultVerify;
  const now = opts.now || (() => new Date());
  const batchSize = Number(opts.batchSize) > 0 ? Number(opts.batchSize) : 100;

  const summary = {
    examined: 0,
    legacy: 0,
    hashed: 0,
    alreadyHashed: 0,
    invalid: 0,
    errored: 0,
  };

  let afterId = null;
  for (;;) {
    const rows = await listTenantPage(dbClient, { batchSize, afterId });
    if (!rows || rows.length === 0) {
      break;
    }

    for (const row of rows) {
      // Advance even on failure so a persistently-stuck tenant can't trigger
      // an infinite loop; reversal to `null` on a fresh run keeps it re-tryable.
      afterId = row.id;
      summary.examined += 1;

      const settings = row.settings;
      if (vault.isHashed(settings)) {
        summary.alreadyHashed += 1;
        continue;
      }
      if (!vault.isLegacy(settings)) {
        // No webhook secret configured — nothing to migrate.
        continue;
      }
      summary.legacy += 1;

      try {
        const outcome = await migrateTenant(
          { dbClient, audit, saltProvider, hashFn, verify, now },
          row,
        );
        if (outcome === 'invalid') {
          summary.invalid += 1;
        } else if (outcome === 'hashed') {
          summary.hashed += 1;
        }
      } catch (err) {
        summary.errored += 1;
        logger.error(
          {
            tenantId: row.id,
            error: err && err.message ? err.message : String(err),
          },
          'webhook-secret-migration: tenant migration failed; legacy value left intact',
        );
      }
    }

    // Last page when a page returns fewer rows than requested.
    if (rows.length < batchSize) {
      break;
    }
  }

  logger.info({ summary }, 'webhook-secret-migration: completed');
  return summary;
}

module.exports = {
  runMigration,
  migrateTenant,
  defaultVerify,
  listTenantPage,
  vault,
};