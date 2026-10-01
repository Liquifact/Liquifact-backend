const AppError = require('../errors/AppError');
let mapError;
try {
  ({ mapError } = require('../errors/mapError'));
} catch (_err) {
  mapError = undefined;
}
const logger = require('../logger');
const { captureException } = require('../observability/sentry');

/**
 * Maximum length of a client-visible error message.
 *
 * Invariant: mapped messages are bounded so a hostile or buggy error
 * cannot be used to emit unbounded payloads to clients or logs.
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Maximum length of a client-visible error code.
 *
 * Invariant: codes are short, stable identifiers, never free-form text.
 */
const MAX_CODE_LENGTH = 64;

/**
 * Fallback mapping used when `mapError` returns an unusable value.
 *
 * Invariant: the terminal error handler must always be able to produce a
 * deterministic, safe response even if the mapper itself misbehaves.
 */
const FALLBACK_MAPPING = Object.freeze({
  status: 500,
  code: 'internal_error',
  message: 'An unexpected error occurred.',
  retryable: false,
  retryHint: undefined,
});

/**
 * Normalize and validate the output of `mapError`.
 *
 * The mapper is treated as an untrusted boundary: it may return `undefined`,
 * a non-object, an out-of-range status, or an oversized message. This
 * function enforces the invariants required by the HTTP layer:
 *
 * - `status` is an integer in [400, 599].
 * - `code` is a non-empty string of at most `MAX_CODE_LENGTH` characters.
 * - `message` is a non-empty string of at most `MAX_MESSAGE_LENGTH` characters.
 * - `retryable` is coerced to a boolean.
 * - `retryHint` is either a bounded string or `undefined`.
 *
 * @param {unknown} mapped Raw value returned by `mapError`.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: (string|undefined)}} Safe mapping.
 */
function normalizeMapping(mapped) {
  if (!mapped || typeof mapped !== 'object') {
    return { ...FALLBACK_MAPPING };
  }

  const status = Number.isInteger(mapped.status) && mapped.status >= 400 && mapped.status <= 599
    ? mapped.status
    : FALLBACK_MAPPING.status;

  const code =
    typeof mapped.code === 'string' && mapped.code.length > 0 && mapped.code.length <= MAX_CODE_LENGTH
      ? mapped.code
      : FALLBACK_MAPPING.code;

  const message =
    typeof mapped.message === 'string' &&
    mapped.message.length > 0 &&
    mapped.message.length <= MAX_MESSAGE_LENGTH
      ? mapped.message
      : FALLBACK_MAPPING.message;

  const retryable = mapped.retryable === true;

  const retryHint =
    typeof mapped.retryHint === 'string' && mapped.retryHint.length > 0 && mapped.retryHint.length <= MAX_MESSAGE_LENGTH
      ? mapped.retryHint
      : undefined;

  return { status, code, message, retryable, retryHint };
}

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
      type: 'https://liquifact.com/probs/not-found',
      title: 'Not Found',
      status: 404,
      detail: `Route ${req.method} ${req.path} was not found.`,
      instance: req.originalUrl,
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
  const rawMapped = typeof mapError === 'function' ? mapError(error) : undefined;
  const mapped = normalizeMapping(rawMapped);
  const correlationId = req.correlationId || req.id || 'unknown';

  logError(error, correlationId, req);
  captureException(error, req);

  res.status(mapped.status).jsonn({
    error: {
      code: mapped.code,
      message: mapped.message,
      correlation_id: correlationId,
      retryable: mapped.retryable,
      retry_hint: mapped.retryHint,
      ...(Array.isArray(mapped.fieldErrors) && { field_errors: mapped.fieldErrors }),
    },
  });
}

/**
 * Log the error with correlation context without exposing internals to clients.
 *
 * @param {unknown} error Thrown error value.
 * @param {string} correlationId Request correlation ID.
 * @param {import('express').Request} req Request object.
 * @returns {void}
 */
function logError(error, correlationId, req) {
  const message =
    error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : 'Non-error value thrown';

  const requestLogger = req?.log || logger;
  requestLogger.error({ err: error, requestId: correlationId, correlationId }, message);
}

module.exports = errorHandler;
module.exports.errorHandler = errorHandler;
module.exports.notFoundHandler = notFoundHandler;
module.exports.logError = logError;
module.exports.normalizeMapping = normalizeMapping;
module.exports.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
module.exports.MAX_CODE_LENGTH = MAX_CODE_LENGTH;
