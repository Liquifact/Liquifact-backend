'use strict';

/**
 * @fileoverview Instrumentation wrapper for invoice-state endpoints.
 *
 * Wraps an async Express handler so that every request records:
 *   - request duration (histogram, labelled by route + method + status class)
 *   - a request count (counter, labelled by route + method + status class)
 *   - a single structured log line (no PII — route, method, and outcome only)
 *
 * `invoiceStateRequestDurationMs` / `invoiceStateRequestCount` already existed
 * in `../metrics` but were never exported or wired into any route, so this
 * previously recorded nothing. This module connects them.
 *
 * Modelled on `middleware/healthMetrics.js` (the same
 * measure-on-`res.on('finish')` + bounded-label pattern, already used by the
 * `/ready` and `/readyz` routes) rather than `middleware/configMetrics.js`,
 * which currently imports several `../metrics` exports that don't exist.
 *
 * @module middleware/invoiceStateMetrics
 */

const { invoiceStateRequestDurationMs, invoiceStateRequestCount } = require('../metrics');
const logger = require('../logger');

/**
 * Classifies an HTTP status code into a fixed, low-cardinality bucket.
 *
 * @param {number} statusCode - HTTP response status code.
 * @returns {'2xx'|'3xx'|'4xx'|'5xx'|'other'}
 */
function normalizeStatusClass(statusCode) {
  if (statusCode >= 500) {return '5xx';}
  if (statusCode >= 400) {return '4xx';}
  if (statusCode >= 300) {return '3xx';}
  if (statusCode >= 200) {return '2xx';}
  return 'other';
}

/**
 * Classifies the error that ended a request into a fixed, low-cardinality
 * label. `StateTransitionError` (thrown by `services/invoiceStateService`)
 * already carries a bounded `code` (e.g. `INVOICE_NOT_FOUND`,
 * `CANNOT_LINK_TO_ESCROW`) — that code IS the cause. Anything else falls
 * back to a single `internal_error` bucket so an unexpected error's raw
 * message (which could contain arbitrary/sensitive detail) never becomes a
 * Prometheus label or a log field.
 *
 * @param {unknown} error - Error thrown by the handler, if any.
 * @returns {string} `'none'`, a `StateTransitionError` code, or `'internal_error'`.
 */
function normalizeErrorCause(error) {
  if (!error) {return 'none';}
  if (error.name === 'StateTransitionError' && typeof error.code === 'string' && error.code) {
    return error.code;
  }
  return 'internal_error';
}

/**
 * Records metrics and a structured log for one completed invoice-state
 * request. Kept separate from {@link instrumentInvoiceState} so it can be
 * unit-tested in isolation against each status class without driving a full
 * HTTP request.
 *
 * @param {object} params
 * @param {string} params.route - Bounded route label (e.g. `'state'`, `'transition'`).
 * @param {string} params.method - HTTP method (`req.method`).
 * @param {number} params.statusCode - Final HTTP status code.
 * @param {number} params.durationMs - Wall-clock duration in milliseconds.
 * @param {unknown} [params.error] - Error thrown by the handler, if any.
 * @param {import('express').Request} [params.req] - Request, for a scoped logger.
 * @returns {void}
 */
function recordInvoiceStateOutcome({ route, method, statusCode, durationMs, error, req }) {
  const statusClass = normalizeStatusClass(statusCode);
  const errorCause = normalizeErrorCause(error);

  invoiceStateRequestDurationMs.labels(route, method, statusClass, errorCause).observe(durationMs);
  invoiceStateRequestCount.labels(route, method, statusClass, errorCause).inc();

  // Structured log — safe fields only. Never log request bodies, invoice
  // identifiers, transition reasons, or raw error messages; `route` is the
  // bounded pattern (e.g. "/:id/state"), never the literal request path.
  const log = (req && typeof logger.createRequestLogger === 'function')
    ? logger.createRequestLogger(req)
    : logger;
  const fields = {
    route,
    method,
    statusClass,
    statusCode,
    durationMs: Number(durationMs.toFixed(3)),
    errorCause,
  };

  if (statusClass === '5xx') {
    log.error(fields, 'invoice-state request failed');
  } else if (statusClass === '4xx') {
    log.warn(fields, 'invoice-state request rejected');
  } else {
    log.info(fields, 'invoice-state request completed');
  }
}

/**
 * Wraps an async invoice-state handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status
 * code is the one actually sent. If the handler throws, the error is stashed
 * on `res.locals` for the finish listener to classify, then re-thrown to the
 * next error middleware — behaviour is otherwise unchanged.
 *
 * @param {string} route - Bounded route label, e.g. `'state'`, `'transition'`,
 *   `'approve'`, `'link-escrow'`, `'reject'`, `'history'`, `'bulk'`.
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentInvoiceState(route, handler) {
  return async function instrumentedInvoiceStateHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    res.on('finish', () => {
      if (recorded) { return; }
      recorded = true;
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      recordInvoiceStateOutcome({
        route,
        method: req.method,
        statusCode: res.statusCode,
        durationMs,
        error: res.locals && res.locals.invoiceStateMetricsError,
        req,
      });
    });

    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.locals) { res.locals.invoiceStateMetricsError = err; }
      return next(err);
    }
  };
}

module.exports = { instrumentInvoiceState, recordInvoiceStateOutcome, normalizeStatusClass, normalizeErrorCause };
