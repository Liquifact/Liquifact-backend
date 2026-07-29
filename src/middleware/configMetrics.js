'use strict';

const {
  configRequestDurationSeconds,
  configRequestsTotal,
  configRequestErrorsTotal,
  normalizeConfigEndpoint,
  normalizeConfigStatusClass,
  normalizeConfigCause,
} = require('../metrics');
/**
 * @fileoverview Instrumentation wrapper for config endpoints.
 *
 * Wraps an async Express handler so that every request records:
 *   - request duration (histogram, labelled by endpoint + status class)
 *   - a request count (counter, labelled by endpoint + status class)
 *   - an error count on failure (counter, labelled by endpoint + bounded cause)
 *   - a single structured log line (no PII: endpoint and outcome only)
 *
 * Labels are bounded via the normalizeConfig* helpers in ../metrics to keep
 * Prometheus time-series cardinality fixed.
 *
 * @module middleware/configMetrics
 */

const logger = require('../logger');

/**
 * Records metrics and a structured log for one completed config request.
 *
 * @param {object} params
 * @param {string} params.endpoint - Raw endpoint hint (bounded on use).
 * @param {number} params.statusCode - Final HTTP status code.
 * @param {number} params.durationSeconds - Wall-clock duration in seconds.
 * @param {unknown} [params.error] - Error thrown by the handler, if any.
 * @param {import('express').Request} [params.req] - Request, for a scoped logger.
 * @returns {void}
 */
function recordConfigOutcome({ endpoint, statusCode, durationSeconds, error, req }) {
  const ep = normalizeConfigEndpoint(endpoint);
  const statusClass = normalizeConfigStatusClass(statusCode);

  configRequestDurationSeconds.labels(ep, statusClass).observe(durationSeconds);
  configRequestsTotal.labels(ep, statusClass).inc();

  const cause = normalizeConfigCause(error, statusCode);
  if (cause !== 'none') {
    configRequestErrorsTotal.labels(ep, cause).inc();
  }

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
    log.error(fields, 'config endpoint request failed');
  } else if (statusClass === '4xx') {
    log.warn(fields, 'config endpoint request rejected');
  } else {
    log.info(fields, 'config endpoint request completed');
  }
}

/**
 * Wraps an async config handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status
 * code is the one actually sent. If the handler throws, the error is recorded
 * and re-thrown to the next error middleware.
 *
 * @param {string} endpoint - Bounded endpoint label (see CONFIG_ENDPOINT_ENUM).
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentConfig(endpoint, handler) {
  return async function instrumentedConfigHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    res.on('finish', () => {
      if (recorded) { return; }
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      recordConfigOutcome({
        endpoint,
        statusCode: res.statusCode,
        durationSeconds,
        error: res.locals && res.locals.configError,
        req,
      });
    });

    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.locals) { res.locals.configError = err; }
      return next(err);
    }
  };
}

module.exports = { instrumentConfig, recordConfigOutcome };
