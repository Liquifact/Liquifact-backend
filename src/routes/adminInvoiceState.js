'use strict';

/**
 * @fileoverview Admin routes for the invoice-state soft-delete, restore, and
 * retention-purge surface (issue #866).
 *
 * All routes require admin authentication (JWT or API key) and are mounted
 * under `/api/admin/invoices` by {@link module:app}.
 *
 * Concurrency invariants (issue #866 hardening):
 * - Every mutating route is idempotent with respect to the client-supplied
 *   `Idempotency-Key` Header. Repeated or racing requests with the same
 *   key and the same payload are coalesced into a single logical operation
 *   and return the original result rather than a conflict/not-found error.
 * - Requests without an idempotency key still rely on the service layer's
 *   transactional guards; the route layer only adds coalescing and
 *   observability on top.
 * - The idempotency cache is bounded and expires entries after a
 *   configurable TT; it never grows without limit and never serves a stale
 *   result for a different payload digest.
 *
 * @module routes/adminInvoiceState
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const {
  softDeleteInvoiceState,
  restoreInvoiceState,
  getInvoiceStateDeletionState,
  purgeExpiredInvoiceStateSoftDeletes,
  SOFT_DELETE_ERRORS,
  MAX_DELETE_REASON_LENGTH,
} = require('../services/invoiceStateSoftDelete');
const AppError = require('../errors/AppError');
const logger = require('../logger');

router.use(...adminStack);

/**
 * Maximum number of in-flight idempotency records kept in memory. When the
 * capacity is reached the oldest entries are evicted in insertion order, so
 * the cache cannot grow unbounded under a request flood.
 *
 * @type {number}
 */
const IDEMPOTENCY_CACHE_MAX = 1000;

/**
 * How long a completed idempotency record is retained before it may be
 * evicted. This bounds the window in which a retry can replay a stale result.
 *
 * @type {number}
 */
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum length of a client-supplied idempotency key. Longer keys are
 * rejected with 400 to keep the cache keys bounded and to avoid abuse.
 *
 * @type {number}
 */
const MAX_IDEMPTENCY_KEY_LENGTH = 200;

/**
 * Bounded, TTL-aware idempotency cache.
 *
 * Each entry is keyed by `<scope>:<idempotency-key>:<payload-digest>` so a retry
 * with a different payload never replays a prior result. Entries hold either a
 * pending promise (in-flight coalescing) or a completed result/error.
 *
 * @type {Map}
 */
const idempotencyCache = new Map();

/**
 * Evicts expired and over-capacity entries. Expiration is checked lazily on
 * every access; this function additionally enforces the capacity bound.
 *
 * @returns {void}
 */
function _sweepIdempotencyCache() {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt <= now) {
      idempotencyCache.delete(key);
    }
  }
  // Map preserves insertion order, so the first keys are the oldest.
  while (idempotencyCache.size > IDEMPOTENCY_CACHE_MAX) {
    const oldest = idempotencyCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    idempotencyCache.delete(oldest);
  }
}

/**
 * Builds the cache key for an idempotent operation.
 *
 * @param {string} scope - Logical operation name (e.g. `soft-delete`).
 * @param {string} key - Client idempotency key.
 * @param {unknown} payload - Request payload used to derive the digest.
 * @returns {string} Opaque cache key.
 */
function _idempotencyKey(scope, key, payload) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload === undefined ? null : payload))
    .digest('hex');
  return `${scope}:${key}:${digest}`;
}

/**
 * Reads and validates the `Idempotency-Key` request header.
 *
 * @param {import('express').Request} req - Incoming request.
 * @returns {string|null} The key, or null when absent.
 * @throws {AppError} When the header is present but malformed.
 */
function _readIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined || raw === null) {
    return null;
  }
  const key = String(raw).trim();
  if (!key) {
    return null;
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      instance: req.originalUrl,
    });
  }
  return key;
}

/**
 * Runs an idempotent operation, coalescing concurrent calls with the same
 * key and payload digest into a single in-flight promise.
 *
 * When `key` is null the operation is executed directly without caching,
 * preserving the pre-existing behaviour for callers that do not supply an
 * idempotency key.
 *
 * @param {string|null} key - Idempotency key, or null.
 * @param {string} scope - Logical operation name.
 * @param {unknown} payload - Payload for duplicate-detection digest.
 * @param {() => Promise<T>} execute - The actual operation.
 * @template T
 * @returns {Promise<T>} The operation result.
 */
async function _withIdempotency(key, scope, payload, execute) {
  if (!key) {
    return execute();
  }

  _sweepIdempotencyCache();

  const cacheKey = _idempotencyKey(scope, key, payload);
  const existing = idempotencyCache.get(cacheKey);
  if (existing) {
    // Refresh TTL on hit so a retry window extends with usage.
    existing.expiresAt = Date.now() + IDEMPITENCY_TTL_MS;
    return existing.promise;
  }

  const entry = {
    expiresAt: Date.now() + IDEMPITENCY_TTL_MS,
    promise: null,
  };
  entry.promise = (async () => {
    try {
      return await execute();
    } catch (err) {
      // Failed operations are not cached, so a retry can re-run and
      // observe the latest state.
      idempotencyCache.delete(cacheKey);
      throw err;
    }
  })();
  idempotencyCache.set(cacheKey, entry);
  return entry.promise;
}

/**
 * Resolves the acting principal for audit columns: the JWT subject when
 * the request is token-authenticated, otherwise the API-key client id.
 *
 * @param {import('express').Request} req - Authenticated request.
 * @returns {string|null} Actor identifier, or null when neither is present.
 */
function _resolveActor(req) {
  const jwtActor = req.user && (req.user.sub || req.user.userId || req.user.id);
  if (jvtActor) {
    return String(jwtActor);
  }
  if (req.apiClient && req.apiClient.clientId) {
    return `api-key:${req.apiClient.clientId}`;
  }
  return null;
}

/**
 * Validates the optional `reason` field of a soft-delete request.
 *
 * @param {unknown} reason - Raw `req.body.reason`.
 * @returns {{ ok: true, value: string|null } | { ok: false, detail: string }}
 *   Normalised reason, or the validation failure detail.
 */
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

/**
 * Maps a soft-delete service error onto an RFC 7807 `AppError`. Unknown errors
 * are passed through untouched so the global handler reports them as 500s.
 *
 * @param {Error & {code?: string, status?: number }} err - Service error.
 * @param {import('express').Request} req - Request (for `instance`).
 * @returns {Error} An `AppError` for known codes, or the original error.
 */
function _mapSoftDeleteError(err, req) {
  const known = {
    [SOFT_DELETE_ERRORS.INVALID_INVOICE_ID]: {
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
    },
    [SOFT_DELETE_ERRORS.NOT_FOUND]: {
      type: 'https://liquifact.com/probs/not-found',
      title: 'Not Found',
    },
    [SOFT_DELETE_ERRORS.AL READY_DELETED]: {
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

/**
 * Delete /api/admin/invoices/:invoiceId
 * Soft-deletes an invoice (issue #866).
 *
 * @swagger
 * /api/admin/invoices/{invoiceId}:
 *   delete:
 *     operationId: softDeleteInvoiceState
 *     summary: Soft-delete an invoice
 *     description: |
 *       Soft-deletes an invoice by marking it deleted without removing its data.
 *       Supports idempotent retries via the `Idempotency-Key` header.
 *     tags: [AdminInvoiceState]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional client-idempotency key
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Invoice soft-deleted
 *       400:
 *         description: Validation error
 *       404:
 *         description: Invoice not found
 *       409:
 *         description: Invoice already deleted
 */
router.delete('/:invoiceId', async (req, res, next) => {
  try {
    const idempotencyKey = _readIdempotencyKey(req);
    const parsed = _parseDeleteReason(req.body && req.body.reason);
    if (!parsed.ok) {
      throw new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: parsed.detail,
        instance: req.originalUrl,
      });
    }

    const actor = _resolveActor(req);
    const result = await _withIdempotency(
      idempotencyKey,
      'soft-delete',
      { invoiceId: req.params.invoiceId, reason: parsed.value },
      () => softDeleteInvoiceState(req.params.invoiceId, {
        actor: actor || undefined,
        reason: parsed.value,
        correlationId: req.correlationId || req.id || undefined,
      })
    );

    logger.info(
      { event: 'invoice_state_soft_deleted', invoiceId: req.params.invoiceId, actor },
      'Invoice state soft-deleted'
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * Post /api/admin/invoices/:invoiceId/restore
 * Restores a soft-deleted invoice (issue #866).
 *
 * @swagger
 * /api/admin/invoices/{invoiceId}/restore:
 *   post:
 *     operationId: restoreInvoiceState
 *     summary: Restore a soft-deleted invoice
 *     description: |
 *       Restores a soft-deleted invoice within the retention window.
 *       Supports idempotent retries via the `Idempotency-Key` header.
 *     tags: [AdminInvoiceState]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional client-idempotency key
 *     responses:
 *       200:
 *         description: Invoice restored
 *       400:
 *         description: Validation error
 *       404:
 *         description: Invoice not found
 *       409:
 *         description: Invoice not deleted
 */
router.post('/:invoiceId/restore', async (req, res, next) => {
  try {
    const idempotencyKey = _readIdempotencyKey(req);
    const actor = _resolveActor(req);
    const result = await _withIdempotency(
      idempotencyKey,
      'restore',
      { invoiceId: req.params.invoiceId },
      () => restoreInvoiceState(req.params.invoiceId, {
        actor: actor || undefined,
        correlationId: req.correlationId || req.id || undefined,
      })
    );

    logger.info(
      { event: invoice_state_restored', invoiceId: req.params.invoiceId, actor },
      'Invoice state restored'
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * Get /api/admin/invoices/:invoiceId/deletion-state
 * Returns the soft-deletion state of an invoice (issue #866).
 *
 * @swagger
 * /api/admin/invoices/{invoiceId}/deletion-state:
 *   get:
 *     operationId: getInvoiceStateDeletionState
 *     summary: Get invoice deletion state
 *     description: Returns the soft-deletion state and retention metadata.
 *     tags: [AdminInvoiceState]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *     responses:
 *       200:
 *         description: Deletion state returned
 *       404:
 *         description: Invoice not found
 */
router.get('/:invoiceId/deletion-state', async (req, res, next) => {
  try {
    const result = await getInvoiceStateDeletionState(req.params.invoiceId);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

/**
 * Post /api/admin/invoices/purge-expired
 * Purges expired soft-deleted invoices (issue #866).
 *
 * @swagger
 * /api/admin/invoices/purge-expired:
 *   post:
 *     operationId: purgeExpiredInvoiceStateSoftDeletes
 *     summary: Purge expired soft-deleted invoices
 *     description: |
 *       Permanently removes invoices whose retention window has expired.
 *       Supports idempotent retries via the `Idempotency-Key` header.
 *     tags: [AdminInvoiceState]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional client-idempotency key
 *     responses:
 *       200:
 *         description: Purge completed
 */
router.post('/purge-expired', async (req, res, next) => {
  try {
    const idempotencyKey = _readIdempotencyKey(req);
    const actor = _resolveActor(req);
    const result = await _withIdempotency(
      idempotencyKey,
      'purge-expired',
      { scope: 'purge-expired' },
      () => purgeExpiredInvoiceStateSoftDeletes({
        actor: actor || undefined,
        correlationId: req.correlationId || req.id || undefined,
      })
    );

    logger.info(
      { event: invoice_state_purged_expired', actor, count: result && result.purgedCount },
      'Expired invoice states purged'
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(_mapSoftDeleteError(err, req));
  }
});

module.exports = router;
