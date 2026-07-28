'use strict';

const express = require('express');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const {
  softDeleteMetricRecord,
  restoreMetricRecord,
  getMetricRecordDeletionState,
  purgeExpiredSoftDeletes,
  SOFT_DELETE_ERRORS,
} = require('../services/metricsSoftDelete');
const AppError = require('../errors/AppError');
const logger = require('../logger');

router.use(...adminStack);

const MAX_DELETE_REASON_LENGTH = 500;

function _resolveActor(req) {
  const jwtActor = req.user && (req.user.sub || req.user.userId || req.user.id);
  if (jwtActor) {
    return String(jwtActor);
  }
  if (req.apiClient && req.apiClient.clientId) {
    return `api-key:${req.apiClient.clientId}`;
  }
  return null;
}

function _parseDeleteReason(reason) {
  if (reason === undefined || reason === null || reason === '') {
    return { ok: true, value: null };
  }
  if (typeof reason !== 'string') {
    return { ok: false, detail: 'reason must be a string' };
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_DELETE_REASON_LENGTH) {
    return {
      ok: false,
      detail: `reason must be at most ${MAX_DELETE_REASON_LENGTH} characters`,
    };
  }
  return { ok: true, value: trimmed || null };
}

function _mapSoftDeleteError(err, req) {
  const known = {
    [SOFT_DELETE_ERRORS.NOT_FOUND]: {
      type: 'https://liquifact.com/probs/not-found',
      title: 'Not Found',
    },
    [SOFT_DELETE_ERRORS.ALREADY_DELETED]: {
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
    },
    [SOFT_DELETE_ERRORS.NOT_DELETED]: {
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
    },
    [SOFT_DELETE_ERRORS.RETENTION_EXPIRED]: {
      type: 'https://liquifact.com/probs/retention-expired',
      title: 'Retention Window Expired',
    },
  };

  const mapping = err && err.code ? known[err.code] : undefined;
  if (!mapping) {
    return err;
  }

  return new AppError({
    ...mapping,
    status: err.status || 400,
    detail: err.message,
    instance: req.originalUrl,
  });
}

router.delete('/records/:id', async (req, res, next) => {
  const parsedReason = _parseDeleteReason(req.body && req.body.reason);
  if (!parsedReason.ok) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: parsedReason.detail,
      instance: req.originalUrl,
    }));
  }

  try {
    const actor = _resolveActor(req);
    const result = await softDeleteMetricRecord(req.params.id, {
      actor,
      reason: parsedReason.value,
    });

    logger.info(
      { metricRecordId: result.id, actor, requestId: req.id },
      'Admin soft-deleted metric record'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

router.post('/records/:id/restore', async (req, res, next) => {
  try {
    const actor = _resolveActor(req);
    const result = await restoreMetricRecord(req.params.id, { actor });

    logger.info(
      { metricRecordId: result.id, actor, requestId: req.id },
      'Admin restored metric record'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

router.get('/records/:id/deletion-state', async (req, res, next) => {
  try {
    const result = await getMetricRecordDeletionState(req.params.id);
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

router.post('/records/purge', async (req, res, next) => {
  try {
    const summary = await purgeExpiredSoftDeletes();
    logger.info(
      { purged: summary.purged, cutoff: summary.cutoff, requestId: req.id },
      'Admin triggered metrics retention purge'
    );
    return res.json({
      purged: summary.purged,
      batches: summary.batches,
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays,
      maxBatchesReached: summary.maxBatchesReached,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
