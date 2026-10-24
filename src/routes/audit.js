'use strict';

const express = require('express');
const { auditLog } = require('../audit/audit-log');
const { requireAdminToken } = require('../middleware/require-admin-token');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parses the optional list filters.
 *
 * @param {object} query req.query
 * @returns {{ filter?: object, error?: string }} filter for log.query, or a 400 message
 */
function parseQuery(query) {
  const { resourceId, action, limit, after } = query;
  for (const [name, value] of Object.entries({ resourceId, action, limit, after })) {
    if (value !== undefined && typeof value !== 'string') {
      return { error: `${name} must be a single value` };
    }
  }
  const filter = { resourceId, action, limit: DEFAULT_LIMIT, after: 0 };
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT) {
      return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
    }
    filter.limit = Number(limit);
  }
  if (after !== undefined) {
    if (!/^\d+$/.test(after)) {
      return { error: 'after must be a non-negative integer (a seq number)' };
    }
    filter.after = Number(after);
  }
  return { filter };
}

/**
 * Builds the admin-only audit router.
 *
 * @param {object} [log] audit log to read from
 * @returns {import('express').Router} router mounted at /api/audit
 */
function createAuditRouter(log = auditLog) {
  const router = express.Router();
  router.use(requireAdminToken);

  router.get('/verify', (req, res) => res.json(log.verify()));

  router.get('/', (req, res) => {
    const { filter, error } = parseQuery(req.query);
    if (error) {
      return res.status(400).json({ error });
    }
    const { data, nextAfter } = log.query(filter);
    return res.json({ data, count: data.length, nextAfter });
  });

  return router;
}

module.exports = createAuditRouter();
module.exports.createAuditRouter = createAuditRouter;
