const { AppError } = require('../errors/AppError');
const { mapError } = require('../errors/mapError');

/**
 * Express 404 handler that forwards a structured not-found error.
 *
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} _res Response object.
 * @param {import('express').NextFunction} next Next middleware.
 * @returns {void}
 */
function notFoundHandler(req, _res, next) {
  next(
    new AppError({
      status: 404,
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} was not found.`,
      retryable: false,
      retryHint: 'Verify the request path and method before trying again.',
    }),
  );
}

/**
 * Centralized terminal error handler.
 *
 * @param {unknown} error Thrown error value.
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} res Response object.
 * @param {import('express').NextFunction} _next Next middleware.
 * @returns {void}
 */
function errorHandler(error, req, res, _next) {
  const mapped = mapError(error);
  const correlationId = req.correlationId || 'unknown';

  logError(error, correlationId);

  res.status(mapped.status).json({
    error: {
      code: mapped.code,
      message: mapped.message,
      correlation_id: correlationId,
      retryable: mapped.retryable,
      retry_hint: mapped.retryHint,
    },
  });
}

/**
 * Log the error with correlation context without exposing internals to clients.
 *
 * @param {unknown} error Thrown error value.
 * @param {string} correlationId Request correlation ID.
 * @returns {void}
 */
function logError(error, correlationId) {
  const message =
    error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : 'Non-error value thrown';

  console.error(`[${correlationId}] ${message}`);
}

module.exports = {
  notFoundHandler,
  errorHandler,
  logError,
};
