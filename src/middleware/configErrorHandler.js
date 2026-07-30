'use strict';

/**
 * @fileoverview Shared error middleware for config validation and config-route failures.
 *
 * Produces the same structured RFC 7807-style response body that the config
 * validation helper used to emit directly, but now does so through Express error
 * middleware so config routes share the same serialization path.
 *
 * @module middleware/configErrorHandler
 */

const AppError = require('../errors/AppError');
const { getProblemType, getStandardTitle } = require('../utils/problemDetails');

/**
 * @param {unknown} error - The error thrown by a config route or validator.
 * @returns {boolean}
 */
function shouldHandle(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (error instanceof AppError || error.name === 'AppError') {
    return error.status === 400 || error.status === 404 || error.status === 409 || error.status === 422 || error.status === 429 || error.status === 500 || error.status === 503;
  }

  return false;
}

/**
 * Express error-handling middleware for config routes.
 *
 * Only handles errors that were explicitly raised as config validation failures
 * (via the shared validator) or as AppErrors coming from config routes. Other
 * errors are forwarded to the next middleware so the global error handler can
 * continue to process them.
 *
 * @param {Error|unknown} err - Thrown error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next middleware.
 * @returns {void}
 */
function configErrorHandler(err, req, res, next) {
  if (!shouldHandle(err)) {
    return next(err);
  }

  const status = err.status || 400;
  const body = {
    type: err.type || getProblemType(status),
    title: err.title || getStandardTitle(status),
    status,
    detail: err.detail || err.message || 'An error occurred while processing the request.',
    code: err.code,
  };

  if (err.instance !== undefined) {
    body.instance = err.instance;
  }

  if (err.fieldErrors !== undefined) {
    body.fieldErrors = err.fieldErrors;
  }

  if (err.retryable !== undefined) {
    body.retryable = err.retryable;
  }

  if (err.retryHint !== undefined) {
    body.retry_hint = err.retryHint;
  }

  res.setHeader('Content-Type', 'application/problem+json');
  return res.status(status).json(body);
}

module.exports = {
  configErrorHandler,
  shouldHandle,
};
