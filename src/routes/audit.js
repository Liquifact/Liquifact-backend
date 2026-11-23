'use strict';

const express = require('express');
const { auditLog, QUERY_OUTCOMES } = require('../audit/audit-log');
const { requireAdminToken } = require('../middleware/require-admin-token');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** ISO 8601 date-time with a time zone, e.g. 2026-11-23T10:00:00Z or 2026-11-23T11:00:00.000+01:00. */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

/**
 * Parses an ISO 8601 timestamp strictly: a time zone is required and every
 * calendar and clock field must be in range (no 2026-02-30, no 25:00).
 *
 * @param {string} value query value
 * @returns {number|null} epoch milliseconds, or null when invalid
 */
function parseTimestamp(value) {
  const m = ISO_TIMESTAMP.exec(value);
  if (!m) {
    return null;
  }
  const [year, month, day, hour, minute, second = '0', offH = '0', offM = '0'] = m.slice(1);
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 || Number(month) > 12 ||
    Number(day) < 1 || Number(day) > daysInMonth ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    Number(offH) > 23 || Number(offM) > 59
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Parses the optional list filters.
 *
 * @param {object} query req.query
 * @returns {{ filter?: object, error?: string }} filter for log.query, or a 400 message
 */
function parseQuery(query) {
  const { resourceId, action, actor, outcome, from, to, limit, after } = query;
  for (const [name, value] of Object.entries({ resourceId, action, actor, outcome, from, to, limit, after })) {
    if (value !== undefined && typeof value !== 'string') {
      return { error: `${name} must be a single value` };
    }
  }
  const filter = { resourceId, action, actor, limit: DEFAULT_LIMIT, after: 0 };
  if (outcome !== undefined) {
    if (!QUERY_OUTCOMES.includes(outcome)) {
      return { error: `outcome must be one of ${QUERY_OUTCOMES.join(', ')}` };
    }
    filter.outcome = outcome;
  }
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value !== undefined) {
      const ms = parseTimestamp(value);
      if (ms === null) {
        return { error: `${name} must be an ISO 8601 timestamp with a time zone, e.g. 2026-11-23T10:00:00Z` };
      }
      filter[name] = ms;
    }
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
    return { error: 'from must not be later than to' };
  }
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
