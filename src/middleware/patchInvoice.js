/**
 * PATCH Invoice Field Guard Middleware
 *
 * Enforces strict field-level controls for invoice updates.
 * Only explicitly allowed fields may be mutated, and status transitions
 * gate which of those fields are currently editable.
 */

'use strict';

/**
 * Fields a caller is ever permitted to send in a PATCH body.
 * Any key absent from this set is silently stripped before processing.
 *
 * @type {ReadonlySet<string>}
 */
const MUTABLE_FIELDS = new Set(['amount', 'customer', 'notes']);

/**
 * Fields that become read-only once the invoice moves past the initial
 * verification stage.  Attempts to change these in a non-pending invoice
 * are rejected with a 422.
 *
 * @type {ReadonlySet<string>}
 */
const PENDING_ONLY_FIELDS = new Set(['amount', 'customer']);

/**
 * Invoice statuses that lock financial / identity fields.
 * Any status NOT in this list is still mutable.
 *
 * @type {ReadonlySet<string>}
 */
const LOCKED_STATUSES = new Set([
  'verified',
  'funded',
  'settled',
  'cancelled',
]);

/**
 * Extracts only the allowed mutable keys from the raw request body.
 *
 * @param {Record<string, unknown>} body - Raw request body.
 * @returns {Record<string, unknown>} Filtered update payload.
 */
function extractAllowedFields(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => MUTABLE_FIELDS.has(key))
  );
}

/**
 * Determines whether the supplied payload attempts to modify a field
 * that is locked for the given invoice status.
 *
 * @param {Record<string, unknown>} payload - Filtered update payload.
 * @param {string} status - Current invoice status.
 * @returns {{ locked: boolean; field?: string }} Result object.
 */
function detectLockedFieldChange(payload, status) {
  if (!LOCKED_STATUSES.has(status)) {
    return { locked: false };
  }

  for (const field of PENDING_ONLY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      return { locked: true, field };
    }
  }

  return { locked: false };
}

/**
 * Express middleware that validates and sanitizes a PATCH /api/invoices/:id
 * request body before the route handler applies the update.
 *
 * Attaches `req.sanitizedUpdate` with only the safe, permitted fields.
 *
 * @param {import('express').Request}  req  - Express request.
 * @param {import('express').Response} res  - Express response.
 * @param {import('express').NextFunction} next - Next middleware.
 * @returns {void}
 */
function validatePatchFields(req, res, next) {
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }

  const sanitized = extractAllowedFields(body);

  if (Object.keys(sanitized).length === 0) {
    return res.status(400).json({
      error: 'No valid fields provided. Allowed fields: amount, customer, notes.',
    });
  }

  req.sanitizedUpdate = sanitized;
  return next();
}

module.exports = {
  MUTABLE_FIELDS,
  PENDING_ONLY_FIELDS,
  LOCKED_STATUSES,
  extractAllowedFields,
  detectLockedFieldChange,
  validatePatchFields,
};