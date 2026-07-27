'use strict';

/**
 * @fileoverview Escrow-read observability helpers.
 *
 * Provides a single `recordEscrowRead` function that both escrow-read
 * endpoints (legacy /api/escrow/:invoiceId and V1 /v1/escrow/:invoiceId)
 * call at the end of every request.  It records:
 *
 *   - A Prometheus Counter (`escrow_read_requests_total`) labelled by
 *     endpoint and status.
 *   - A Prometheus Histogram (`escrow_read_request_duration_seconds`)
 *     for request duration.
 *   - A Prometheus Counter (`escrow_read_errors_total`) when the
 *     request results in a client or server error.
 *   - A structured Pino log entry at the appropriate level (info / warn /
 *     error) that includes the invoice ID, endpoint, status code, duration,
 *     and any error cause — but never any PII.
 *
 * @module services/escrowReadMetrics
 */

const logger = require('../logger');
const {
  escrowReadRequestsTotal,
  escrowReadRequestDurationSeconds,
  escrowReadErrorsTotal,
} = require('../metrics');

/**
 * Normalises an HTTP status code into a Prometheus-friendly label value.
 *
 * @param {number} statusCode - HTTP status code.
 * @returns {'success'|'client_error'|'server_error'}
 */
function statusLabel(statusCode) {
  if (statusCode < 400) { return 'success'; }
  if (statusCode < 500) { return 'client_error'; }
  return 'server_error';
}

/**
 * Derives a short error-cause label from the HTTP status code and optional
 * error object.  Returns `null` when there is no error (2xx).
 *
 * @param {number} statusCode - HTTP status code.
 * @param {Error|null} [err] - The error object, if any.
 * @returns {string|null} Error cause label or null.
 */
function errorCauseLabel(statusCode, err) {
  if (statusCode < 400) { return null; }
  if (statusCode === 404) { return 'not_found'; }
  if (statusCode === 400) { return 'bad_request'; }
  if (statusCode === 401 || statusCode === 403) { return 'auth'; }
  if (err && err.code) { return err.code; }
  if (statusCode >= 500) { return 'internal'; }
  return 'unknown';
}

/**
 * Records escrow-read telemetry and emits a structured log line.
 *
 * **Call after** the HTTP response has been sent (or is about to be sent)
 * so the actual status code is known.  Pass the wall-clock start time
 * so the duration is measured end-to-end including network and DB
 * round-trips.
 *
 * @param {object} params
 * @param {number} params.startTime - `Date.now()` captured at request start.
 * @param {string} params.invoiceId  - The invoice ID from the URL (no PII).
 * @param {'legacy'|'v1'} params.endpoint - Which escrow-read endpoint served.
 * @param {number} params.statusCode - HTTP status code of the response.
 * @param {Error|null} [params.err]  - The error object, if the request failed.
 * @returns {void}
 *
 * @example
 * const start = Date.now();
 * try {
 *   // ... handler logic ...
 *   res.status(200).json({ data });
 *   recordEscrowRead({ startTime: start, invoiceId, endpoint: 'v1', statusCode: 200 });
 * } catch (err) {
 *   res.status(500).json({ error: 'fail' });
 *   recordEscrowRead({ startTime: start, invoiceId, endpoint: 'v1', statusCode: 500, err });
 * }
 */
function recordEscrowRead({ startTime, invoiceId, endpoint, statusCode, err }) {
  const durationMs = Date.now() - startTime;
  const durationSec = durationMs / 1000;
  const status = statusLabel(statusCode);
  const errorCause = errorCauseLabel(statusCode, err || null);

  // ── Prometheus metrics ──────────────────────────────────────────────────

  escrowReadRequestsTotal.labels(endpoint, status).inc();
  escrowReadRequestDurationSeconds.labels(endpoint, status).observe(durationSec);

  if (errorCause) {
    escrowReadErrorsTotal.labels(endpoint, errorCause).inc();
  }

  // ── Structured log (no PII) ─────────────────────────────────────────────

  const logData = {
    invoiceId,
    endpoint,
    statusCode,
    durationMs: Math.round(durationMs),
  };

  if (errorCause) {
    logData.errorCause = errorCause;
  }
  if (err && err.message) {
    // Include error message for diagnostics; never log stack traces or PII.
    logData.errorMessage = err.message;
  }

  if (statusCode >= 500) {
    logger.error(logData, 'escrow-read: request failed');
  } else if (statusCode >= 400) {
    logger.warn(logData, 'escrow-read: client error');
  } else {
    logger.info(logData, 'escrow-read: request completed');
  }
}

module.exports = { recordEscrowRead };
