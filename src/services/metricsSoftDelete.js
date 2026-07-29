'use strict';

const db = require('../db/knex');
const logger = require('../logger');

const METRICS_TABLE = 'metric_records';

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_PURGE_BATCH_SIZE = 500;
const MAX_PURGE_BATCH_SIZE = 10000;
const DEFAULT_PURGE_MAX_BATCHES = 100;
const MAX_PURGE_MAX_BATCHES = 1000;

const SOFT_DELETE_ERRORS = Object.freeze({
  NOT_FOUND: 'METRIC_RECORD_NOT_FOUND',
  ALREADY_DELETED: 'METRIC_RECORD_ALREADY_DELETED',
  NOT_DELETED: 'METRIC_RECORD_NOT_DELETED',
  RETENTION_EXPIRED: 'METRIC_RECORD_RETENTION_EXPIRED',
  INVALID_ID: 'INVALID_METRIC_RECORD_ID',
});

function _softDeleteError(code, status, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function getRetentionDays() {
  const parsed = Number(process.env.METRICS_SOFT_DELETE_RETENTION_DAYS);
  if (!Number.isFinite(parsed) || parsed < MIN_RETENTION_DAYS) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.min(Math.floor(parsed), MAX_RETENTION_DAYS);
}

function getRetentionMs() {
  return getRetentionDays() * MS_PER_DAY;
}

function getPurgeBatchSize() {
  const parsed = parseInt(process.env.METRICS_PURGE_BATCH_SIZE, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_BATCH_SIZE;
  }
  return Math.min(parsed, MAX_PURGE_BATCH_SIZE);
}

function getPurgeMaxBatches() {
  const parsed = parseInt(process.env.METRICS_PURGE_MAX_BATCHES, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_MAX_BATCHES;
  }
  return Math.min(parsed, MAX_PURGE_MAX_BATCHES);
}

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

function isRetentionExpired(deletedAt, options = {}) {
  const { now = Date.now(), retentionMs = getRetentionMs() } = options;
  const deletedMs = _toEpochMs(deletedAt);
  if (deletedMs === null) {
    return true;
  }
  return now - deletedMs >= retentionMs;
}

function _toSoftDeleteState(row, options = {}) {
  const { now = Date.now(), retentionMs = getRetentionMs() } = options;
  const deletedMs = _toEpochMs(row.deleted_at);
  const deleted = deletedMs !== null;

  return {
    id: row.id,
    metricName: row.metric_name,
    metricType: row.metric_type,
    metricValue: row.metric_value,
    labels: row.labels,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
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

async function _findRow(id, dbClient) {
  const row = await dbClient(METRICS_TABLE)
    .where('id', id)
    .first();
  return row || null;
}

async function getMetricRecordDeletionState(id, options = {}) {
  const { dbClient = db, now = Date.now() } = options;

  const row = await _findRow(id, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No metric record found for id '${id}'`
    );
  }
  return _toSoftDeleteState(row, { now });
}

async function softDeleteMetricRecord(id, options = {}) {
  const { actor = null, reason = null, dbClient = db, now = Date.now() } = options;

  const row = await _findRow(id, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No metric record found for id '${id}'`
    );
  }
  if (_toEpochMs(row.deleted_at) !== null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      `Metric record '${id}' is already deleted`,
      { deletedAt: new Date(_toEpochMs(row.deleted_at)).toISOString() }
    );
  }

  const deletedAtIso = new Date(now).toISOString();

  const updated = await dbClient(METRICS_TABLE)
    .where('id', id)
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
      `Metric record '${id}' is already deleted`
    );
  }

  logger.info(
    { metricRecordId: id, actor, reason, deletedAt: deletedAtIso },
    'metricsSoftDelete: metric record soft-deleted'
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

async function restoreMetricRecord(id, options = {}) {
  const { actor = null, dbClient = db, now = Date.now() } = options;
  const retentionMs = getRetentionMs();

  const row = await _findRow(id, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No metric record found for id '${id}'. It may have been purged after its retention window.`
    );
  }

  const deletedMs = _toEpochMs(row.deleted_at);
  if (deletedMs === null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_DELETED,
      409,
      `Metric record '${id}' is not deleted`
    );
  }

  if (isRetentionExpired(row.deleted_at, { now, retentionMs })) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      410,
      `Retention window for metric record '${id}' expired at ${new Date(deletedMs + retentionMs).toISOString()}; the record can no longer be restored.`,
      {
        deletedAt: new Date(deletedMs).toISOString(),
        purgeAfter: new Date(deletedMs + retentionMs).toISOString(),
      }
    );
  }

  const restoredAtIso = new Date(now).toISOString();

  const updated = await dbClient(METRICS_TABLE)
    .where('id', id)
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
      `Metric record '${id}' is not deleted`
    );
  }

  logger.info(
    { metricRecordId: id, actor, restoredAt: restoredAtIso },
    'metricsSoftDelete: metric record restored'
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

async function _purgeBatch({ dbClient, cutoffIso, batchSize }) {
  const rows = await dbClient(METRICS_TABLE)
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

  const deleted = await dbClient(METRICS_TABLE)
    .whereIn('id', ids)
    .whereNotNull('deleted_at')
    .del();

  return { deleted: Number(deleted) || 0, ids };
}

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
    logger.info(summary, 'metricsSoftDelete: purged expired metric tombstones');
  } else {
    logger.debug(summary, 'metricsSoftDelete: no expired metric tombstones to purge');
  }

  return summary;
}

module.exports = {
  softDeleteMetricRecord,
  restoreMetricRecord,
  getMetricRecordDeletionState,
  purgeExpiredSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  METRICS_TABLE,
};
