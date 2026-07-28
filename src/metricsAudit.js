'use strict';

/**
 * @fileoverview In-memory bounded audit ring buffer for Prometheus metrics
 * mutations (issue #872).
 *
 * ## Background
 *
 * Changes to Prometheus metrics (.inc/.set/.observe/.reset) leave no audit
 * trail by default, complicating incident review. Recording every single
 * increment to the durable `audit_log_events` table would overwhelm the
 * database for high-frequency metrics.
 *
 * This module provides a **bounded, in-memory** FIFO ring buffer for
 * metrics-mutation audit entries. The buffer is sized via
 * `METRICS_AUDIT_MAX_ENTRIES` (defaults to `1000`); older entries are
 * evicted automatically when the cap is reached. Sensitive label keys
 * (`password`, `secret`, `token`, `api[-_]?key`, `authorization`,
 * `private[-_]?key`, `seed`, `mnemonic`) are redacted recursively before
 * being recorded, mirroring the behaviour of
 * `src/services/auditLogStore.js#redactValue`.
 *
 * ## Action taxonomy
 *
 * Every audit entry carries one of three canonical actions so that callers
 * (and tests) can classify the lifecycle:
 *
 *   - `CREATE` — first write for a `(metricName, labels)` pair (before=null)
 *   - `UPDATE` — subsequent writes (before+after populated)
 *   - `DELETE` — explicit reset/clear of metric values (after=null or 0)
 *
 * ## Read view
 *
 * `getMetricAuditLog()` exposes the currently retained entries with the
 * same offset/limit semantics as `getAuditLogs()` in the durable audit
 * service.  Authentication and authorisation for the HTTP read view lives
 * in `src/routes/adminMetricsAudit.js`.
 *
 * @module metricsAudit
 */

const { redactValue } = require('./services/auditLogStore');

const DEFAULT_MAX_ENTRIES = 1000;
const ENV_MAX_ENTRIES = 'METRICS_AUDIT_MAX_ENTRIES';
const METRIC_ACTIONS = Object.freeze(['CREATE', 'UPDATE', 'DELETE']);
const METRIC_TYPES = Object.freeze(['counter', 'gauge', 'histogram']);

/**
 * Internal ring buffer of audit entries.  Module-private; tests should use
 * `clearMetricAuditLog()` rather than reaching in directly.
 *
 * @type {Array<object>}
 */
const auditBuffer = [];

/** Current actor context — typically set by admin HTTP handlers or jobs. */
let currentActor = { actorType: 'system', actorId: 'system' };

/**
 * Tracks which `(metricName, labelsKey)` pairs have been seen so the next
 * write can be classified as CREATE vs UPDATE.  Cleared alongside the
 * audit buffer.
 *
 * @type {Set<string>}
 */
const seenKeys = new Set();

/**
 * Cached max-entries cap. Re-read from the environment on first access
 * so test runs can override it per-suite.
 *
 * @returns {number}
 */
function resolveMaxEntries() {
  const raw = process.env[ENV_MAX_ENTRIES];
  if (!raw) { return DEFAULT_MAX_ENTRIES; }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) { return DEFAULT_MAX_ENTRIES; }
  return Math.min(parsed, 100_000); // absolute ceiling against runaway config
}

/**
 * Sets the current actor context used to tag audit entries until cleared.
 *
 * Accepts a partial override — fields not supplied fall back to the
 * previous value.  Pass `null` to clear the context entirely (system).
 *
 * @param {{actorType?: string, actorId?: string}|null} override
 * @returns {void}
 */
function setActorContext(override) {
  if (!override) {
    currentActor = { actorType: 'system', actorId: 'system' };
    return;
  }
  currentActor = {
    actorType: typeof override.actorType === 'string' && override.actorType
      ? override.actorType
      : currentActor.actorType,
    actorId: typeof override.actorId === 'string' && override.actorId
      ? override.actorId
      : currentActor.actorId,
  };
}

/**
 * Returns the current actor context snapshot.
 *
 * @returns {{actorType: string, actorId: string}}
 */
function getActorContext() {
  return { ...currentActor };
}

/**
 * Wraps the provided context, runs `fn`, and restores the previous context
 * regardless of success or failure.
 *
 * @template T
 * @param {{actorType?: string, actorId?: string}|null} context
 * @param {() => T} fn
 * @returns {T}
 */
function withActorContext(context, fn) {
  const previous = { ...currentActor };
  try {
    setActorContext(context);
    return fn();
  } finally {
    currentActor = previous;
  }
}

/**
 * Builds a stable key for the (metricName, labels) pair used to detect
 * CREATE/UPDATE transitions.
 *
 * @param {string} metricName
 * @param {object} labels
 * @returns {string}
 */
function buildSeenKey(metricName, labels) {
  const sortedLabels = labels && typeof labels === 'object'
    ? Object.keys(labels).sort().reduce((acc, key) => {
      acc[key] = labels[key];
      return acc;
    }, {})
    : {};
  return `${metricName}::${JSON.stringify(sortedLabels)}`;
}

/**
 * Coerces `value` into a finite number.  Returns `null` for non-numeric
 * inputs (e.g. histogram cumulative buckets) so audit entries never
 * record `NaN` or `undefined`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function coerceFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) { return value; }
  if (typeof value === 'bigint') { return Number(value); }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Records a metric mutation in the audit ring buffer.
 *
 * Trims the oldest entries when the cap is exceeded. Re-uses
 * `redactValue()` so sensitive label values are scrubbed before the
 * entry is appended to memory.
 *
 * @param {object} params - Mutation parameters.
 * @param {string} params.metricName - Prometheus metric name.
 * @param {string} params.metricType - 'counter' | 'gauge' | 'histogram'.
 * @param {object} [params.labels={}] - Label names/values used for the write.
 * @param {unknown} [params.before=null] - Value before the mutation.
 * @param {unknown} [params.after=null] - Value after the mutation.
 * @param {string} [params.action] - Optional explicit action override;
 *   defaults to CREATE on first observation and UPDATE thereafter.
 * @param {string} [params.source] - Free-form origin tag (e.g. 'inc',
 *   'set', 'observe', 'reset', 'refreshMetrics').
 * @returns {object} The recorded entry (frozen).
 * @throws {Error} When `metricName` or `metricType` is not supplied or invalid.
 */
function recordMetricMutation({
  metricName,
  metricType,
  labels = {},
  before = null,
  after = null,
  action,
  source,
} = {}) {
  if (!metricName || typeof metricName !== 'string') {
    throw new Error('metricName is required');
  }
  if (!METRIC_TYPES.includes(metricType)) {
    throw new Error(`metricType must be one of: ${METRIC_TYPES.join(', ')}`);
  }

  const safeLabels = redactValue(labels && typeof labels === 'object' ? labels : {});
  const seenKey = buildSeenKey(metricName, safeLabels);
  const hasSeen = seenKeys.has(seenKey);

  let resolvedAction = action === 'CREATE' || action === 'UPDATE' || action === 'DELETE'
    ? action
    : hasSeen ? 'UPDATE' : 'CREATE';

  if (resolvedAction !== 'DELETE' && hasSeen === false) {
    // Promote first-seen to CREATE.
    seenKeys.add(seenKey);
  }

  const entry = Object.freeze({
    id: `metric-audit-${Date.now()}-${auditBuffer.length + 1}`,
    timestamp: new Date().toISOString(),
    actor: { ...currentActor },
    action: resolvedAction,
    metricName,
    metricType,
    labels: safeLabels,
    before: coerceFiniteNumber(before),
    after: coerceFiniteNumber(after),
    source: typeof source === 'string' && source ? source : null,
  });

  auditBuffer.push(entry);

  // Bound the buffer — drop oldest entries when over the cap.
  const maxEntries = resolveMaxEntries();
  while (auditBuffer.length > maxEntries) {
    const dropped = auditBuffer.shift();
    if (dropped && dropped.action !== 'DELETE') {
      // Drop from seenKeys too so eviction is transparent to subsequent
      // writes — a CREATE can occur again for the evicted (metric, labels)
      // pair.  DELETE entries intentionally do not register in seenKeys.
      const droppedKey = buildSeenKey(dropped.metricName, dropped.labels);
      seenKeys.delete(droppedKey);
    }
  }

  return entry;
}

/**
 * Records an explicit DELETE (reset/clear) action.
 *
 * @param {object} params - Same shape as {@link recordMetricMutation} minus
 *   `action` (always set to 'DELETE').
 * @returns {object} The recorded entry (frozen).
 */
function recordMetricDelete(params = {}) {
  return recordMetricMutation({ ...params, action: 'DELETE' });
}

/**
 * Reads the current audit buffer with optional filters and pagination.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.metricName] - Restrict to a single metric.
 * @param {string} [options.action] - Restrict to one of CREATE/UPDATE/DELETE.
 * @param {string} [options.actorId] - Restrict to a single actor id.
 * @param {number} [options.limit=100] - Max records to return.
 * @param {number} [options.offset=0] - Records to skip.
 * @returns {{entries: object[], total: number, limit: number, offset: number}}
 */
function getMetricAuditLog({
  metricName,
  action,
  actorId,
  limit = 100,
  offset = 0,
} = {}) {
  const parsedLimit = Number(limit);
  const safeLimit = (!Number.isFinite(parsedLimit) || parsedLimit <= 0)
    ? 100
    : Math.min(parsedLimit, 1000); // hard ceiling per request

  // Cap offset to a sane maximum so an attacker cannot force O(offset)
  // Array.prototype.slice work during request handling.
  const parsedOffset = Number(offset);
  const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? Math.min(parsedOffset, 1_000_000)
    : 0;

  if (action !== undefined && action !== null && !METRIC_ACTIONS.includes(action)) {
    const err = new Error(`Invalid action filter: ${action}`);
    err.code = 'INVALID_ACTION_FILTER';
    throw err;
  }

  const filtered = auditBuffer.filter((entry) => {
    if (metricName && entry.metricName !== metricName) { return false; }
    if (action && entry.action !== action) { return false; }
    if (actorId && entry.actor.actorId !== actorId) { return false; }
    return true;
  });

  const slice = filtered.slice(safeOffset, safeOffset + safeLimit);

  return Object.freeze({
    entries: Object.freeze(
      slice.map((entry) => Object.freeze({ ...entry, actor: Object.freeze({ ...entry.actor }) }))
    ),
    total: filtered.length,
    limit: safeLimit,
    offset: safeOffset,
  });
}

/**
 * Clears the audit buffer and seen-set. Test-only path. Refuses to run in
 * production to mirror the existing `clearAuditLogs` guard.
 *
 * @returns {void}
 */
function clearMetricAuditLog() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot clear metric audit log in production');
  }
  auditBuffer.length = 0;
  seenKeys.clear();
  currentActor = { actorType: 'system', actorId: 'system' };
}

/**
 * Returns the current audit buffer size (test/diagnostic only).
 *
 * @returns {number}
 */
function sizeMetricAuditLog() {
  return auditBuffer.length;
}

module.exports = {
  recordMetricMutation,
  recordMetricDelete,
  getMetricAuditLog,
  clearMetricAuditLog,
  sizeMetricAuditLog,
  setActorContext,
  getActorContext,
  withActorContext,
  METRIC_ACTIONS,
};
