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
 * Parses a timestamp column into epoch milliseconds. Accepts `Date`, ISO
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
    purgeAfter: deleted
      ? new Date(deletedMs + retentionMs).toISOString()
      : null,
    restorable: deleted && !isRetentionExpired(row.deleted_at, { now, retentionMs }),
    retentionDays: Math.round(retentionMs / MS_PER_DAY),
  };
}

/**
 * Validates and trims an invoice ID, reusing the canonical escrow-read rule so
 * the soft-delete surface accepts exactly the IDs the read surface accepts.
 *
 * @param {unknown} invoiceId - Candidate ID.
 * @returns {string} Trimmed, validated ID.
 * @throws {Error} `INVALID_INVOICE_ID` / 400 when validation fails.
 */
function _requireValidInvoiceId(invoiceId) {
  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    throw _softDeleteError(SOFT_DELETE_ERRORS.INVALID_INVOICE_ID, 400, reason);
  }
  return String(invoiceId).trim();
}

/**
 * Loads a projection row regardless of tombstone state.
 *
 * @param {string} safeId - Validated invoice ID.
 * @param {import('knex').Knex} dbClient - Knex instance.
 * @returns {Promise<object|null>} Raw row, or null when absent.
 */
async function _findRow(safeId, dbClient) {
  const row = await dbClient(PROJECTION_TABLE)
    .where('invoice_id', safeId)
    .first();
  return row || null;
}

/**
 * Returns the soft-delete state of an escrow-read record, including records
 * that are currently tombstoned (this is the one read that does not hide
 * them — it exists so operators can see what is recoverable).
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope (see {@link _toSoftDeleteState}).
 * @throws {Error} `INVALID_INVOICE_ID` (400) or `ESCROW_READ_NOT_FOUND` (404).
 */
async function getEscrowReadDeletionState(invoiceId, options = {}) {
  const { dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidInvoiceId(invoiceId);

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No escrow-read record found for invoice '${safeId}'`
    );
  }
  return _toSoftDeleteState(row, { now });
}

/**
 * Soft-deletes an escrow-read record: marks it tombstoned so every default
 * read path treats the invoice as "not indexed", while the row itself survives
 * for the retention window.
 *
 * Idempotency: re-deleting an already-tombstoned record throws
 * `ESCROW_READ_ALREADY_DELETED` rather than silently refreshing `deleted_at`.
 * Refreshing would extend the retention window on every retry and let a record
 * evade purge indefinitely.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {string} [options.actor] - Admin subject / API key id performing the delete.
 * @param {string} [options.reason] - Operator justification (stored for audit).
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope for the tombstoned record.
 * @throws {Error} `INVALID_INVOICE_ID` (400), `ESCROW_READ_NOT_FOUND` (404), or
 *   `ESCROW_READ_ALREADY_DELETED` (409).
 */
async function softDeleteEscrowRead(invoiceId, options = {}) {
  const { actor = null, reason = null, dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidInvoiceId(invoiceId);

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No escrow-read record found for invoice '${safeId}'`
    );
  }
  if (_toEpochMs(row.deleted_at) !== null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      `Escrow-read record for invoice '${safeId}' is already deleted`,
      { deletedAt: new Date(_toEpochMs(row.deleted_at)).toISOString() }
    );
  }

  const deletedAtIso = new Date(now).toISOString();

  // Guarded by `deleted_at IS NULL` so two concurrent deletes cannot both
  // stamp the row — the loser updates 0 rows and reports ALREADY_DELETED.
  const updated = await dbClient(PROJECTION_TABLE)
    .where('invoice_id', safeId)
    .whereNull('deleted_at')
    .update({
      deleted_at: deletedAtIso,
      deleted_by: actor,
      delete_reason: reason,
    });

  if (updated === 0) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      `Escrow-read record for invoice '${safeId}' is already deleted`
    );
  }

  // Cached summaries would keep serving the record we just hid.
  await invalidateEscrowReadCache(safeId);

  logger.info(
    { invoiceId: safeId, actor, reason, deletedAt: deletedAtIso },
    'escrowReadSoftDelete: escrow-read record soft-deleted'
  );

  return _toSoftDeleteState(
    {
      ...row,
      deleted_at: deletedAtIso,
      deleted_by: actor,
      delete_reason: reason,
    },
    { now }
  );
}

/**
 * Restores a soft-deleted escrow-read record, provided its retention window
 * has not elapsed.
 *
 * The window is evaluated against `deleted_at`, not against whether the purge
 * job has run. A record whose window expired is refused with
 * `ESCROW_READ_RETENTION_EXPIRED` even while the row is still physically
 * present, so the API contract does not drift with job scheduling.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {string} [options.actor] - Admin subject / API key id performing the restore.
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope for the restored (live) record.
 * @throws {Error} `INVALID_INVOICE_ID` (400), `ESCROW_READ_NOT_FOUND` (404),
 *   `ESCROW_READ_NOT_DELETED` (409), or `ESCROW_READ_RETENTION_EXPIRED` (410).
 */
async function restoreEscrowRead(invoiceId, options = {}) {
  const { actor = null, dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidInvoiceId(invoiceId);
  const retentionMs = getRetentionMs();

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No escrow-read record found for invoice '${safeId}'. It may have been purged after its retention window.`
    );
  }

  const deletedMs = _toEpochMs(row.deleted_at);
  if (deletedMs === null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_DELETED,
      409,
      `Escrow-read record for invoice '${safeId}' is not deleted`
    );
  }

  if (isRetentionExpired(row.deleted_at, { now, retentionMs })) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      410,
      `Retention window for invoice '${safeId}' expired at ${new Date(deletedMs + retentionMs).toISOString()}; the record can no longer be restored.`,
      {
        deletedAt: new Date(deletedMs).toISOString(),
        purgeAfter: new Date(deletedMs + retentionMs).toISOString(),
      }
    );
  }

  const restoredAtIso = new Date(now).toISOString();

  // `whereNotNull('deleted_at')` makes the restore a no-op if a concurrent
  // restore already cleared the tombstone.
  const updated = await dbClient(PROJECTION_TABLE)
    .where('invoice_id', safeId)
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
      restored_at: restoredAtIso,
      restored_by: actor,
    });

  if (updated === 0) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_DELETED,
      409,
      `Escrow-read record for invoice '${safeId}' is not deleted`
    );
  }

  // The tombstoned read may have been cached as a neutral `not_found` state.
  await invalidateEscrowReadCache(safeId);

  logger.info(
    { invoiceId: safeId, actor, restoredAt: restoredAtIso },
    'escrowReadSoftDelete: escrow-read record restored'
  );

  return _toSoftDeleteState(
    {
      ...row,
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
      restored_at: restoredAtIso,
      restored_by: actor,
    },
    { now }
  );
}

/**
 * Deletes one batch of expired tombstones.
 *
 * Selects the invoice IDs first and deletes by ID so the delete is bounded by
 * batch size on every engine (SQLite does not support `DELETE ... LIMIT`), and
 * so the purged IDs can be logged and returned.
 *
 * @param {object} params
 * @param {import('knex').Knex} params.dbClient - Knex instance.
 * @param {string} params.cutoffIso - ISO timestamp; tombstones strictly older
 *   than this are purged.
 * @param {number} params.batchSize - Maximum rows to delete.
 * @returns {Promise<{ deleted: number, invoiceIds: string[] }>} Batch result.
 */
async function _purgeBatch({ dbClient, cutoffIso, batchSize }) {
  const rows = await dbClient(PROJECTION_TABLE)
    .whereNotNull('deleted_at')
    .where('deleted_at', '<=', cutoffIso)
    .orderBy('deleted_at', 'asc')
    .limit(batchSize)
    .select('invoice_id');

  const invoiceIds = (rows || [])
    .map((row) => row && row.invoice_id)
    .filter((id) => typeof id === 'string');

  if (invoiceIds.length === 0) {
    return { deleted: 0, invoiceIds: [] };
  }

  const deleted = await dbClient(PROJECTION_TABLE)
    .whereIn('invoice_id', invoiceIds)
    .whereNotNull('deleted_at')
    .del();

  return { deleted: Number(deleted) || 0, invoiceIds };
}

/**
 * Maintenance task: hard-deletes tombstoned escrow-read records whose
 * retention window has elapsed.
 *
 * Only rows with `deleted_at <= now - retention` are eligible, so a live
 * record can never be purged and a freshly deleted one always keeps its full
 * window. Work is batch-bounded (`batchSize` × `maxBatches`) to keep
 * transactions short; a remaining backlog is picked up by the next run and
 * reported via `maxBatchesReached`.
 *
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @param {number} [options.batchSize=getPurgeBatchSize()] - Rows per batch.
 * @param {number} [options.maxBatches=getPurgeMaxBatches()] - Batch cap per run.
 * @returns {Promise<{ purged: number, batches: number, cutoff: string,
 *   retentionDays: number, maxBatchesReached: boolean, invoiceIds: string[] }>}
 *   Purge summary.
 */
async function purgeExpiredSoftDeletes(options = {}) {
  const {
    dbClient = db,
    now = Date.now(),
    batchSize = getPurgeBatchSize(),
    maxBatches = getPurgeMaxBatches(),
  } = options;

  const retentionMs = getRetentionMs();
  const cutoffIso = new Date(now - retentionMs).toISOString();

  let purged = 0;
  let batches = 0;
  const invoiceIds = [];

  while (batches < maxBatches) {
    const batch = await _purgeBatch({ dbClient, cutoffIso, batchSize });
    if (batch.deleted === 0) {
      break;
    }

    purged += batch.deleted;
    invoiceIds.push(...batch.invoiceIds);
    batches += 1;

    // A short batch means the eligible set is exhausted.
    if (batch.invoiceIds.length < batchSize) {
      break;
    }
  }

  // Purged invoices must not linger in the read caches as stale summaries.
  await Promise.all(invoiceIds.map((id) => invalidateEscrowReadCache(id)));

  const summary = {
    purged,
    batches,
    cutoff: cutoffIso,
    retentionDays: Math.round(retentionMs / MS_PER_DAY),
    maxBatchesReached: batches >= maxBatches,
    invoiceIds,
  };

  if (purged > 0) {
    logger.info(summary, 'escrowReadSoftDelete: purged expired escrow-read tombstones');
  } else {
    logger.debug(summary, 'escrowReadSoftDelete: no expired escrow-read tombstones to purge');
  }

  return summary;
}

module.exports = {
  softDeleteEscrowRead,
  restoreEscrowRead,
  getEscrowReadDeletionState,
  purgeExpiredSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  PROJECTION_TABLE,
};
