'use strict';

/**
 * @fileoverview Instrumentation wrapper for the indexer endpoint.
 *
 * Wraps the async Express handler for GET /api/admin/indexer/events so that
 * every request records:
 *   - request duration (histogram, labelled by status class)
 *   - a request count (counter, labelled by status class)
 *   - an error count on failure (counter, labelled by bounded cause)
 *   - a single structured log line (no PII: outcome only)
 *
 * Labels are bounded to keep Prometheus time-series cardinality fixed.
 *
 * @module middleware/indexerMetrics
 */

const {
  indexerRequestDurationSeconds,
  indexerRequestsTotal,
  indexerRequestErrorsTotal,
  normalizeIndexerStatusClass,
  normalizeIndexerCause,
} = require('../metrics');
const logger = require('../logger');

/**
 * Records metrics and a structured log for one completed indexer request.
 *
 * Kept separate from {@link instrumentIndexer} so it can be unit-tested in
 * isolation against each status class without driving a full HTTP request.
 *
 * @param {object} params
 * @param {number} params.statusCode - Final HTTP status code.
 * @param {number} params.durationSeconds - Wall-clock duration in seconds.
 * @param {unknown} [params.error] - Error thrown by the handler, if any.
 * @param {import('express').Request} [params.req] - Request, for a scoped logger.
 * @returns {void}
 */
function recordIndexerOutcome({ statusCode, durationSeconds, error, req }) {
  const statusClass = normalizeIndexerStatusClass(statusCode);

  indexerRequestDurationSeconds.labels(statusClass).observe(durationSeconds);
  indexerRequestsTotal.labels(statusClass).inc();

  const cause = normalizeIndexerCause(error, statusCode);
  if (cause !== 'none') {
    indexerRequestErrorsTotal.labels(cause).inc();
  }

  // Structured log – safe fields only. Never log file contents, raw error messages,
  // or other data that could contain PII.
  const log = (req && typeof logger.createRequestLogger === 'function')
    ? logger.createRequestLogger(req)
    : logger;
  const fields = {
    statusClass,
    statusCode,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    cause,
  };

  if (statusClass === '5xx') {
    log.error(fields, 'indexer request failed');
  } else if (statusClass === '4xx') {
    log.warn(fields, 'indexer request rejected');
  } else {
    log.info(fields, 'indexer request completed');
  }
}

/**
 * Wraps the async indexer handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status
 * code is the one actually sent. If the handler throws, the error is recorded
 * and re-thrown to the next error middleware.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentIndexer(handler) {
  return async function instrumentedIndexerHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    // Single source of truth: record on response finish, when the final status
    // code is known. A thrown handler stashes its error on res.locals so the
    // finish listener can classify the cause consistently with that status.
    res.on('finish', () => {
      if (recorded) { return; }
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      recordIndexerOutcome({
        statusCode: res.statusCode,
        durationSeconds,
        error: res.locals && res.locals._error,
        req,
      });
    });

    try {
      await handler(req, res, next);
    } catch (err) {
      // Stash the error so the finish listener can classify it
      res.locals = res.locals || {};
      res.locals._error = err;
      next(err);
    }
  };
}

module.exports = {
  recordIndexerOutcome,
  instrumentIndexer,
};
