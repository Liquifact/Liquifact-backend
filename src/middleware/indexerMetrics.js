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
 * Maximum acceptable duration (seconds) recorded into the histogram.
 *
 * A wrapped handler that hangs or a clock that jumps backwards can yield a
 * non-finite or absurdly large duration. Prometheus histograms are sensitive
 * to NaN / Infinity observations (they corrupt quantile aggregation), so we
 * clamp to a bounded range and never observe a non-finite value.
 *
 * @type {number}
 */
const MAX_DURATION_SECONDS = 1000;

/**
 * Normalizes a raw duration into a finite, non-negative, bounded seconds
 * value suitable for a histogram observation.
 *
 * @param {number} durationSeconds - Raw duration in seconds.
 * @returns {number} Bounded duration in seconds.
 */
function normalizeDuration(durationSeconds) {
  const numeric = Number(durationSeconds);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.min(numeric, MAX_DURATION_SECONDS);
}

/**
 * Validates a raw HTTP status code into a bounded integer in [100, 599].
 *
 * Express may leave `res.statusCode` at its default (200) or a handler may
 * set an out-of-range value. Prometheus label values must be bounded, so we
 * reject anything outside the valid HTTP range and fall back to 500, which
 * classifies as '5xx' and surfaces the anomaly rather than hiding it.
 *
 * @param {unknown} statusCode - Raw status code.
 * @returns {number} A valid HTTP status code.
 */
function normalizeStatusCode(statusCode) {
  const numeric = Number(statusCode);
  if (!Number.isInteger(numeric) || numeric < 100 || numeric > 599) {
    return 500;
  }
  return numeric;
}

/**
 * Records metrics and a structured log for one completed indexer request.
 *
 * Kept separate from {@link instrumentIndexer} so it can be unit-tested in
 * isolation against each status class without driving a full HTTP request.
 *
 * Invariants:
 *   - Exactly one duration observation and one request count increment.
 *   - The error counter is incremented at most once, and only for a bounded
 *     cause other than 'none'.
 *   - No PII is logged: only bounded labels and a numeric duration.
 *
 * @param {object} params
 * @param {number} params.statusCode - Final HTTP status code.
 * @param {number} params.durationSeconds - Wall-clock duration in seconds.
 * @param {unknown} [params.error] - Error thrown by the handler, if any.
 * @param {import('express').Request} [params.req] - Request, for a scoped logger.
 * @returns {void}
 */
function recordIndexerOutcome({ statusCode, durationSeconds, error, req }) {
  const safeStatusCode = normalizeStatusCode(statusCode);
  const statusClass = normalizeIndexerStatusClass(safeStatusCode);
  const boundedDuration = normalizeDuration(durationSeconds);

  indexerRequestDurationSeconds.labels(statusClass).observe(boundedDuration);
  indexerRequestsTotal.labels(statusClass).inc();

  const cause = normalizeIndexerCause(error, safeStatusCode);
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
    statusCode: safeStatusCode,
    durationSeconds: Number(boundedDuration.toFixed(6)),
    cause,
  };

  if (boundedStatusClass === '5xx') {
    log.error(fields, 'indexer request failed');
  } else if (boundedStatusClass === '4xx') {
    log.warn(fields, 'indexer request rejected');
  } else {
    log.info(fields, 'indexer request completed');
  }
}

/**
 * Wraps the async indexer handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status&
 * code is the one actually sent. If the handler throws, the error is recorded
 * and re-thrown to the next error middleware.
 *
 * Invariants:
 *   - Exactly one outcome is recorded per request, even if `finish` and
 *     `close` both fire or the handler throws after the response finished.
 *   - The outcome is recorded on `finish` when the response was sent, and on
 *     `close` when the connection died before a response could be sent, so a
 *     client disconnect never silently drops the metric.
 *   - A thrown error is stashed on `ress.locals` for classification and is
 *     always forwarded to `next`.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentIndexer(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('instrumentIndexer requires a handler function');
  }

  return async function instrumentedIndexerHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    // Ensure locals exists before any listener can read it, so the finish
    // handler never observes an undefined stash on early-finished responses.
    res.locals = res.locals || {};

    // Single source of truth: record on response finish, when the final status
    // code is known. A thrown handler stashes its error on res.locals so the
    // finish listener can classify the cause consistently with that status.
    const finalize = () => {
      if (recorded) { return; }
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      recordIndexerOutcome({
        statusCode: res.statusCode,
        durationSeconds,
        error: res.locals && res.locals._error,
        req,
      });
    };

    res.on('finish', finalize);
    // A client disconnect can fire `close` without ever firing `finish`.
    // Record on close too, guarded by the same flag, so the outcome is never
    // double-counted and never lost.
    res.on('close', finalize);

    try {
      await handler(req, res, next);
    } catch (err) {
      // Stash the error so the finish listener can classify it. Preserve any
      // existing locals so we do not clobber upstream state.
      res.locals._error = err;
      // Ensure the outcome is recorded even if the error middleware never sends a
      // response (e.g. a crash or a stream that never ends). The `finish`
      // listener will still record once the response actually finishes.
      next(err);
    }
  };
}

module.exports = {
  normalizeDuration,
  normalizeStatusCode,
  recordIndexerOutcome,
  instrumentIndexer,
  knownStatusClasses: KNOWN_STATUS_CLASSES,
};
