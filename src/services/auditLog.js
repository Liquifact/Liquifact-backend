/**
 * Audit Log Service
 * Manages immutable audit records for invoice mutations.
 * Backed by the durable audit_log_events table.
 * 
 * @module services/auditLog
 */

const { appendAuditEvent, redactValue } = require('./auditLogStore');
const db = require('../db/knex');

/**
 * Generates a unique audit log ID using timestamp and random suffix.
 * Kept for backward compatibility.
 */
function generateAuditLogId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 11);
  return `AUDIT-${timestamp}-${random}`;
}

/**
 * Sanitizes sensitive data from objects to prevent logging secrets.
 */
function sanitizeSensitiveData(obj) {
  return redactValue(obj);
}

/**
 * Calculates the differences between two objects.
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
      if (!changes.before) changes.before = {};
      if (!changes.after) changes.after = {};
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
  if (!actor) throw new Error('Audit log actor is required');
  if (!action) throw new Error('Audit log action is required');
  if (!resourceType) throw new Error('Audit log resourceType is required');
  if (!resourceId) throw new Error('Audit log resourceId is required');

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
  let query = db('audit_log_events').select('*').orderBy('created_at', 'desc');

  if (resourceId) query = query.where('target_id', resourceId);
  if (resourceType) query = query.where('target_type', resourceType);
  if (actor) query = query.where('actor_id', actor);
  if (action) query = query.where('action', action);

  if (limit !== Infinity) {
    query = query.limit(limit).offset(offset);
  }
  if (tenantId) {
    filtered = filtered.filter((log) => log.metadata && log.metadata.tenantId === tenantId);
  }

  const rows = await query;
  return rows.map(mapDbRowToAuditLog);
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
 */
function countAuditLogs(options = {}) {
  const logs = getAuditLogs({ ...options, limit: Infinity, offset: 0 });
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
  await db.raw('DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log_events');
  await db('audit_log_events').del();
  // Re-add trigger
  await db.raw(`
    CREATE TRIGGER trg_audit_log_no_delete
    BEFORE DELETE ON audit_log_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_update_or_delete();
  `);
}

/**
 * Exports audit logs.
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
 * Exports audit logs for a specific invoice as JSON or CSV.
 * Secrets are redacted via sanitizeSensitiveData.
 *
 * @param {Object} options
 * @param {string} options.invoiceId Invoice resource ID
 * @param {number} [options.limit=100] Maximum records to export
 * @param {string} [options.format='json'] 'json' or 'csv'
 * @param {string} [options.tenantId] Tenant ID for isolation
 * @returns {string} Formatted audit log output
 */
function exportInvoiceAuditLogs({ invoiceId, limit = 100, format = 'json', tenantId = null } = {}) {
  const logs = getAuditLogs({
    resourceId: invoiceId,
    resourceType: 'invoice',
    limit,
    offset: 0,
    tenantId,
  });

  if (format === 'csv') {
    const escapeCsv = (val) => {
      const str = val == null ? '' : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const headers = 'id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent';
    const rows = logs.map((log) =>
      [
        escapeCsv(log.id),
        escapeCsv(log.timestamp),
        escapeCsv(log.actor),
        escapeCsv(log.action),
        escapeCsv(log.resourceType),
        escapeCsv(log.resourceId),
        log.statusCode,
        escapeCsv(log.ipAddress),
        escapeCsv(log.userAgent),
      ].join(',')
    );
    return rows.length > 0 ? `${headers}\n${rows.join('\n')}` : headers;
  }

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
