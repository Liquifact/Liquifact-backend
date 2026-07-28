'use strict';

const db = require('../db/knex');
const logger = require('../logger');
const { createAuditLog } = require('./auditLog');

const KYC_TABLE = 'kyc_records';

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_PURGE_BATCH_SIZE = 500;
const MAX_PURGE_BATCH_SIZE = 10000;
const DEFAULT_PURGE_MAX_BATCHES = 100;
const MAX_PURGE_MAX_BATCHES = 1000;

const SOFT_DELETE_ERRORS = Object.freeze({
  NOT_FOUND: 'KYC_WEBHOOK_NOT_FOUND',
  ALREADY_DELETED: 'KYC_WEBHOOK_ALREADY_DELETED',
  NOT_DELETED: 'KYC_WEBHOOK_NOT_DELETED',
  RETENTION_EXPIRED: 'KYC_WEBHOOK_RETENTION_EXPIRED',
  INVALID_SME_ID: 'INVALID_SME_ID',
});

function _softDeleteError(code, status, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function getRetentionDays() {
  const parsed = Number(process.env.KYC_WEBHOOK_SOFT_DELETE_RETENTION_DAYS);
  if (!Number.isFinite(parsed) || parsed < MIN_RETENTION_DAYS) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.min(Math.floor(parsed), MAX_RETENTION_DAYS);
}

function getRetentionMs() {
  return getRetentionDays() * MS_PER_DAY;
}

function getPurgeBatchSize() {
  const parsed = parseInt(process.env.KYC_WEBHOOK_PURGE_BATCH_SIZE, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PURGE_BATCH_SIZE;
  }
  return Math.min(parsed, MAX_PURGE_BATCH_SIZE);
}

function getPurgeMaxBatches() {
  const parsed = parseInt(process.env.KYC_WEBHOOK_PURGE_MAX_BATCHES, 10);
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
    smeId: row.sme_id,
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

function _requireValidSmeId(smeId) {
  if (!smeId || typeof smeId !== 'string' || smeId.trim().length === 0) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.INVALID_SME_ID,
      400,
      'smeId must be a non-empty string'
    );
  }
  return smeId.trim();
}

async function _findRow(smeId, dbClient) {
  const row = await dbClient(KYC_TABLE)
    .where('sme_id', smeId)
    .first();
  return row || null;
}

async function getKycWebhookDeletionState(smeId, options = {}) {
  const { dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidSmeId(smeId);

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No KYC webhook record found for SME '${safeId}'`
    );
  }
  return _toSoftDeleteState(row, { now });
}

async function softDeleteKycWebhook(smeId, options = {}) {
  const { actor = null, reason = null, dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidSmeId(smeId);

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No KYC webhook record found for SME '${safeId}'`
    );
  }
  if (_toEpochMs(row.deleted_at) !== null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.ALREADY_DELETED,
      409,
      `KYC webhook record for SME '${safeId}' is already deleted`,
      { deletedAt: new Date(_toEpochMs(row.deleted_at)).toISOString() }
    );
  }

  const deletedAtIso = new Date(now).toISOString();

  const updated = await dbClient(KYC_TABLE)
    .where('sme_id', safeId)
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
      `KYC webhook record for SME '${safeId}' is already deleted`
    );
  }

  logger.info(
    { smeId: safeId, actor, reason, deletedAt: deletedAtIso },
    'kycWebhookSoftDelete: record soft-deleted'
  );

  const beforeState = _toSoftDeleteState(row, { now });
  const afterState = _toSoftDeleteState(
    {
      ...row,
      deleted_at: deletedAtIso,
      deleted_by: actor,
      delete_reason: reason,
    },
    { now }
  );

  try {
    await createAuditLog({
      actor: actor || 'admin',
      action: 'DELETE',
      resourceType: 'kyc-webhook',
      resourceId: safeId,
      before: beforeState,
      after: afterState,
      metadata: { reason },
    });
  } catch (auditErr) {
    logger.warn({ smeId: safeId, error: auditErr.message }, 'Failed to record KYC webhook soft-delete audit log');
  }

  return afterState;
}

async function restoreKycWebhook(smeId, options = {}) {
  const { actor = null, dbClient = db, now = Date.now() } = options;
  const safeId = _requireValidSmeId(smeId);
  const retentionMs = getRetentionMs();

  const row = await _findRow(safeId, dbClient);
  if (!row) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_FOUND,
      404,
      `No KYC webhook record found for SME '${safeId}'. It may have been purged after its retention window.`
    );
  }

  const deletedMs = _toEpochMs(row.deleted_at);
  if (deletedMs === null) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.NOT_DELETED,
      409,
      `KYC webhook record for SME '${safeId}' is not deleted`
    );
  }

  if (isRetentionExpired(row.deleted_at, { now, retentionMs })) {
    throw _softDeleteError(
      SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      410,
      `Retention window for SME '${safeId}' expired at ${new Date(deletedMs + retentionMs).toISOString()}; the record can no longer be restored.`,
      {
        deletedAt: new Date(deletedMs).toISOString(),
        purgeAfter: new Date(deletedMs + retentionMs).toISOString(),
      }
    );
  }

  const restoredAtIso = new Date(now).toISOString();

  const updated = await dbClient(KYC_TABLE)
    .where('sme_id', safeId)
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
      `KYC webhook record for SME '${safeId}' is not deleted`
    );
  }

  logger.info(
    { smeId: safeId, actor, restoredAt: restoredAtIso },
    'kycWebhookSoftDelete: record restored'
  );

  const beforeState = _toSoftDeleteState(row, { now });
  const afterState = _toSoftDeleteState(
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

  try {
    await createAuditLog({
      actor: actor || 'admin',
      action: 'UPDATE',
      resourceType: 'kyc-webhook',
      resourceId: safeId,
      before: beforeState,
      after: afterState,
      metadata: { restoredAt: restoredAtIso },
    });
  } catch (auditErr) {
    logger.warn({ smeId: safeId, error: auditErr.message }, 'Failed to record KYC webhook restore audit log');
  }

  return afterState;
}

async function _purgeBatch({ dbClient, cutoffIso, batchSize }) {
  const rows = await dbClient(KYC_TABLE)
    .whereNotNull('deleted_at')
    .where('deleted_at', '<=', cutoffIso)
    .orderBy('deleted_at', 'asc')
    .limit(batchSize)
    .select('sme_id');

  const smeIds = (rows || [])
    .map((row) => row && row.sme_id)
    .filter((id) => typeof id === 'string');

  if (smeIds.length === 0) {
    return { deleted: 0, smeIds: [] };
  }

  const deleted = await dbClient(KYC_TABLE)
    .whereIn('sme_id', smeIds)
    .whereNotNull('deleted_at')
    .del();

  return { deleted: Number(deleted) || 0, smeIds };
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
  const smeIds = [];

  while (batches < maxBatches) {
    const batch = await _purgeBatch({ dbClient, cutoffIso, batchSize });
    if (batch.deleted === 0) {
      break;
    }

    purged += batch.deleted;
    smeIds.push(...batch.smeIds);
    batches += 1;

    for (const smeId of batch.smeIds) {
      try {
        await createAuditLog({
          actor: options.actor || 'system-purge',
          action: 'DELETE',
          resourceType: 'kyc-webhook',
          resourceId: smeId,
          before: { smeId, status: 'purged' },
          after: null,
          metadata: { cutoff: cutoffIso },
        });
      } catch (auditErr) {
        logger.warn({ smeId, error: auditErr.message }, 'Failed to record KYC webhook purge audit log');
      }
    }

    if (batch.smeIds.length < batchSize) {
      break;
    }
  }

  const summary = {
    purged,
    batches,
    cutoff: cutoffIso,
    retentionDays: Math.round(retentionMs / MS_PER_DAY),
    maxBatchesReached: batches >= maxBatches,
    smeIds,
  };

  if (purged > 0) {
    logger.info(summary, 'kycWebhookSoftDelete: purged expired KYC webhook tombstones');
  } else {
    logger.debug(summary, 'kycWebhookSoftDelete: no expired KYC webhook tombstones to purge');
  }

  return summary;
}

module.exports = {
  softDeleteKycWebhook,
  restoreKycWebhook,
  getKycWebhookDeletionState,
  purgeExpiredSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  KYC_TABLE,
};