'use strict';

/**
 * @fileoverview Instrumentation wrapper for persistence endpoints.
 *
 * Wraps an async Express handler so that every request records:
 *   - request duration (histogram, labelled by endpoint + status class)
 *   - a request count (counter, labelled by endpoint + status class)
 *   - an error count on failure (counter, labelled by endpoint + bounded cause)
 *   - a single structured log line (no PII: ids and outcome only)
 *
 * Labels are bounded via the normalize* helpers in ../metrics to keep
 * Prometheus time-series cardinality fixed.
 *
 * @module middleware/persistenceMetrics
 */

const {
  persistenceRequestDurationSeconds,
  persistenceRequestsTotal,
  persistenceRequestErrorsTotal,
  normalizePersistenceEndpoint,
  normalizePersistenceStatusClass,
  normalizePersistenceCause,
} = require('../metrics');
const logger = require('../logger');

/**
 * Records metrics and a structured log for one completed persistence request.
 *
 * Kept separate from {@link instrumentPersistence} so it can be unit-tested in
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
function recordPersistenceOutcome({ endpoint, statusCode, durationSeconds, error, req }) {
  const ep = normalizePersistenceEndpoint(endpoint);
  const statusClass = normalizePersistenceStatusClass(statusCode);

  persistenceRequestDurationSeconds.labels(ep, statusClass).observe(durationSeconds);
  persistenceRequestsTotal.labels(ep, statusClass).inc();

  const cause = normalizePersistenceCause(error, statusCode);
  if (cause !== 'none') {
    persistenceRequestErrorsTotal.labels(ep, cause).inc();
  }

  // Structured log â€” safe fields only. Never log file contents, file names,
  // buffers, or raw error messages that could contain user data.
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
    log.error(fields, 'persistence request failed');
  } else if (statusClass === '4xx') {
    log.warn(fields, 'persistence request rejected');
  } else {
    log.info(fields, 'persistence request completed');
  }
}

/**
 * Wraps an async persistence handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status
 * code is the one actually sent. If the handler throws, the error is recorded
 * and re-thrown to the next error middleware.
 *
 * @param {string} endpoint - Bounded endpoint label (see PERSISTENCE_ENDPOINT_ENUM).
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentPersistence(endpoint, handler) {
  return async function instrumentedPersistenceHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    // Single source of truth: record on response finish, when the final status
    // code is known. A thrown handler stashes its error on res.locals so the
    // finish listener can classify the cause consistently with that status.
    res.on('finish', () => {
      if (recorded) { return; }
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      recordPersistenceOutcome({
        endpoint,
        statusCode: res.statusCode,
        durationSeconds,
        error: res.locals && res.locals.persistenceError,
        req,
      });
    });

    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.locals) { res.locals.persistenceError = err; }
      return next(err);
    }
  };
}

module.exports = { instrumentPersistence, recordPersistenceOutcome };