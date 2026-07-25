/**
 * Audit Log Service
 * Manages immutable audit records for invoice mutations.
 * Backed by the durable audit_log_events table.
 * 
 * @module services/auditLog
 */

const { appendAuditEvent, redactValue } = require('./auditLogStore');
const db = require('../db/knex');
const MAX_PAGE_SIZE = 100; // Maximum number of audit logs to return in a single query

/**
 * Generates a unique audit log ID using timestamp and random suffix.
 * Kept for backward compatibility.
 *
 * @returns {string} The generated audit log ID.
 */
function generateAuditLogId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 11);
  return `AUDIT-${timestamp}-${random}`;
}

/**
 * Sanitizes sensitive data from objects to prevent logging secrets.
 *
 * @param {*} obj The object or value to sanitize.
 * @returns {*} The sanitized object or value.
 */
function sanitizeSensitiveData(obj) {
  return redactValue(obj);
}

/**
 * Calculates the differences between two objects.
 *
 * @param {object|null} before The state before the change.
 * @param {object|null} after The state after the change.
 * @returns {object} The before and after differences.
 */
function calculateChanges(before, after) {
  if (!before || !after) {
    return { before: sanitizeSensitiveData(before), after: sanitizeSensitiveData(after) };
  }

  const changes = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  allKeys.forEach((key) => {
    const beforeVal = before[key];
    const afterVal = after[key];

    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      if (!changes.before) { changes.before = {}; }
      if (!changes.after) { changes.after = {}; }
      changes.before[key] = beforeVal;
      changes.after[key] = afterVal;
    }
  });

  return {
    before: sanitizeSensitiveData(changes.before || {}),
    after: sanitizeSensitiveData(changes.after || {}),
  };
}

/**
 * Creates an immutable audit log entry in the database.
 *
 * @param {object} root0 Audit log event data.
 * @param {string} root0.actor The actor performing the action.
 * @param {string} root0.action The action performed.
 * @param {string} root0.resourceType The type of resource.
 * @param {string} root0.resourceId The ID of the resource.
 * @param {object|null} [root0.before=null] The state before the action.
 * @param {object|null} [root0.after=null] The state after the action.
 * @param {number} [root0.statusCode=200] The HTTP status code.
 * @param {string} [root0.ipAddress='unknown'] The IP address of the actor.
 * @param {string} [root0.userAgent='unknown'] The user agent of the actor.
 * @param {object} [root0.metadata={}] Additional metadata.
 * @returns {Promise<object>} The created audit log entry.
 */
async function createAuditLog({
  actor,
  action,
  resourceType,
  resourceId,
  before = null,
  after = null,
  statusCode = 200,
  ipAddress = 'unknown',
  userAgent = 'unknown',
  metadata = {},
} = {}) {
  if (!actor) { throw new Error('Audit log actor is required'); }
  if (!action) { throw new Error('Audit log action is required'); }
  if (!resourceType) { throw new Error('Audit log resourceType is required'); }
  if (!resourceId) { throw new Error('Audit log resourceId is required'); }

  const validActions = ['CREATE', 'UPDATE', 'DELETE', 'READ', 'STATE_TRANSITION'];
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`);
  }

  const changes = calculateChanges(before, after);

  const event = {
    eventType: 'admin_action',
    action,
    actorType: 'user',
    actorId: actor,
    targetType: resourceType,
    targetId: resourceId,
    statusCode,
    ipAddress,
    userAgent,
    metadata: {
      ...metadata,
      before: changes.before,
      after: changes.after
    }
  };

  await appendAuditEvent(event);

  return Object.freeze({
    id: generateAuditLogId(),
    timestamp: new Date().toISOString(),
    actor,
    action,
    resourceType,
    resourceId,
    changes,
    statusCode,
    ipAddress,
    userAgent,
    metadata: Object.freeze({ ...metadata }),
  });
}

/**
 * Maps a database row to an audit log object.
 *
 * @param {object} row The database row.
 * @returns {object} The mapped audit log object.
 */
function mapDbRowToAuditLog(row) {
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  return Object.freeze({
    id: row.id,
    timestamp: row.created_at,
    actor: row.actor_id,
    action: row.action,
    resourceType: row.target_type,
    resourceId: row.target_id,
    changes: {
      before: metadata?.before || null,
      after: metadata?.after || null
    },
    statusCode: row.status_code,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    metadata: Object.freeze({ ...metadata })
  });
}

/**
 * Retrieves audit logs with optional filtering.
 * 
 * @param {Object} options Filter options
 * @param {string} [options.resourceId] Filter by resource ID
 * @param {string} [options.resourceType] Filter by resource type
 * @param {string} [options.actor] Filter by actor
 * @param {string} [options.action] Filter by action
 * @param {string} [options.tenantId] Filter by tenant ID for isolation
 * @param {number} [options.limit=100] Maximum number of records to return
 * @param {number} [options.offset=0] Number of records to skip
 * @returns {Array<Object>} Matching audit log entries (read-only copies)
 */
async function getAuditLogs({
  resourceId = null,
  resourceType = null,
  actor = null,
  action = null,
  tenantId = null,
  limit = 100,
  offset = 0,
} = {}) {
  /**
   * Clamp the requested limit to a safe maximum to prevent loading the entire audit log into memory. The default limit is 100, and the maximum allowed is 100.
   * -Non-numeric or negative limits will default to 100.
   * Any value above MAX_PAGE_SIZE will be capped to MAX_PAGE_SIZE.
   * Callers needing more rows should use the streaming export route.
   */
  const parsedLimit = Number(limit);
  const requestedLimit = (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit:100;
  const cappedLimit = Math.min(requestedLimit, MAX_PAGE_SIZE);
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  let query = db('audit_log_events').select('*').orderBy('created_at', 'desc');

  if (resourceId) { query = query.where('target_id', resourceId); }
  if (resourceType) { query = query.where('target_type', resourceType); }
  if (actor) { query = query.where('actor_id', actor); }
  if (action) { query = query.where('action', action); }

  query = query.limit(cappedLimit).offset(safeOffset ?? 0);


  const rows = await query;
  let filtered = rows.map(mapDbRowToAuditLog);
  if (tenantId) {
    filtered = filtered.filter((log) => log.metadata && log.metadata.tenantId === tenantId);
  }

  return filtered;
}

/**
 * Retrieves audit logs for a specific invoice.
 * Convenience method for invoice-specific queries.
 * 
 * @param {string} invoiceId Invoice resource ID
 * @param {number} [limit=100] Maximum records to return
 * @param {number} [offset=0] Records to skip (for pagination)
 * @param {string} [tenantId] Tenant ID for isolation
 * @returns {Array<Object>} Audit log entries for the invoice
 */
function getInvoiceAuditTrail(invoiceId, limit = 100, offset = 0, tenantId = null) {
  return getAuditLogs({
    resourceId: invoiceId,
    resourceType: 'invoice',
    limit,
    offset,
    tenantId,
  });
}

/**
 * Counts total audit logs matching criteria.
 *
 * @param {object} [options={}] Filter options.
 * @returns {number} The count of matching audit logs.
 */
async function countAuditLogs(options = {}) {
  const logs = await getAuditLogs({ ...options, limit: Infinity, offset: 0 });
  return logs.length;
}

/**
 * Clears all audit logs (for testing only).
 */
async function clearAuditLogs() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot clear audit logs in production');
  }
  // Remove trigger so we can clear during testing
  try {
    await db.raw('DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log_events');
    await db('audit_log_events').del();
    // Re-add trigger
    await db.raw(`
      CREATE TRIGGER trg_audit_log_no_delete
      BEFORE DELETE ON audit_log_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_update_or_delete();
    `);
  } catch (error) {
    await db('audit_log_events').del();
  }
  
}

/**
 * Exports audit logs.
 *
 * @param {object} [root0={}] Options.
 * @param {number} [root0.limit=Infinity] Maximum logs to export.
 * @param {string} [root0.format='json'] Export format.
 * @returns {Promise<string>} The exported audit logs.
 */
async function exportAuditLogs({ limit = Infinity, format = 'json' } = {}) {
  const logs = await getAuditLogs({ limit });

  if (format === 'csv') {
    const headers = 'id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent';
    const rows = logs.map((log) => {
      const escapeCsv = (val) => {
        if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      };
      return [
        log.id,
        log.timestamp,
        escapeCsv(log.actor),
        log.action,
        log.resourceType,
        log.resourceId,
        log.statusCode,
        escapeCsv(log.ipAddress),
        escapeCsv(log.userAgent),
      ].join(',');
    });
    return `${headers}\n${rows.join('\n')}`;
  }

  return JSON.stringify(logs, null, 2);
}

/**
 * Exports audit logs for a specific invoice as JSON.
 * Secrets are redacted via sanitizeSensitiveData.
 *
 * CSV export is handled by the route layer via streaming (see
 * `streamAuditEvents` + `createCsvTransform` in `auditLogStore`).
 *
 * @param {Object} options
 * @param {string} options.invoiceId Invoice resource ID
 * @param {number} [options.limit=100] Maximum records to export
 * @param {string} [options._format='json'] 'json' (CSV is ignored; use streaming route)
 * @param {string} [options.tenantId] Tenant ID for isolation
 * @returns {Promise<string>} Formatted audit log output
 */
async function exportInvoiceAuditLogs({ invoiceId, limit = 100, _format = 'json', tenantId = null } = {}) {
  const logs = await getAuditLogs({
    resourceId: invoiceId,
    resourceType: 'invoice',
    limit,
    offset: 0,
    tenantId,
  });

  return JSON.stringify(logs, null, 2);
}

module.exports = {
  createAuditLog,
  getAuditLogs,
  getInvoiceAuditTrail,
  countAuditLogs,
  clearAuditLogs,
  exportAuditLogs,
  exportInvoiceAuditLogs,
  // Exported for testing purposes
  generateAuditLogId,
  sanitizeSensitiveData,
  calculateChanges,
};
