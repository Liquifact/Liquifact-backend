'use strict';

const express = require('express');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const {
  softDeleteKycWebhook,
  restoreKycWebhook,
  getKycWebhookDeletionState,
  purgeExpiredSoftDeletes,
  SOFT_DELETE_ERRORS,
} = require('../services/kycWebhookSoftDelete');
const { getAuditLogs } = require('../services/auditLog');
const { redactValue } = require('../services/auditLogStore');
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
    [SOFT_DELETE_ERRORS.INVALID_SME_ID]: {
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
    },
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

router.get('/webhooks/audit', async (req, res, next) => {
  try {
    const rawLimit = req.query.limit;
    const rawOffset = req.query.offset;
    const smeId = req.query.smeId || req.query.resourceId || null;
    const action = req.query.action || null;

    let limit = 20;
    if (rawLimit !== undefined) {
      const v = parseInt(rawLimit, 10);
      if (isNaN(v) || v < 1 || v > 100) {
        return next(new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'limit must be an integer between 1 and 100',
          instance: req.originalUrl,
        }));
      }
      limit = v;
    }

    let offset = 0;
    if (rawOffset !== undefined) {
      const v = parseInt(rawOffset, 10);
      if (isNaN(v) || v < 0) {
        return next(new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'offset must be a non-negative integer',
          instance: req.originalUrl,
        }));
      }
      offset = v;
    }

    const logs = await getAuditLogs({
      resourceType: 'kyc-webhook',
      resourceId: smeId,
      action,
      limit,
      offset,
    });

    const safeLogs = redactValue(logs);

    return res.json({
      data: safeLogs,
      meta: {
        limit,
        offset,
        count: safeLogs.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/webhooks/:smeId', async (req, res, next) => {
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
    const result = await softDeleteKycWebhook(req.params.smeId, {
      actor,
      reason: parsedReason.value,
    });

    logger.info(
      { smeId: result.smeId, actor, requestId: req.id },
      'Admin soft-deleted KYC webhook record'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

router.post('/webhooks/:smeId/restore', async (req, res, next) => {
  try {
    const actor = _resolveActor(req);
    const result = await restoreKycWebhook(req.params.smeId, { actor });

    logger.info(
      { smeId: result.smeId, actor, requestId: req.id },
      'Admin restored KYC webhook record'
    );
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

router.get('/webhooks/:smeId/deletion-state', async (req, res, next) => {
  try {
    const result = await getKycWebhookDeletionState(req.params.smeId);
    return res.json(result);
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

router.post('/webhooks/purge', async (req, res, next) => {
  try {
    const summary = await purgeExpiredSoftDeletes();
    logger.info(
      { purged: summary.purged, cutoff: summary.cutoff, requestId: req.id },
      'Admin triggered KYC webhook retention purge'
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