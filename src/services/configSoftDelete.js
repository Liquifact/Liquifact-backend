'use strict';

/**
 * @fileoverview Soft-delete, restore, and retention purge for runtime config
 * records (issue #31).
 *
 * Model
 * -----
 *   live       → `deleted_at IS NULL`. Served by default reads.
 *   tombstoned → `deleted_at` set. Excluded from default reads, restorable
 *                until the retention window expires.
 *   purged     → row physically removed by {@link purgeExpiredConfigSoftDeletes}
 *                once `deleted_at + retention window < now`. Not recoverable.
 *
 * The retention window is `CONFIG_SOFT_DELETE_RETENTION_DAYS` (default 30,
 * clamped to 1–3650). Restore is refused once the window has elapsed even if
 * the purge job has not run yet, so "restorable" never depends on job scheduling
 * luck — the window alone decides.
 *
 * @module services/configSoftDelete
 */

const db = require('../db/knex');
const logger = require('../logger');

/**
 * Table holding runtime config records.
 * @constant {string}
 */
const CONFIG_TABLE = 'runtime_config';

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
 * Error codes raised by this module.
 *
 * @constant {Readonly<Record<string, string>>}
 */
const SOFT_DELETE_ERRORS = Object.freeze({
  /** No config record exists for the given id. */
  NOT_FOUND: 'CONFIG_NOT_FOUND',
  /** Record is already tombstoned. */
  ALREADY_DELETED: 'CONFIG_ALREADY_DELETED',
  /** Restore was requested for a record that is not tombstoned. */
  NOT_DELETED: 'CONFIG_NOT_DELETED',
  /** Restore was requested after the retention window elapsed. */
  RETENTION_EXPIRED: 'CONFIG_RETENTION_EXPIRED',
  /** The provided id is not a valid UUID-like string. */
  INVALID_ID: 'CONFIG_INVALID_ID',
});

/**
 * Builds a tagged error with `code` and `status`.
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
 * @returns {number} Retention window in days, clamped to [1, 3650].
 */
function getRetentionDays() {
  const parsed = Number(process.env.CONFIG_SOFT_DELETE_RETENTION_DAYS);
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
 * Purge batch size (`CONFIG_PURGE_BATCH_SIZE`).
 *
 * @returns {number} Rows deleted per batch, clamped to [1, 10000].
 */
function getPurgeBatchSize() {
  const parsed = parseInt(process.env.CONFIG_PURGE_BATCH_SIZE, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_BATCH_SIZE;
  }
  return Math.min(parsed, MAX_PURGE_BATCH_SIZE);
}

/**
 * Maximum batches per purge run (`CONFIG_PURGE_MAX_BATCHES`).
 *
 * @returns {number} Max batches, clamped to [1, 1000].
 */
function getPurgeMaxBatches() {
  const parsed = parseInt(process.env.CONFIG_PURGE_MAX_BATCHES, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_MAX_BATCHES;
  }
  return Math.min(parsed, MAX_PURGE_MAX_BATCHES);
}

/**
 * Parses a timestamp column into epoch milliseconds.
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
 * Normalises a config row into the soft-delete envelope.
 *
 * @param {object} row - Raw `runtime_config` row.
 * @param {object} [options={}]
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @param {number} [options.retentionMs=getRetentionMs()] - Window override.
 * @returns {object} `{ id, section, tenantId, config, createdAt, deleted,
 *   deletedAt, deletedBy, deleteReason, restoredAt, restoredBy, purgeAfter,
 *   restorable, retentionDays }`.
 */
function _toSoftDeleteState(row, options = {}) {
  const { now = Date.now(), retentionMs = getRetentionMs() } = options;
  const deletedMs = _toEpochMs(row.deleted_at);
  const deleted = deletedMs !== null;

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(row.config);
  } catch (_) {
    parsedConfig = row.config;
  }

  return {
    id: row.id,
    section: row.section,
    tenantId: row.tenant_id,
    config: parsedConfig,
    createdAt: row.created_at,
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
 * Validates a config record ID is a non-empty string.
 *
 * @param {unknown} id - Candidate ID.
 * @returns {string} Trimmed, validated ID.
 * @throws {Error} `CONFIG_INVALID_ID` / 400 when validation fails.
 */
function _requireValidId(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.INVALID_ID,
      400,
      'Config record id must be a non-empty string'
    );
  }
  return id.trim();
}

/**
 * Loads a config row regardless of tombstone state.
 *
 * @param {string} safeId - Validated config record id.
 * @param {import('knex').Knex} dbClient - Knex instance.
 * @returns {Promise<object|null>} Raw row, or null when absent.
 */
async function _findRow(safeId, dbClient) {
  const row = await dbClient(CONFIG_TABLE)
    .where('id', safeId)
    .first();
  return row || null;
}

/**
 * Returns the soft-delete state of a config record.
 *
 * @param {string} id - Config record identifier.
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope.
 * @throws {Error} `CONFIG_INVALID_ID` (400) or `CONFIG_NOT_FOUND` (404).
 */
async function getConfigDeletionState(id, options = {}) {
  const { dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidId(id);

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No config record found for id '${safeId}'`
    );
  }
  return _toSoftDeleteState(row, { now });
}

/**
 * Persists a runtime config record to the database.
 * This is called from the config service when a config write is accepted.
 *
 * @param {object} params
 * @param {string} params.section - Config section name.
 * @param {object} params.config - The validated config payload.
 * @param {string} [params.tenantId=''] - Tenant identifier.
 * @param {string} [params.actor=null] - Admin subject / API key id.
 * @param {import('knex').Knex} [params.dbClient=db] - Knex instance (tests).
 * @returns {Promise<object>} The created config record (soft-delete envelope).
 */
async function persistConfig({ section, config, tenantId = '', actor = null, dbClient = db }) {
  const configJson = JSON.stringify(config);
  const configRecord = {
    section,
    config: configJson,
    tenant_id: tenantId,
  };

  const [insertedId] = await dbClient(CONFIG_TABLE).insert(configRecord);

  // Retrieve the inserted row — SQLite returns the raw id from insert;
  // better-sqlite3 returns the id directly.
  const rowId = typeof insertedId === 'object' && insertedId !== null ? insertedId.id : insertedId;

  const row = await dbClient(CONFIG_TABLE)
    .where('id', rowId || insertedId)
    .first();

  if (!row) {
    throw new Error('Failed to read back persisted config record');
  }

  logger.info(
    { id: row.id, section, tenantId, actor },
    'configSoftDelete: config record persisted'
  );

  return _toSoftDeleteState(row);
}

/**
 * Lists live (non-deleted) config records, optionally filtered by section.
 *
 * @param {object} [options={}]
 * @param {string} [options.section] - Optional section filter.
 * @param {string} [options.tenantId] - Optional tenant filter.
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @returns {Promise<object[]>} Array of soft-delete envelopes for live records.
 */
async function listActiveConfigs(options = {}) {
  const { section, tenantId, dbClient = db } = options;

  let query = dbClient(CONFIG_TABLE)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc');

  if (section) {
    query = query.andWhere('section', section);
  }
  if (tenantId) {
    query = query.andWhere('tenant_id', tenantId);
  }

  const rows = await query;
  return (rows || []).map((row) => _toSoftDeleteState(row));
}

/**
 * Soft-deletes a config record: marks it tombstoned so default reads exclude it.
 *
 * @param {string} id - Config record identifier.
 * @param {object} [options={}]
 * @param {string} [options.actor] - Admin subject / API key id.
 * @param {string} [options.reason] - Operator justification.
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope for the tombstoned record.
 * @throws {Error} `CONFIG_INVALID_ID` (400), `CONFIG_NOT_FOUND` (404), or
 *   `CONFIG_ALREADY_DELETED` (409).
 */
async function softDeleteConfig(id, options = {}) {
  const { actor = null, reason = null, dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidId(id);

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No config record found for id '${safeId}'`
    );
  }
  if (_toEpochMs(row.deleted_at) !== null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      `Config record '${safeId}' is already deleted`,
      { deletedAt: new Date(_toEpochMs(row.deleted_at)).toISOString() }
    );
  }

  const deletedAtIso = new Date(now).toISOString();

  const updated = await dbClient(CONFIG_TABLE)
    .where('id', safeId)
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
      `Config record '${safeId}' is already deleted`
    );
  }

  logger.info(
    { id: safeId, actor, reason, deletedAt: deletedAtIso },
    'configSoftDelete: config record soft-deleted'
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
 * Restores a soft-deleted config record, provided its retention window
 * has not elapsed.
 *
 * @param {string} id - Config record identifier.
 * @param {object} [options={}]
 * @param {string} [options.actor] - Admin subject / API key id.
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @returns {Promise<object>} Soft-delete envelope for the restored record.
 * @throws {Error} `CONFIG_INVALID_ID` (400), `CONFIG_NOT_FOUND` (404),
 *   `CONFIG_NOT_DELETED` (409), or `CONFIG_RETENTION_EXPIRED` (410).
 */
async function restoreConfig(id, options = {}) {
  const { actor = null, dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidId(id);
  const retentionMs = getRetentionMs();

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No config record found for id '${safeId}'. It may have been purged after its retention window.`
    );
  }

  const deletedMs = _toEpochMs(row.deleted_at);
  if (deletedMs === null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_DELETED,
      409,
      `Config record '${safeId}' is not deleted`
    );
  }

  if (isRetentionExpired(row.deleted_at, { now, retentionMs })) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      410,
      `Retention window for config record '${safeId}' expired at ${new Date(deletedMs + retentionMs).toISOString()}; the record can no longer be restored.`,
      {
        deletedAt: new Date(deletedMs).toISOString(),
        purgeAfter: new Date(deletedMs + retentionMs).toISOString(),
      }
    );
  }

  const restoredAtIso = new Date(now).toISOString();

  const updated = await dbClient(CONFIG_TABLE)
    .where('id', safeId)
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
      `Config record '${safeId}' is not deleted`
    );
  }

  logger.info(
    { id: safeId, actor, restoredAt: restoredAtIso },
    'configSoftDelete: config record restored'
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
 * @param {object} params
 * @param {import('knex').Knex} params.dbClient - Knex instance.
 * @param {string} params.cutoffIso - ISO timestamp; tombstones strictly older
 *   than this are purged.
 * @param {number} params.batchSize - Maximum rows to delete.
 * @returns {Promise<{ deleted: number, ids: string[] }>} Batch result.
 */
async function _purgeBatch({ dbClient, cutoffIso, batchSize }) {
  const rows = await dbClient(CONFIG_TABLE)
    .whereNotNull('deleted_at')
    .where('deleted_at', '<=', cutoffIso)
    .orderBy('deleted_at', 'asc')
    .limit(batchSize)
    .select('id');

  const ids = (rows || [])
    .map((row) => row && row.id)
    .filter((id) => typeof id === 'string');

  if (ids.length === 0) {
    return { deleted: 0, ids: [] };
  }

  const deleted = await dbClient(CONFIG_TABLE)
    .whereIn('id', ids)
    .whereNotNull('deleted_at')
    .del();

  return { deleted: Number(deleted) || 0, ids };
}

/**
 * Maintenance task: hard-deletes tombstoned config records whose retention
 * window has elapsed.
 *
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @param {number} [options.now=Date.now()] - Clock override (epoch ms).
 * @param {number} [options.batchSize=getPurgeBatchSize()] - Rows per batch.
 * @param {number} [options.maxBatches=getPurgeMaxBatches()] - Batch cap per run.
 * @returns {Promise<{ purged: number, batches: number, cutoff: string,
 *   retentionDays: number, maxBatchesReached: boolean, ids: string[] }>}
 *   Purge summary.
 */
async function purgeExpiredConfigSoftDeletes(options = {}) {
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
  const ids = [];

  while (batches < maxBatches) {
    const batch = await _purgeBatch({ dbClient, cutoffIso, batchSize });
    if (batch.deleted === 0) {
      break;
    }

    purged += batch.deleted;
    ids.push(...batch.ids);
    batches += 1;

    if (batch.ids.length < batchSize) {
      break;
    }
  }

  const summary = {
    purged,
    batches,
    cutoff: cutoffIso,
    retentionDays: Math.round(retentionMs / MS_PER_DAY),
    maxBatchesReached: batches >= maxBatches,
    ids,
  };

  if (purged > 0) {
    logger.info(summary, 'configSoftDelete: purged expired config tombstones');
  } else {
    logger.debug(summary, 'configSoftDelete: no expired config tombstones to purge');
  }

  return summary;
}

module.exports = {
  persistConfig,
  listActiveConfigs,
  softDeleteConfig,
  restoreConfig,
  getConfigDeletionState,
  purgeExpiredConfigSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  CONFIG_TABLE,
};