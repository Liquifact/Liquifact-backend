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
const { toPersistenceRecordParams } = require('../dto/metrics');

/**
 * Records metrics and a structured log for one completed persistence request.
 *
 * Kept separate from {@link instrumentPersistence} so it can be unit-tested in
 * isolation against each status class without driving a full HTTP request.
 *
 * @param {PersistenceRecordParams} params - Already-normalised outcome data.
 *   Fields should be run through {@link toPersistenceRecordParams} before
 *   calling this function, or passed as raw values that will be coerced via
 *   the mapping function internally.
 * @returns {void}
 */
function recordPersistenceOutcome({ endpoint, statusCode, durationSeconds, error, req }) {
  // Map raw params through the typed DTO layer for safe field access.
  const params = toPersistenceRecordParams({
    endpoint: normalizePersistenceEndpoint(endpoint),
    statusCode,
    durationSeconds,
    cause: normalizePersistenceCause(error, statusCode),
    req,
  });

  const statusClass = normalizePersistenceStatusClass(params.statusCode);

  persistenceRequestDurationSeconds.labels(params.endpoint, statusClass).observe(params.durationSeconds);
  persistenceRequestsTotal.labels(params.endpoint, statusClass).inc();

  if (params.cause !== 'none') {
    persistenceRequestErrorsTotal.labels(params.endpoint, params.cause).inc();
  }

  // Structured log — safe fields only. Never log file contents, file names,
  // buffers, or raw error messages that could contain user data.
  const log = (params.req && typeof logger.createRequestLogger === 'function')
    ? logger.createRequestLogger(params.req)
    : logger;
  const fields = {
    endpoint: params.endpoint,
    statusClass,
    statusCode: params.statusCode,
    durationSeconds: Number(params.durationSeconds.toFixed(6)),
    cause: params.cause,
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