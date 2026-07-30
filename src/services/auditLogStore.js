'use strict';

const { Transform } = require('stream');
const db = require('../db/knex');

const REDACTED = '***REDACTED***';
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /private[-_]?key/i,
  /seed/i,
  /mnemonic/i,
];

/**
 * Redacts sensitive values from an object.
 *
 * @param {*} value The value to redact.
 * @returns {*} The redacted value.
 */
function redactValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  for (const [key, currentValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      sanitized[key] = REDACTED;
      continue;
    }
    sanitized[key] = redactValue(currentValue);
  }
  return sanitized;
}

/**
 * Normalizes metadata for storage.
 *
 * @param {*} metadata The metadata object to normalize.
 * @returns {object} The normalized metadata object.
 */
function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  return redactValue(metadata);
}

/**
 * Appends an audit log event to the database.
 *
 * @param {object} event The event to append.
 * @param {object} [options={}] Additional options.
 * @param {object} [options.db] Alternative Knex instance.
 * @returns {Promise<void>} Resolves when the event is inserted.
 */
async function appendAuditEvent(event, options = {}) {
  const knex = options.db || db;
  const record = {
    event_type: event.eventType,
    action: event.action,
    actor_type: event.actorType,
    actor_id: event.actorId,
    target_type: event.targetType || null,
    target_id: event.targetId || null,
    request_id: event.requestId || null,
    route: event.route || null,
    method: event.method || null,
    status_code: Number.isInteger(event.statusCode) ? event.statusCode : null,
    ip_address: event.ipAddress || null,
    user_agent: event.userAgent || null,
    metadata: JSON.stringify(normalizeMetadata(event.metadata)),
  };

  await knex('audit_log_events').insert(record);
}

/**
 * Escapes a single CSV field value to prevent formula-injection attacks and
 * to conform to RFC 4180 quoting rules.
 *
 * Formula-injection neutralisation (OWASP CSV Injection guidance):
 *   - Leading whitespace is stripped before the dangerous-character check so
 *     that values like " =HYPERLINK(...)" or "\t=cmd" are not overlooked.
 *   - Any field whose leading non-whitespace character is one of
 *     = + - @ | \t \r is prefixed with a single quote (') on the *original*
 *     string so that spreadsheet software treats the cell as plain text.
 *
 * Covered cases:
 *   "=SUM(...)"          → "'=SUM(...)"
 *   " =HYPERLINK(...)"   → "' =HYPERLINK(...)"  (leading space + =)
 *   "\t=cmd"             → "'\t=cmd"            (leading tab + =)
 *   "+cmd|..."           → "'+cmd|..."
 *   "-2+3"               → "'-2+3"
 *   "@SUM(1)"            → "'@SUM(1)"
 *   "|calc.exe"          → "'|calc.exe"
 *   "\r=evil"            → "'\r=evil"           (leading CR)
 *
 * @param {*} val - Raw field value (any type; will be coerced to string).
 * @returns {string} Safely-escaped CSV field, quoted when necessary.
 */
function escapeCsvField(val) {
  const str = val == null ? '' : String(val);

  // Neutralise formula-injection: inspect the first non-whitespace character.
  // Covers the OWASP-recommended set: = + - @ | \t \r
  const trimmedFirst = str.trimStart();
  const injectionSafe =
    trimmedFirst.length > 0 && /^[=+\-@|\t\r]/.test(trimmedFirst) ? `'${str}` : str;

  // RFC 4180 quoting: wrap in double-quotes if the value contains a
  // comma, double-quote, or newline; escape embedded double-quotes by
  // doubling them.
  if (
    injectionSafe.includes(',') ||
    injectionSafe.includes('"') ||
    injectionSafe.includes('\n') ||
    injectionSafe.includes('\r')
  ) {
    return `"${injectionSafe.replace(/"/g, '""')}"`;
  }

  return injectionSafe;
}

/** Column names written to the CSV header row — order must match {@link rowToCsvLine}. */
const CSV_HEADERS = [
  'id',
  'timestamp',
  'actor',
  'action',
  'resourceType',
  'resourceId',
  'statusCode',
  'ipAddress',
  'userAgent',
];

/**
 * Serialises a single `audit_log_events` database row to a CSV line
 * (no trailing newline).
 *
 * @param {object} row - Raw database row from `audit_log_events`.
 * @returns {string} Comma-separated, formula-injection-safe CSV line.
 */
function rowToCsvLine(row) {
  return [
    escapeCsvField(row.id),
    escapeCsvField(row.created_at),
    escapeCsvField(row.actor_id),
    escapeCsvField(row.action),
    escapeCsvField(row.target_type),
    escapeCsvField(row.target_id),
    escapeCsvField(row.status_code),
    escapeCsvField(row.ip_address),
    escapeCsvField(row.user_agent),
  ].join(',');
}

/**
 * Returns a Node.js `Readable` stream of `audit_log_events` rows that
 * match the supplied filters.  Rows are emitted one object at a time
 * directly from the database cursor — the full result set is **never**
 * buffered in memory.
 *
 * Tenant isolation is enforced by filtering on the JSONB `metadata`
 * column so that cross-tenant rows are excluded at the database level.
 *
 * @param {object}  [filters={}]             Filter options.
 * @param {string}  [filters.targetId]       Restrict to a specific `target_id` value.
 * @param {string}  [filters.targetType]     Restrict to a specific `target_type` value.
 * @param {string}  [filters.tenantId]       Tenant guard — only rows whose
 *   `metadata->>'tenantId'` equals this value are returned.
 * @param {object}  [options={}]             Driver options.
 * @param {object}  [options.db]             Alternative Knex instance (for testing).
 * @returns {Readable}  Object-mode readable stream of raw DB rows.
 */
function streamAuditEvents(filters = {}, options = {}) {
  const knex = options.db || db;

  let query = knex('audit_log_events')
    .select('*')
    .orderBy('created_at', 'asc');

  if (filters.targetId) {
    query = query.where('target_id', filters.targetId);
  }
  if (filters.targetType) {
    query = query.where('target_type', filters.targetType);
  }
  if (filters.tenantId) {
    // Filter at the DB level using the JSONB operator so no cross-tenant
    // rows are ever loaded into application memory.
    query = query.whereRaw("metadata->>'tenantId' = ?", [filters.tenantId]);
  }

  return query.stream();
}

/**
 * Creates a `Transform` stream that converts raw `audit_log_events`
 * database rows (object mode) into newline-terminated CSV lines.
 *
 * The first chunk emitted is always the header row.  Each subsequent
 * chunk is one data row.  Fields are escaped via {@link escapeCsvField}
 * to prevent formula-injection and to satisfy RFC 4180.
 *
 * @returns {Transform} Object-mode→string Transform stream.
 */
function createCsvTransform() {
  let headerWritten = false;

  return new Transform({
    objectMode: true,
    /**
     * Transforms a raw DB row to CSV line.
     *
     * @param {object}   row      Raw DB row in object mode.
     * @param {string}   _enc     Ignored (objectMode).
     * @param {Function} callback Node stream callback.
     */
    transform(row, _enc, callback) {
      try {
        if (!headerWritten) {
          this.push(`${CSV_HEADERS.join(',')}\n`);
          headerWritten = true;
        }
        this.push(`${rowToCsvLine(row)}\n`);
        callback();
      } catch (err) {
        callback(err);
      }
    },

    /**
     * Flush is called once the upstream is exhausted.  If no rows were
     * emitted we still need to write the header so the response is a
     * valid (albeit empty-data) CSV file.
     *
     * @param {Function} callback Node stream callback.
     */
    flush(callback) {
      if (!headerWritten) {
        this.push(`${CSV_HEADERS.join(',')}\n`);
      }
      callback();
    },
  });
}

module.exports = {
  appendAuditEvent,
  redactValue,
  normalizeMetadata,
  REDACTED,
  escapeCsvField,
  CSV_HEADERS,
  rowToCsvLine,
  streamAuditEvents,
  createCsvTransform,
};
