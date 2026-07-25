'use strict';

/**
 * @fileoverview Shared validation helper for metrics route handlers.
 *
 * Extracts the common preamble that every metrics handler must execute:
 *   1. Resolve `userId` from the JWT payload (`req.user.id` or `req.user.sub`).
 *   2. Resolve `tenantId` from the request context (`req.tenantId`).
 *   3. Guard against a missing tenant context, responding with a uniform
 *      `400 Bad Request` when tenant information is absent.
 *
 * By centralising this logic the preamble is tested once and each handler
 * simply calls the helper instead of repeating it inline.
 *
 * @module utils/metricsValidation
 */

/**
 * @typedef {object} MetricsContext
 * @property {string} userId   - Resolved user identifier from the JWT payload.
 * @property {string} tenantId - Resolved tenant identifier from the request.
 */

/**
 * Validates the common metrics request context and writes a 400 response when
 * the tenant context is missing.
 *
 * Returns a {@link MetricsContext} object when validation passes, or `null`
 * when a response has already been sent (the caller must `return` immediately).
 *
 * ### Usage
 *
 * ```js
 * router.get('/metrics', authenticateToken, extractTenant, async (req, res, next) => {
 *   try {
 *     const ctx = validateMetricsRequest(req, res);
 *     if (!ctx) return;          // 400 already sent
 *
 *     const { userId, tenantId } = ctx;
 *     // … business logic …
 *   } catch (err) {
 *     return next(err);
 *   }
 * });
 * ```
 *
 * ### Response contract (on failure)
 *
 * ```json
 * { "error": "Bad Request", "message": "Missing tenant context" }
 * ```
 * HTTP status: `400`
 *
 * @param {import('express').Request}  req - Express request object.
 *   Must have `req.user` (populated by `authenticateToken`) and `req.tenantId`
 *   (populated by `extractTenant`).
 * @param {import('express').Response} res - Express response object.
 * @returns {MetricsContext|null} Validated context, or `null` if a 400 was sent.
 */
function validateMetricsRequest(req, res) {
  const userId = (req.user && (req.user.id || req.user.sub)) || '';
  const tenantId = req.tenantId || '';

  if (!tenantId) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Missing tenant context',
    });
    return null;
  }

  return { userId, tenantId };
}

module.exports = { validateMetricsRequest };
