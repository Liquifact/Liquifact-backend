'use strict';

/**
 * @fileoverview Admin HTTP read endpoint for the metrics mutation audit log
 * (issue #872).
 *
 * ## Endpoint contract
 *
 * `GET /api/admin/metrics/audit`
 *
 * Returns the in-memory bounded ring buffer maintained by
 * {@link module:metricsAudit}.  Supports filtering by metric name, action,
 * and actor id, plus offset/limit pagination.  Pagination is clamped to
 * a hard ceiling (1000 records per request) to prevent memory pressure
 * on the Node.js process.
 *
 * ## Access control
 *
 * The route uses `adminStack` (JWT-or-API-key authentication followed by
 * tenant extraction) so that the audit data is only visible to
 * authenticated admin callers.  Tenant scoping is recorded but not used
 * to filter — the metrics audit log is a global, system-level view.
 *
 * @module routes/adminMetricsAudit
 */

const express = require('express');
const { adminStack } = require('../middleware/stacks');
const metricsAudit = require('../metricsAudit');

const router = express.Router();

// Apply admin auth + tenant extraction to every route.
router.use(...adminStack);

const VALID_ACTIONS = new Set(metricsAudit.METRIC_ACTIONS);
const METRIC_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_:.-]{0,199}$/;
const ACTOR_ID_PATTERN = /^[a-zA-Z0-9_.\-:@]{0,128}$/;
const MAX_LIMIT = 1000;
const MAX_OFFSET = 1_000_000;
const DEFAULT_LIMIT = 100;

/**
 * Coerces a query value into a clamped non-negative integer, falling back
 * to a default when the input is missing, non-numeric, or out of range.
 *
 * @param {unknown} value - Raw query value.
 * @param {number} defaultValue - Default to use when input is unusable.
 * @param {number} max - Upper clamp.
 * @returns {number}
 */
function clampQueryInt(value, defaultValue, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) { return defaultValue; }
  const floored = Math.floor(parsed);
  return floored > max ? max : floored;
}

/**
 * GET /api/admin/metrics/audit
 *
 * Query parameters (all optional):
 *   - metricName  string  — restrict to a single Prometheus metric name
 *   - action      CREATE|UPDATE|DELETE  — restrict to one lifecycle action
 *   - actorId     string  — restrict by actor identifier
 *   - limit       1..1000  — page size (default 100, capped at 1000)
 *   - offset      int      — page offset (default 0, must be >= 0)
 */
router.get('/', (req, res) => {
  const { metricName, action, actorId } = req.query;

  if (metricName !== undefined && (typeof metricName !== 'string' || !METRIC_NAME_PATTERN.test(metricName))) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Query parameter `metricName` must be a valid Prometheus metric name.',
      fieldErrors: { metricName: 'must match /^[a-zA-Z][a-zA-Z0-9_:.-]{0,199}$/' },
    });
  }

  if (action !== undefined && (typeof action !== 'string' || !VALID_ACTIONS.has(action))) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Query parameter `action` must be one of CREATE, UPDATE, or DELETE.',
      fieldErrors: { action: `must be one of: ${metricsAudit.METRIC_ACTIONS.join(', ')}` },
    });
  }

  if (actorId !== undefined && (typeof actorId !== 'string' || !ACTOR_ID_PATTERN.test(actorId))) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Query parameter `actorId` must be a short identifier string.',
      fieldErrors: { actorId: 'must match /^[a-zA-Z0-9_\\-:@]{0,128}$/' },
    });
  }

  const limit = clampQueryInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offsetRaw = Number(req.query.offset);
  let offset = 0;
  if (Number.isFinite(offsetRaw) && offsetRaw >= 0) {
    offset = Math.min(Math.floor(offsetRaw), MAX_OFFSET);
  }

  let page;
  try {
    page = metricsAudit.getMetricAuditLog({
      metricName: metricName || undefined,
      action: action || undefined,
      actorId: actorId || undefined,
      limit,
      offset,
    });
  } catch (error) {
    if (error && error.code === 'INVALID_ACTION_FILTER') {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: error.message,
        fieldErrors: { action: error.message },
      });
    }
    throw error;
  }

  return res.status(200).json({
    data: page.entries,
    meta: {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      returned: page.entries.length,
    },
    filters: {
      metricName: metricName || null,
      action: action || null,
      actorId: actorId || null,
    },
  });
});

module.exports = router;
