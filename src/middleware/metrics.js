'use strict';

const crypto = require('crypto');
const { httpRequestsTotal, httpRequestDurationSeconds } = require('../metrics/registry');

const digest = (text) => crypto.createHash('sha256').update(text).digest();

/**
 * Resolves a bounded route pattern for Prometheus labels so raw path parameters
 * (e.g. invoice IDs, addresses) never cause unbounded label cardinality.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveRoutePattern(req) {
  if (req.route && typeof req.route.path === 'string') {
    const base = req.baseUrl || '';
    const routePath = req.route.path;
    if (base && routePath === '/') {
      return base;
    }
    return `${base}${routePath}` || '/';
  }
  return 'unmatched';
}

/**
 * Records HTTP request count and duration using bounded route patterns.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function metricsMiddleware(req, res, next) {
  const startNs = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    const labels = {
      method: req.method,
      route: resolveRoutePattern(req),
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });

  next();
}

/**
 * Guards GET /metrics with Bearer token authentication.
 * Accepts METRICS_TOKEN if configured, otherwise falls back to ADMIN_API_TOKEN.
 * Fails closed with 503 when neither token is configured.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireMetricsAuth(req, res, next) {
  const expected = process.env.METRICS_TOKEN || process.env.ADMIN_API_TOKEN;
  if (!expected) {
    res.status(503).json({
      error: 'Metrics endpoint is not configured',
      code: 'METRICS_TOKEN_NOT_CONFIGURED',
    });
    return;
  }

  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
  const matches = crypto.timingSafeEqual(digest(match ? match[1] : ''), digest(expected));
  if (!match || !matches) {
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Metrics token required', code: 'UNAUTHORIZED' });
    return;
  }

  next();
}

// Marker for the route-table guard test.
requireMetricsAuth.requiredRoles = ['admin'];

module.exports = {
  metricsMiddleware,
  requireMetricsAuth,
  resolveRoutePattern,
};
