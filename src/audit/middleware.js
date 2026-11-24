'use strict';

const { auditLog } = require('./audit-log');

/**
 * Attaches `req.audit(details)` to the request. It appends an audit entry that
 * already carries the request context (actor, client IP, request id), so route
 * handlers only describe what happened (action, resource, outcome, before/after).
 *
 * The actor comes from `req.actor`, set by the authentication middleware (or
 * explicitly overridden in `details`, e.g. for `auth.denied` events), and falls
 * back to "anonymous" when unauthenticated. A failure to write the entry is
 * logged and never changes the HTTP response.
 *
 * @param {object} [log] audit log to write to
 * @returns {import('express').RequestHandler} middleware
 */
function auditContext(log = auditLog) {
  return (req, _res, next) => {
    req.audit = (details) => {
      try {
        return log.append({
          actor: typeof req.actor === 'string' ? req.actor : 'anonymous',
          ip: req.ip,
          ...details,
          requestId: req.id,
        });
      } catch (err) {
        console.error('[audit] failed to record entry:', err.message);
        return null;
      }
    };
    next();
  };
}

module.exports = { auditContext };
