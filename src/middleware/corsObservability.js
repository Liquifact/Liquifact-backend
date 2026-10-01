'use strict';

/**
 * CORS Observability Middleware.
 *
 * Instruments requests passing through CORS evaluation with duration histograms,
 * request counters, and error cause metrics. Also emits structured log lines
 * without exposing sensitive PII.
 *
 * State invariants owned by this module:
 *   1. Exactly one observation is recorded per request, even if the response
 *      emits both 'finish' and 'close' (client abort) or 'finish' fires more
 *      than once due to double-ending. The guard is a one-shot flag.
 *   2. The final status code is snapshoted at the moment of observation and
 *      never mutated afterwards, so metric labels and log fields are consistent
 *      with each other.
 *   3. Observation is synchronous and cannot throw into the Express pipeline;
 *      metric/logger failures are swallowed and do not alter the response.
 *   4. No sensitive data (query string, headers, cookies, body) is logged.
 *
 * @module middleware/corsObservability
 */

const logger = require('../logger');
const metrics = require('../metrics');

/**
 * Classifies HTTP status code into an outcome metric label.
 * @param {number} statusCode - HTTP status code.
 * @returns {string} Outcome classification label.
 */
function classifyCorsOutcome(statusCode) {
  if (statusCode >= 200 && statusCode < 400) {return 'success';}
  if (statusCode >= 400 && statusCode < 500) {return 'client_error';}
  return 'server_error';
}

/**
 * Classifies HTTP status code into a status class metric label.
 * @param {number} statusCode - HTTP status code.
 * @returns {string} Status class label.
 */
function classifyCorsStatusClass(statusCode) {
  if (statusCode >= 200 && statusCode < 300) {return '2xx';}
  if (statusCode >= 300 && statusCode < 400) {return '3xx';}
  if (statusCode >= 400 && statusCode < 500) {return '4xx';}
  if (statusCode >= 500 && statusCode < 600) {return '5xx';}
  return 'unknown';
}

/**
 * Classifies error cause for CORS requests.
 * @param {number} statusCode - HTTP status code.
 * @param {import('express').Response} [res] - Express response object.
 * @returns {string} Error cause label.
 */
function classifyCorsErrorCause(statusCode, res) {
  if (res && res.locals && res.locals.isCorsOriginRejected) {
    return 'origin_rejected';
  }
  if (statusCode === 403) {return 'origin_rejected';}
  if (statusCode >= 400 && statusCode < 500) {return 'client_error';}
  if (statusCode >= 500) {return 'server_error';}
  return 'none';
}

/**
 * Records a single observation for a completed CORS-evaluated response.
 *
 * This is the only place where metrics and logs are emitted, so the
 * one-shot invariant is enforced by the caller and the classification is
 * derived exactly once from the snapshoted status code.
 *
 * @param {Object} observation - Observation payload.
 * @param {Object} observation.req - Express request object.
 * @param {Object} observation.res - Express response object.
 * @param {number} observation.statusCode - Snapshotted status code.
 * @param {number} observation.durationMs - Measured duration in milliseconds.
 * @returns {void}
 */
function recordObservation({ req, res, statusCode, durationMs }) {
  const outcome = classifyCorsOutcome(statusCode);
  const statusClass = classifyCorsStatusClass(statusCode);
  const errorCause = classifyCorsErrorCause(statusCode, res);

  try {
    const histogram = metrics.corsRequestDurationSeconds;
    if (histogram && typeof histogram.observe === 'function') {
      histogram.observe(
        { status: String(statusCode), outcome, status_class: statusClass },
        durationMs / 1000,
      );
    }

    const counter = metrics.corsRequestsTotal;
    if (counter && typeof counter.inc === 'function') {
      counter.inc({ status: String(statusCode), outcome, status_class: statusClass });
    }

    const errorCounter = metrics.corsRequestErrorsTotal;
    if (statusCode >= 400 && errorCause !== 'none' && errorCounter && typeof errorCounter.inc === 'function') {
      errorCounter.inc({ cause: errorCause, status_class: statusClass });
    }
  } catch (err) {
    // Metrics must never alter response semantics or throw into the pipeline.
    logger.debug({ err: err && err.message }, 'CORS observability metric recording failed');
  }

  const logPayload = {
    method: req.method,
    path: req.path,
    status: statusCode,
    duration_ms: Math.round(durationMs * 100) / 100,
    outcome,
    status_class: statusClass,
  };

  try {
    if (statusCode >= 400) {
      logPayload.error_cause = errorCause;
      logger.warn(logPayload, 'CORS evaluated request completed with error');
    } else {
      logger.info(logPayload, 'CORS evaluated request completed successfully');
    }
  } catch (err) {
    // Logging failures are non-fatal and must not affect the response.
  }
}

/**
 * Express middleware that instruments requests for CORS observability.
 *
 * The observation is emitted on the first of 'finish' or 'close'. The
 * one-shot guard ensures duplicate or overlapping terminal events (e.g. client
 * abort followed by finish) produce exactly one metric/log record.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function corsObservability(req, res, next) {
  const startTime = process.hrtime.bigint();
  let observed = false;

  const finalize = () => {
    if (observed) {return;}
    observed = true;

    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    // Snapshot the status code once so all derived labels are consistent.
    const statusCode = res.statusCode;

    recordObservation({ req, res, statusCode, durationMs });
  };

  res.once('finish', finalize);
  res.once('close', finalize);

  next();
}

module.exports = {
  corsObservability,
  classifyCorsOutcome,
  classifyCorsStatusClass,
  classifyCorsErrorCause,
};
