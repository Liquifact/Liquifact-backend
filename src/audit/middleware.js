'use strict';

const crypto = require('crypto');
const { auditLog } = require('./audit-log');

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Attaches `req.audit(details)` to the request. It appends an audit entry that
 * already carries the request context (actor, client IP, request id), so route
 * handlers only describe what happened (action, resource, outcome, before/after).
 *
 * The actor comes from `req.actor`, which an authentication layer can set; the
 * API has no authentication yet, so it is "anonymous" until then. A failure to
 * write the entry is logged and never changes the HTTP response.
 *
 * @param {object} [log] audit log to write to
 * @returns {import('express').RequestHandler} middleware
 */
function auditContext(log = auditLog) {
  return (req, _res, next) => {
    req.audit = (details) => {
      const header = req.get('x-request-id');
      try {
        return log.append({
          actor: typeof req.actor === 'string' ? req.actor : 'anonymous',
          ip: req.ip,
          requestId: header && REQUEST_ID.test(header) ? header : crypto.randomUUID(),
          ...details,
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
