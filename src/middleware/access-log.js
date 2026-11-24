'use strict';

const defaultLogger = require('../logger');

/**
 * Creates an access logging middleware that emits a structured log entry on response finish.
 *
 * @param {object} [options]
 * @param {object} [options.logger] - Structured logger instance with .info()
 * @param {boolean} [options.enabled] - Explicit override to enable/disable logging
 * @returns {import('express').RequestHandler}
 */
function createAccessLogMiddleware(options = {}) {
  const logger = options.logger || defaultLogger;
  const isTest = process.env.NODE_ENV === 'test';
  const accessLogEnv = process.env.ACCESS_LOG === 'true' || process.env.ACCESS_LOG === '1';

  // Disabled in test environment by default unless explicitly enabled via ACCESS_LOG=true or options.enabled
  const isEnabled = options.enabled !== undefined
    ? Boolean(options.enabled)
    : (!isTest || accessLogEnv);

  return function accessLog(req, res, next) {
    if (!isEnabled) {
      return next();
    }

    const startHrTime = process.hrtime.bigint();

    res.on('finish', () => {
      const endHrTime = process.hrtime.bigint();
      const durationMs = Number((endHrTime - startHrTime) / 1000000n);

      // Route pattern only (req.route.path), never raw URL params or query strings
      const route = (req.route && typeof req.route.path === 'string')
        ? req.route.path
        : 'unmatched';

      const entry = {
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
      };

      const requestId = req.id || req.headers['x-request-id'];
      if (requestId) {
        entry.requestId = requestId;
      }

      logger.info('HTTP request completed', entry);
    });

    next();
  };
}

const accessLogMiddleware = createAccessLogMiddleware();

module.exports = {
  accessLogMiddleware,
  createAccessLogMiddleware,
};
