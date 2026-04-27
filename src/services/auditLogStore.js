'use strict';

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

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  return redactValue(metadata);
}

async function appendAuditEvent(event) {
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

  await db('audit_log_events').insert(record);
}

module.exports = {
  appendAuditEvent,
  redactValue,
  REDACTED,
};
