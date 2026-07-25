'use strict';

/**
 * @fileoverview Zod schemas for health endpoint query validation.
 *
 * Exposes:
 *  - `healthQuerySchema` — strict query schema (rejects unknown keys)
 *  - `validateHealthQuery` — Express middleware for query validation
 *  - `rejectBodyOnGet` — Express middleware to reject request bodies on GET requests
 *
 * @module schemas/health
 */

const { z } = require('zod');

/**
 * Health query schema — accepts empty object (no query params allowed)
 * but strictly rejects any unknown fields with a clear error message.
 *
 * @type {z.ZodObject<{}>}
 */
const healthQuerySchema = z.object({}).strict();

/**
 * Express middleware factory for validating health endpoint query parameters.
 *
 * Uses Zod to validate query parameters against `healthQuerySchema`.
 * Returns a 400 RFC 7807 Problem Details response on validation failure.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function validateHealthQuery(req, res, next) {
  const result = healthQuerySchema.safeParse(req.query);

  if (!result.success) {
    const fieldErrors = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      if (!fieldErrors[path]) {
        fieldErrors[path] = [];
      }
      fieldErrors[path].push(issue.message);
    }

    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Query parameters contain invalid or unknown fields.',
      instance: req.originalUrl,
      code: 'VALIDATION_ERROR',
      fieldErrors,
    });
  }

  next();
}

/**
 * Express middleware to reject request bodies on GET/HEAD requests.
 *
 * Health endpoints are read-only and should never accept request bodies.
 * This middleware checks if a body was parsed and returns 400 if present.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function rejectBodyOnGet(req, res, next) {
  // Only reject on GET/HEAD requests (health endpoints)
  if ((req.method === 'GET' || req.method === 'HEAD') && req.body && Object.keys(req.body).length > 0) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'GET/HEAD requests must not include a request body.',
      instance: req.originalUrl,
      code: 'INVALID_BODY_ON_GET',
      fieldErrors: {
        body: ['Request body is not allowed on GET/HEAD requests'],
      },
    });
  }

  next();
}

module.exports = {
  healthQuerySchema,
  validateHealthQuery,
  rejectBodyOnGet,
};