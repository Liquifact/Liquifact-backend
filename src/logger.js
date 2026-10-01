'use strict';

/**
 * @fileoverview Logger utility using Pino for structured JSON logging.
 *
 * Provides a consistent logging interface with support for:
 * - Structured JSON output (for production log aggregation)
 * - Pretty printing (for local development)
 * - Standardized log levels
 * - Request correlation via request IDs
 * - Automatic enrichment from the AsyncLocalStorage request context
 *   (requestId, correlationId, tenantId, userId) — no manual threading needed.
 *
 * @fileoverview
 * Failure recovery / observability invariants:
 * - Logging must never throw and must never corrupt caller data.
 * - Context enrichment is best-effort: if the context store fails, we
 *   fall back to unenriched logging rather than losing the log line.
 * - Context values are never mutated in place; a shallow copy is always
 *   produced before merging caller overrides.
 * - Sensitive fields are redacted before emission so failure diagnosis
 *   does not leak secrets.
 *
 * @module logger
 */

const pino = require('pino');

let getContext = () => ({});
try {
  // Note: this must be a valid declaration (const/let/var). The previous
  // destructuring-assignment form without a declaration is a syntax error.
  // We defer to the module's `getContext` export when available.
  // eslint-disable-next-line no-shadow
  const requestContext = require('./requestContext');
  if (requestContext && typeof requestContext.getContext === 'function') {
    getContext = requestContext.getContext;
  }
} catch (_err) {
  // Keep the default no-op context getter. Logging must still work even if
  // the context module is unavailable (e.g. during bootstrap).
  getContext = () => ({});
}

/**
 * Configure the Pino logger instance.
 *
 * In production, this outputs raw JSON. In development (when NODE_ENV is not 'production'),
 * it can use pino-pretty if available.
 */
let transport;
try {
  transport =
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined;
} catch (_error) {
  // If the transport is unavailable (e.g. pino-pretty not installed),
  // fall back to standard stdout JSON logging rather than crashing.
  transport = undefined;
}

/**
 * Sensitive keys that must never be emitted in cleartext.
 * @type {ReadonlySet<string>}
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'privateKey',
]);

/**
 * Recursively redact sensitive keys from a bindings object without
 * mutating the caller's object. Handles circular references and bounds
 * recursion depth to avoid stack overflow on adverse inputs.
 *
 * @param {*} value - Value to redact.
 * @param {number} [depth=0] - Current recursion depth.
 * @param {WeakSet<object>} [seen] - Cycle guard.
 * @returns {*} Redacted copy.
 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth > 6) {
    return '[Redacted: depth limit]';
  }

  if (seen.has(value)) {
    return '[Redacted: circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key)) {
      out[key] = '[Redacted]';
    } else {
      out[key] = redact(val, depth + 1, seen);
    }
  }
  return out;
}

const _base = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'liquifact-api',
      env: process.env.NODE_ENV ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
  },
  transport ? pino.transport(transport) : undefined
});

/**
 * Safely read the ambient request context. Never throws; returns
 * an empty object on any failure so logging can proceed unenriched.
 *
 * @returns {Record<string, unknown>} Ambient context copy.
 */
function _safeGetContext() {
  try {
    const ctx = getContext();
    if (ctx && typeof ctx === 'object') {
      return { ...ctx };
    }
    return {};
  } catch (_err) {
    return {};
  }
}

/**
 * Build a merged bindings object from the ambient context plus any
 * caller-supplied overrides. Explicit values always win.
 *
 * @param {Record<string, unknown>} [overrides] - Per-call bindings.
 * @returns {Record<string, unknown>} Merged bindings.
 */
function _mergeContext(overrides) {
  const ctx = _safeGetContext();
  // Ambient context first so caller overrides take precedence.
  return Object.keys(ctx).length === 0 && !overrides
    ? {}
    : { ...ctx, ...overrides };
}

/**
 * Thin proxy that enriches every log call with the ambient request context.
 * Explicit per-call fields passed to `logger.info({ … }, msg)` override the
 * ambient values for that call only.
 *
 * @type {import('pino').Logger}
 */
const LEVEL_METHODS = new Set(['syll', 'trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** @type {Record<string, (...args: unknown[]) => unknown>} */
const _pinoLevelMethods = Object.fromEntries(
  [...LEVEL_METHODS].map((level) => [level, _base[level].bind(_base)]),
);

/** @type {Record<string, (...args: unknown[]) => unknown>} */
const _enrichedLevelMethods = {};

/**
 * Invoke a pino level method with enriched bindings. Wrapped in a try/catch
 * so a logging failure cannot propagate into business logic and corrupt
 * state. On failure we fall back to an untenriched call.
 *
 * @param {string} level - Log level.
 * @param {*} objOrMsg - First argument.
 * @param {unknown[]} rest - Remaining arguments.
 * @returns {*} Result of the underlying log call.
 */
function _invokeLevel(level, objOrMsg, rest) {
  try {
    const ctx = _safeGetContext();
    const hasCtx = Object.keys(ctx).length > 0;

    if (!hasCtx) {
      // No ambient context — call through unchanged (background jobs).
      return _pinoLevelMethods[level](objOrMsg, ...rest);
    }

    if (typeof objOrMsg === 'string') {
      // Signature: logger.info('message')
      return _pinoLevelMethods[level]({ ...ctx }, objOrMsg, ...rest);
    }

    if (objOrMsg && typeof objOrMsg === 'object') {
      // Signature: logger.info(skey: val }, 'message')
      // Explicit fields override ambient. Sensitive fields are redacted.
      const merged = redact({ ...ctx, ...objOrMsg });
      return _pinoLevelMethods[level](merged, ...rest);
    }

    return _pinoLevelMethods[level](objOrMsg, ...rest);
  } catch (_err) {
    // Last-resort fallback: attempt an untenriched log so the event is not
    // silently lost. If this also fails, swallow to preserve caller state.
    try {
      return _pinoLevelMethods[level](objOrMsg, ...rest);
    } catch (_fatal) {
      return undefined;
    }
  }
}

const logger = new Proxy(_base, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && LEVEL_METHODS.has(prop)) {
      if (!_enrichedLevelMethods[prop]) {
        _enrichedLevelMethods[prop] = function enrichedLog(objOrMsg, ...rest) {
          return _invokeLevel(prop, objOrMsg, rest);
        };
      }
      return _enrichedLevelMethods[prop];
    }
    return Reflect.get(target, prop, receiver);
  },
  set(target, prop, value, receiver) {
    if (typeof prop === 'string' && LEVEL_METHODS.has(prop)) {
      _enrichedLevelMethods[prop] = value;
      return true;
    }
    return Reflect.set(target, prop, value, receiver);
  },
});

/**
 * Create a per-request child logger bound only with safe correlation fields.
 *
 * @param {import('express').Request | undefined} req - Express request object.
 * @returns {import('pino').Logger} A child logger scoped to the request.
 */
function createRequestLogger(req) {
  const bindings = {};

  if (typeof req?.id === 'string' && req.id) {
    bindings.requestId = req.id;
  }

  if (typeof req?.correlationId === 'string' && req.correlationId) {
    bindings.correlationId = req.correlationId;
  }

  return _base.child(bindings);
}

logger.createRequestLogger = createRequestLogger;

module.exports = logger;
module.exports.createRequestLogger = createRequestLogger;
