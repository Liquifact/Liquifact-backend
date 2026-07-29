'use strict';

/**
 * CORS Observability Middleware.
 *
 * Instruments requests passing through CORS evaluation with duration histograms,
 * request counters, and error cause metrics. Also emits structured log lines
 * without exposing sensitive PII.
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
 * Express middleware that instruments requests for CORS observability.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function corsObservability(req, res, next) {
  const startTime = process.hrtime.bigint();

  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    const durationSec = durationMs / 1000;
    const statusCode = res.statusCode;
    const outcome = classifyCorsOutcome(statusCode);
    const statusClass = classifyCorsStatusClass(statusCode);
    const errorCause = classifyCorsErrorCause(statusCode, res);

    const histogram = metrics.corsRequestDurationSeconds;
    if (histogram && typeof histogram.observe === 'function') {
      histogram.observe(
        { status: String(statusCode), outcome, status_class: statusClass },
        durationSec,
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

    const logPayload = {
      method: req.method,
      path: req.path,
      status: statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      outcome,
      status_class: statusClass,
    };

    if (statusCode >= 400) {
      logPayload.error_cause = errorCause;
      logger.warn(logPayload, 'CORS evaluated request completed with error');
    } else {
      logger.info(logPayload, 'CORS evaluated request completed successfully');
    }
  });

  next();
}

module.exports = {
  corsObservability,
  classifyCorsOutcome,
  classifyCorsStatusClass,
  classifyCorsErrorCause,
};
