'use strict';

/**
 * Invoice State Routes
 *
 * Mounted under `/api/invoices` via `mountFeatureRouter` in `src/app.js`.
 * Inbound request bodies are validated through the strict wrapper in
 * `src/schemas/invoiceState.js` so that malformed inputs (missing required
 * fields, wrong types, unknown keys, oversized strings, out-of-range
 * values, prototype-pollution vectors, excessive metadata depth) are
 * rejected with a structured RFC 7807 400 before any business-logic step
 * runs.  The `fieldErrors` map carries machine-readable uppercase codes so
 * clients can branch on validation outcomes programmatically.
 *
 * The `/transition` endpoint inspects the requested target state against
 * `CAPITAL_MOVING_STATES` to surface whether the caller will need KYC
 * gating.  This route is intentionally read-only w.r.t. the database; the
 * real persistence path lives in `src/services/invoiceService.js`.
 */

const express = require('express');

const { CAPITAL_MOVING_STATES } = require('../services/invoiceStateMachine');
const { safeParseTransitionBody } = require('../schemas/invoiceState');

const router = express.Router();

/**
 * Builds an RFC 7807 `application/problem+json` payload describing a
 * validation failure on the transition body.
 *
 * @param {Record<string, string>} fieldErrors - Map of field path → code.
 * @returns {object} RFC 7807 problem-details body.
 */
function buildTransitionValidationProblem(fieldErrors) {
  return {
    type: 'https://liquifact.io/problems/validation-error',
    title: 'Invalid invoice-state request body',
    status: 400,
    detail:
      'Request body for invoice-state endpoint is malformed: ' +
      'review fieldErrors for the specific machine-readable code.',
    code: 'INVOICE_STATE_VALIDATION_FAILED',
    fieldErrors,
  };
}

/**
 * Middleware that validates the body of a state-transition request.
 *
 * On failure, responds with a structured 400 RFC 7807 body and
 * short-circuits the request. On success, attaches the parsed (and trimmed)
 * payload at `req.validatedTransitionBody` and leaves `req.body` unchanged
 * so downstream middleware (sanitization, idempotency, audit) can still read
 * the original request.
 *
 * @param {import('express').Request}  req  - Express request.
 * @param {import('express').Response} res  - Express response.
 * @param {import('express').NextFunction} next - Next middleware.
 * @returns {void}
 */
function validateTransitionBody(req, res, next) {
  const result = safeParseTransitionBody(req.body);
  if (!result.success) {
    return res.status(400).json(buildTransitionValidationProblem(result.fieldErrors));
  }
  req.validatedTransitionBody = result.data;
  return next();
}

/**
 * POST /transition
 *
 * Inspects the inbound target state and returns whether the caller will
 * require KYC to move capital. Validation ensures the body is strictly
 * shaped, has bounded string lengths, and contains only recognised fields
 * before any business decision is made.
 *
 * @param {import('express').Request}  req  - Express request.
 * @param {import('express').Response} res  - Express response.
 * @returns {void}
 */
router.post('/transition', validateTransitionBody, (req, res) => {
  const { targetState } = req.validatedTransitionBody || {};

  if (CAPITAL_MOVING_STATES.has(targetState)) {
    return res.status(200).json({ requiresKYC: true, state: targetState });
  }

  return res.status(200).json({ requiresKYC: false, state: targetState });
});

module.exports = router;
