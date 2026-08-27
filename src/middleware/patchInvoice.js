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
 * Any key absent from this set is rejected with a 422 response.
 *
 * @type {ReadonlySet<string>}
 */
const MUTABLE_FIELDS = new Set(['amount', 'customer', 'notes', 'version']);

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
 * Keys that must never appear in a trusted payload because they can be
 * used to manipulate prototype chains or constructor references.
 *
 * Belt-and-suspenders guard: `Object.entries` already skips non-own and
 * non-enumerable properties, and the MUTABLE_FIELDS allowlist would strip
 * these anyway — but making the intent explicit provides an extra safety
 * layer and is document-worthy.
 *
 * @type {ReadonlySet<string>}
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Extracts only the allowed mutable keys from the raw request body.
 * Explicitly excludes prototype-pollution vectors even when they appear
 * as own-enumerable properties (e.g. after `Object.defineProperty`).
 *
 * @param {Record<string, unknown>} body - Raw request body.
 * @returns {Record<string, unknown>} Filtered update payload.
 */
function extractAllowedFields(body) {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => MUTABLE_FIELDS.has(key) && !DANGEROUS_KEYS.has(key)
    )
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

  // Reject payloads that attempt prototype / constructor manipulation.
  // Using Object.prototype.hasOwnProperty.call (not body.hasOwnProperty)
  // is safe even when body has a null prototype.
  if (
    Object.prototype.hasOwnProperty.call(body, '__proto__') ||
    Object.prototype.hasOwnProperty.call(body, 'constructor') ||
    Object.prototype.hasOwnProperty.call(body, 'prototype')
  ) {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }

  const bodyKeys = Object.keys(body);
  const rejectedKeys = bodyKeys.filter((key) => !MUTABLE_FIELDS.has(key));

  if (rejectedKeys.length > 0) {
    const fieldErrors = {};
    for (const key of rejectedKeys) {
      fieldErrors[key] = 'Field is not mutable';
    }
    return res.status(422).json({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 422,
      detail: 'Request body contains unrecognized or forbidden fields.',
      instance: req.originalUrl,
      code: 'VALIDATION_ERROR',
      fieldErrors,
    });
  }

  const sanitized = extractAllowedFields(body);

  if (Object.keys(sanitized).length === 0) {
    return res.status(422).json({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Validation Error',
      status: 422,
      detail: 'No valid fields provided. Allowed fields: amount, customer, notes.',
      instance: req.originalUrl,
      code: 'VALIDATION_ERROR',
      fieldErrors: {
        _root: 'No valid fields provided. Allowed fields: amount, customer, notes.',
      },
    });
  }

  req.sanitizedUpdate = sanitized;
  return next();
}

module.exports = {
  MUTABLE_FIELDS,
  PENDING_ONLY_FIELDS,
  LOCKED_STATUSES,
  DANGEROUS_KEYS,
  extractAllowedFields,
  detectLockedFieldChange,
  validatePatchFields,
};
