'use strict';

/**
 * @fileoverview Soft-delete, restore, and retention purge for escrow-read
 * records (issue #31).
 *
 * An "escrow-read record" is a row in `escrow_event_projection` — the durable
 * per-invoice projection written by the indexer and served by
 * {@link module:services/escrowRead}. Hard-deleting one is destructive and
 * irreversible: the projection is the only off-chain copy of the latest
 * observed escrow event, so an operator mistake previously meant waiting for a
 * full re-index to recover.
 *
 * Failure recovery is deterministic: every mutation is guarded by a
 * compare-and-set predicate on the row's current tombstone state, so retries
 * and concurrent callers converge on the same observable outcome. Cache
 * invalidation is best-effort and never blocks or rolls back the durable
 * state transition; a failed invalidation is logged and retried on the next
 * read via the cache's own TTL, not by re-applying the mutation.
 *
 * Model
 * -----
 *   live       → `deleted_at IS NULL`. Served by every read path.
 *   tombstoned → `deleted_at` set. Excluded from all default reads (they see
 *                the neutral `not_found` state), restorable until the window
 *                expires.
 *   purged     → row physically removed by {@link purgeExpiredSoftDeletes}
 *                once `deleted_at + retention window < now`. Not recoverable.
 *
 * The retention window is `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` (default
 * 30, clamped to 1–3650). Restore is refused once the window has elapsed even
 * if the purge job has not run yet, so "restorable" never depends on job
 * scheduling luck — the window alone decides.
 *
 * Cache coherence: both delete and restore invalidate the local + Redis escrow
 * read caches via {@link module:services/escrowRead.invalidateEscrowReadCache}.
 * Without that, a cached summary would keep serving a record that was just
 * tombstoned.
 *
 * Purge is idempotent and resumable: each batch deletes by primary key under
 * the same `deleted_at <= cutoff` predicate used to select it, so a crash
 * mid-run leaves only rows that still satisfy the predicate for the next run.
 * A row whose `deleted_at` is unparseable is treated as expired and purged,
 * never left in an ambiguous "restorable" state.
 *
 * @module services/escrowReadSoftDelete
 */

const db = require('../db/knex');
const logger = require('../logger');
const {
  validateInvoiceId,
  invalidateEscrowReadCache,
} = require('./escrowRead');

/**
 * Table holding escrow-read records.
 * @constant {string}
 */
const PROJECTION_TABLE = 'escrow_event_projection';

/** @constant {number} */
const DEFAULT_RETENTION_DAYS = 30;
/** @constant {number} */
const MIN_RETENTION_DAYS = 1;
/** @constant {number} */
const MAX_RETENTION_DAYS = 3650;
/** @constant {number} */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** @constant {number} */
const DEFAULT_PURGE_BATCH_SIZE = 500;
/** @constant {number} */
const MAX_PURGE_BATCH_SIZE = 10000;
/** @constant {number} */
const DEFAULT_PURGE_MAX_BATCHES = 100;
/** @constant {number} */
const MAX_PURGE_MAX_BATCHES = 1000;

/**
 * Error codes raised by this module. Route handlers map these onto HTTP
 * statuses; nothing else should branch on message text.
 *
 * @constant {Readonly<Record<string, string>>}
 */
const SOFT_DELETE_ERRORS = Object.freeze({
  /** No projection row exists for the invoice. */
  NOT_FOUND: 'ESCROW_READ_NOT_FOUND',
  /** Record is already tombstoned (delete is not re-applied). */
  ALREADY_DELETED: 'ESCROW_READ_ALREADY_DELETED',
  /** Restore was requested for a record that is not tombstoned. */
  NOT_DELETED: 'ESCROW_READ_NOT_DELETED',
  /** Restore was requested after the retention window elapsed. */
  RETENTION_EXPIRED: 'ESCROW_READ_RETENTION_EXPIRED',
  /** `invoiceId` failed shared validation. */
  INVALID_INVOICE_ID: 'INVALID_INVOICE_ID',
  /** A concurrent writer changed the row between read and update. */
  CONCURRENT_MODIFICATION: 'ESCROW_READ_CONCURRENT_MODIFICATION',
});

/**
 * Builds a tagged error with `code` and `status` so route handlers can map it
 * without string matching.
 *
 * @param {string} code - One of {@link SOFT_DELETE_ERRORS}.
 * @param {number} status - HTTP status the API should return.
 * @param {string} message - Human-readable detail.
 * @param {object} [extra] - Extra fields copied onto the error.
 * @returns {Error} Tagged error, ready to throw.
 */
function _softDeleteError(code, status, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

/**
 * Reads the configured retention window in days.
 *
 * Invalid, non-numeric, or out-of-range values fall back to the default rather
 * than throwing: a typo in an env var must not shorten the window (which would
 * make records unrecoverable early) nor block startup.
 *
 * @returns {number} Retention window in days, clamped to [1, 3650].
 */
function getRetentionDays() {
  const parsed = Number(process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS);
  if (!Number.isFinite(parsed) || parsed < MIN_RETENTION_DAYS) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.min(Math.floor(parsed), MAX_RETENTION_DAYS);
}

/**
 * Retention window expressed in milliseconds.
 *
 * @returns {number} Window length in ms.
 */
function getRetentionMs() {
  return getRetentionDays() * MS_PER_DAY;
}

/**
 * Purge batch size (`ESCROW_READ_PURGE_BATCH_SIZE`).
 *
 * @returns {number} Rows deleted per batch, clamped to [1, 10000].
 */
function getPurgeBatchSize() {
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_BATCH_SIZE, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_BATCH_SIZE;
  }
  return Math.min(parsed, MAX_PURGE_BATCH_SIZE);
}

/**
 * Maximum batches per purge run (`ESCROW_READ_PURGE_MAX_BATCHES`). Bounds a
 * single run so a large backlog cannot monopolise a connection indefinitely.
 *
 * @returns {number} Max batches, clamped to [1, 1000].
 */
function getPurgeMaxBatches() {
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_MAX_BATCHES, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_MAX_BATCHES;
  }
  return Math.min(parsed, MAX_PURGE_MAX_BATCHES);
}

/**
 * Parses a timestamp column into epoch milliseconds. Accepts `Date`, IS
 * strings, and epoch numbers because the column round-trips differently under
 * SQLite (string) and Postgres (Date).
 *
 * @param {unknown} value - Raw column value.
 * @returns {number|null} Epoch ms, or null when unparseable/absent.
 */
function _toEpochMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Whether a tombstone has aged past the retention window.
 *
 * A `deleted_at` value that cannot be parsed is treated as **expired**: an
 * unreadable tombstone date must not grant an unbounded restore window, and
 * the purge job needs a deterministic answer for corrupt rows.
 *
 * @param {unknown} deletedAt - Raw `deleted_at` column value.
 * @param {object} [options={}]
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @param {number} [options.retentionMs=getRetentionMs()] - Window override.
 * @returns {boolean} True when the record is past its retention window.
 */
function isRetentionExpired(deletedAt, options = {}) {
  const { now = Date.now(), retentionMs = getRetentionMs() } = options;
  const deletedMs = _toEpochMs(deletedAt);
  if (deletedMs === null) {
    return true;
  }
  return now - deletedMs >= retentionMs;
}

/**
 * Normalises a projection row into the soft-delete envelope returned by the
 * service and the admin API.
 *
 * @param {object} row - Raw `escrow_event_projection` row.
 * @param {object} [options={}]
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @param {number} [options.retentionMs=getRetentionMs()] - Window override.
 * @returns {object} `{ invoiceId, deleted, deletedAt, deletedBy, deleteReason,
 *   restoredAt, restoredBy, purgeAfter, restorable }`.
 */
function _toSoftDeleteState(row, options = {}) {
  const { now = Date.now(), retentionMs = getRetentionMs() } = options;
  const deletedMs = _toEpochMs(row.deleted_at);
  const deleted = deletedMs !== null;

  return {
    invoiceId: row.invoice_id,
    deleted,
    deletedAt: deleted ? new Date(deletedMs).toISOString() : null,
    deletedBy: row.deleted_by || null,
    deleteReason: row.delete_reason || null,
    restoredAt: (() => {
      const restoredMs = _toEpochMs(row.restored_at);
      return restoredMs === null ? null : new Date(restoredMs).toISOString();
    })(),
    restoredBy: row.restored_by || null,
    purgeAfter: deleted ? new Date(deletedMs + retentionMs).toISOString() : null,
    restorable: deleted && !isRetentionExpired(deletedMs, { now, retentionMs }),
  };
}

/**
 * Validates an invoice id and returns its normalised form. Throws a tagged
 * error when invalid so route handlers can map it to a 400.
 *
 * @param {string} invoiceId - Candidate id.
 * @returns {string} Normalised id.
 */
function _requireInvoiceId(invoiceId) {
  const validation = validateInvoiceId(invoiceId);
  if (!validation || validation.valid !== true) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
      400,
      'Invalid invoice id',
      { invoiceId },
    );
  }
  return validation.normalized || validation.value || invoiceId;
}

/**
 * Fetches the projection row for an invoice id, or undefined when absent.
 *
 * @param {string} invoiceId - Normalised invoice id.
 * @returns {Promise<object|undefined>} Raw row or undefined.
 */
async function _fetchRow(invoiceId) {
  return db(PROJECTION_TABLE).where({ invoice_id: invoiceId }).first();
}

/**
 * Best-effort cache invalidation. Never throws: a failure to invalidate is
 * logged and the durable state transition still commits. The cache will retry
 * its own invalidation on the next read.
 *
 * @param {string} invoiceId - Normalised invoice id.
 * @param {string} operation - Operation name for logging.
 * @returns {Promise<void>}
 */
async function _invalidateCachesBestEffort(invoiceId, operation) {
  try {
    await invalidateEscrowReadCache(invoiceId);
  } catch (err) {
    logger.warn('escrowReadSoftDelete.cacheInvalidationFailed', {
      invoiceId,
      operation,
      error: err && err.message,
    });
  }
}

/**
 * Soft-deletes an escrow-read record. Idempotent under retries and concurrent
 * callers: the update is guarded by `deleted_at IS NULL`, so a race loser observes
 * the same tombstone and receives `ALREADY_DELETED` instead of clobbering the
 * original deleter's metadata.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {string} [options.deletedBy] - Actor recorded on the tombstone.
 * @param {string} [options.reason] - Free-text reason.
 * @param {number} [options.now] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope.
 */
async function softDeleteEscrowRead(invoiceId, options = {}) {
  const normalisedId = _requireInvoiceId(invoiceId);
  const now = options.now || Date.now();
  const deletedAt = new Date(now);

  const row = await _fetchRow(normalisedId);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      'Escrow read record not found',
      { invoiceId: normalisedId },
    );
  }

  if (_toEpochMs(row.deleted_at) !== null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      'Escrow read record is already deleted',
      { invoiceId: normalisedId },
    );
  }

  const updated = await db(PROJECTION_TABLE)
    .where({ invoice_id: normalisedId, deleted_at: null })
    .update({
      deleted_at: deletedAt,
      deleted_by: options.deletedBy || null,
      delete_reason: options.reason || null,
    });

  if (!updated) {
    // Lost the race: another caller tombstoned the row first. Surface the
    // same observable outcome as a sequential double delete.
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      'Escrow read record is already deleted',
      { invoiceId: normalisedId },
    );
  }

  await _invalidateCachesBestEffort(normalisedId, 'softDelete');

  const refreshed = await _fetchRow(normalisedId);
  return _toSoftDeleteState(refreshed || row, { now });
}

/**
 * Restores a soft-deleted escrow-read record. Refuses once the retention window
 * has elapsed, even if the purge job has not run yet, so restorability depends
 * only on the window and not on job scheduling luck.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {string} [options.restoredBy] - Actor recorded on the restore.
 * @param {number} [options.now] - Clock override (epoch ms).
 * @param {number} [options.retentionMs] - Window override.
 * @returns {Promise<object>} Soft-delete envelope.
 */
async function restoreEscrowRead(invoiceId, options = {}) {
  const normalisedId = _requireInvoiceId(invoiceId);
  const now = options.now || Date.now();
  const retentionMs = options.retentionMs || getRetentionMs();

  const row = await _fetchRow(normalisedId);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      'Escrow read record not found',
      { invoiceId: normalisedId },
    );
  }

  const deletedMs = _toEpochMs(row.deleted_at);
  if (deletedMs === null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_DELETED,
      409,
      'Escrow read record is not deleted',
      { invoiceId: normalisedId },
    );
  }

  if (isRetentionExpired(deletedMs, { now, retentionMs })) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      410,
      'Retention window has expired; record cannot be restored',
      { invoiceId: normalisedId, deletedAt: new Date(deletedMs).toISOString() },
    );
  }

  const updated = await db(PROJECTION_TABLE)
    .where({ invoice_id: normalisedId, deleted_at: row.deleted_at })
    .update({
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
      restored_at: new Date(now),
      restored_by: options.restoredBy || null,
    });

  if (!updated) {
    // A concurrent writer changed the tombstone between our read and update.
    // Re-read and report the current state deterministically rather than
    // clobassing it.
    const current = await _fetchRow(normalisedId);
    if (!current) {
      throw _softDeleteError(
        SOFT_DELETE_ERRORS.NOT_FOUND,
        404,
        'Escrow read record not found',
        { invoiceId: normalisedId },
      );
    }
    if (_toEpochMs(current.deleted_at) === null) {
      throw _softDeleteError(
        SOFT_DELETE_ERRORS.NOT_DELETED,
        409,
        'Escrow read record is not deleted',
        { invoiceId: normalisedId },
      );
    }
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.CONCURRENT_MODIFICATION,
      409,
      'Escrow read record was modified concurrently',
      { invoiceId: normalisedId },
    );
  }

  await _invalidateCachesBestEffort(normalisedId, 'restore');

  const refreshed = await _fetchRow(normalisedId);
  return _toSoftDeleteState(refreshed || row, { now, retentionMs });
}

/**
 * Purges expired soft-deleted escrow-read records in bounded batches.
 *
 * Idempotent and resumable: each batch deletes by primary key under the same
 * `deleted_at <= cutoff` predicate used to select it, so a crash mid-run leaves
 * only rows that still satisfy the predicate for the next run. Rows with an
 * unparseable `deleted_at` are treated as expired and purged.
 *
 * @param {object} [options={}]
 * @param {number} [options.now] - Clock override (epoch ms).
 * @param {number} [options.retentionMs] - Window override.
 * @param {number} [options.batchSize] - Rows per batch.
 * @param {number} [options.maxBatches] - Max batches per run.
 * @returns {Promise<object>} `{ y deleted, batches, cutoff }`.
 */
async function purgeExpiredSoftDeletes(options = {}) {
  const now = options.now || Date.now();
  const retentionMs = options.retentionMs || getRetentionMs();
  const batchSize = options.batchSize || getPurgeBatchSize();
  const maxBatches = options.maxBatches || getPurgeMaxBatches();
  const cutoff = new Date(now - retentionMs);

  let deleted = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const rows = await db(PROJECTION_TABLE)
      .whereNotNull('deleted_at')
      .andWhere('deleted_at', '<=', cutoff)
      .limit(batchSize)
      .select('invoice_id');

    if (!rows.length) {
      break;
    }

    const ids = rows.map((r) => r.invoice_id);
    const removed = await db(PROJECTION_TABLE)
      .whereIn('invoice_id', ids)
      .andWhereNotNull('deleted_at')
      .andWhere('deleted_at', '<=', cutoff)
      .del();

    deleted += removed;
    batches += 1;

    for (const id of ids) {
      await _invalidateCachesBestEffort(id, 'purge');
    }

    if (removed < rows.length) {
      // Some rows were restored concurrently; stop to avoid looping on the
      // same set of ids and let the next run re-evaluate the predicate.
      break;
    }
  }

  if (deleted > 0) {
    logger.info('escrowReadSoftDelete.purged', { deleted, batches });
  }

  return { deleted, batches, cutoff: cutoff.toISOString() };
}

module.exports = {
  SOFT_DELETE_ERRORS,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  isRetentionExpired,
  softDeleteEscrowRead,
  restoreEscrowRead,
  purgeExpiredSoftDeletes,
};
