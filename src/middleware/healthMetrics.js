'use strict';

/**
 * @fileoverview Instrumentation wrapper for health endpoints.
 *
 * Wraps an async Express handler so that every request records:
 *   - request duration (histogram, labelled by endpoint + status class)
 *   - a request count (counter, labelled by endpoint + status class)
 *   - an error count on failure (counter, labelled by endpoint + bounded cause)
 *   - a single structured log line (no PII: endpoint and outcome only)
 *
 * Labels are bounded via the normalizeHealth* helpers in ../metrics to keep
 * Prometheus time-series cardinality fixed.
 *
 * @module middleware/healthMetrics
 */

const {
  healthRequestDurationSeconds,
  healthRequestsTotal,
  healthRequestErrorsTotal,
  normalizeHealthEndpoint,
  normalizeHealthStatusClass,
  normalizeHealthCause,
} = require('../metrics');
const logger = require('../logger');

/**
 * Records metrics and a structured log for one completed health request.
 *
 * Kept separate from {@link instrumentHealth} so it can be unit-tested in
 * isolation against each status class without driving a full HTTP request.
 *
 * @param {object} params
 * @param {string} params.endpoint - Raw endpoint hint (bounded on use).
 * @param {number} params.statusCode - Final HTTP status code.
 * @param {number} params.durationSeconds - Wall-clock duration in seconds.
 * @param {unknown} [params.error] - Error thrown by the handler, if any.
 * @param {import('express').Request} [params.req] - Request, for a scoped logger.
 * @returns {void}
 */
function recordHealthOutcome({ endpoint, statusCode, durationSeconds, error, req }) {
  const ep = normalizeHealthEndpoint(endpoint);
  const statusClass = normalizeHealthStatusClass(statusCode);

  healthRequestDurationSeconds.labels(ep, statusClass).observe(durationSeconds);
  healthRequestsTotal.labels(ep, statusClass).inc();

  const cause = normalizeHealthCause(error, statusCode);
  if (cause !== 'none') {
    healthRequestErrorsTotal.labels(ep, cause).inc();
  }

  // Structured log — safe fields only. Never log PII, dependency URLs,
  // or raw error messages that could contain sensitive data.
  const log = (req && typeof logger.createRequestLogger === 'function')
    ? logger.createRequestLogger(req)
    : logger;
  const fields = {
    endpoint: ep,
    statusClass,
    statusCode,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    cause,
  };

  if (statusClass === '5xx') {
    log.error(fields, 'health endpoint request failed');
  } else if (statusClass === '4xx') {
    log.warn(fields, 'health endpoint request rejected');
  } else {
    log.info(fields, 'health endpoint request completed');
  }
}

/**
 * Wraps an async health handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status
 * code is the one actually sent. If the handler throws, the error is recorded
 * and re-thrown to the next error middleware.
 *
 * @param {string} endpoint - Bounded endpoint label (see HEALTH_ENDPOINT_ENUM).
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentHealth(endpoint, handler) {
  return async function instrumentedHealthHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    // Single source of truth: record on response finish, when the final status
    // code is known. A thrown handler stashes its error on res.locals so the
    // finish listener can classify the cause consistently with that status.
    res.on('finish', () => {
      if (recorded) { return; }
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      recordHealthOutcome({
        endpoint,
        statusCode: res.statusCode,
        durationSeconds,
        error: res.locals && res.locals.healthError,
        req,
      });
    });

    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.locals) { res.locals.healthError = err; }
      return next(err);
    }
  };
}

module.exports = { instrumentHealth, recordHealthOutcome };
