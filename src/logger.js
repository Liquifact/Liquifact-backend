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
 * @module logger
 */

const pino = require('pino');
const { get: getContext } = require('./requestContext');

/**
 * Configure the Pino logger instance.
 *
 * In production, this outputs raw JSON. In development (when NODE_ENV is not 'production'),
 * it can use pino-pretty if available.
 */
const transport =
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

const _base = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: 'liquifact-api',
      env: process.env.NODE_ENV || 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
  },
  transport ? pino.transport(transport) : undefined
);

/**
 * Build a merged bindings object from the ambient context plus any
 * caller-supplied overrides. Explicit values always win.
 *
 * @param {Record<string, unknown>} [overrides] - Per-call bindings.
 * @returns {Record<string, unknown>} Merged bindings.
 */
function _mergeContext(overrides) {
  const ctx = getContext();
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
const LEVEL_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** @type {Record<string, (...args: unknown[]) => unknown>} */
const _pinoLevelMethods = Object.fromEntries(
  [...LEVEL_METHODS].map((level) => [level, _base[level].bind(_base)]),
);

/** @type {Record<string, (...args: unknown[]) => unknown>} */
const _enrichedLevelMethods = {};

const logger = new Proxy(_base, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && LEVEL_METHODS.has(prop)) {
      if (!_enrichedLevelMethods[prop]) {
        _enrichedLevelMethods[prop] = function enrichedLog(objOrMsg, ...rest) {
          const ctx = getContext();
          const hasCtx = Object.keys(ctx).length > 0;

          if (!hasCtx) {
            // No ambient context — call through unchanged (background jobs).
            return _pinoLevelMethods[prop](objOrMsg, ...rest);
          }

          if (typeof objOrMsg === 'string') {
            // Signature: logger.info('message')
            return _pinoLevelMethods[prop]({ ...ctx }, objOrMsg, ...rest);
          }

          if (objOrMsg && typeof objOrMsg === 'object') {
            // Signature: logger.info({ key: val }, 'message')
            // Explicit fields override ambient.
            return _pinoLevelMethods[prop]({ ...ctx, ...objOrMsg }, ...rest);
          }

          return _pinoLevelMethods[prop](objOrMsg, ...rest);
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
