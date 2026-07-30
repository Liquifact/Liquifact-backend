'use strict';

/**
 * @fileoverview Audit-trail route for per-invoice event history.
 *
 * Security contract (issue #426):
 * - The caller must be authenticated (JWT via `authenticateToken`).
 * - The tenant is extracted by `extractTenant`.
 * - Before returning events, {@link assertInvoiceEntitlement} confirms the
 *   requested invoice exists **and** belongs to the caller's tenant.
 * - A **404** is returned for foreign invoices *and* genuinely missing
 *   invoices alike, to avoid existence leakage (enumeration resistance).
 *
 * @module routes/auditTrail
 */

const { Router } = require('express');
const { authenticateToken } = require('../middleware/auth');
const { extractTenant } = require('../middleware/tenant');
const { getInvoiceById } = require('../services/invoiceService');
const { getInvoiceAuditTrail } = require('../services/auditLog');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

/**
 * Asserts the caller is entitled to view the audit trail for a specific invoice.
 *
 * Entitlement rules:
 * 1. The invoice must exist (no hard-deleted or absent invoices).
 * 2. The invoice's `tenant_id` must match `req.tenantId`.
 * 3. The caller role must be `admin` or `owner`.  Any other role is treated
 *    as unauthorised and also returns 404 to avoid privilege-level leakage.
 *
 * Returns 404 in all failure cases so callers cannot distinguish "invoice
 * doesn't exist" from "invoice belongs to another tenant" from "insufficient
 * role" — closing the enumeration vector described in issue #426.
 *
 * @param {import('express').Request} req
 * @param {string} invoiceId
 * @returns {Promise<void>} Resolves if entitled; throws a 404-tagged error otherwise.
 */
async function assertInvoiceEntitlement(req, invoiceId) {
  const PERMITTED_ROLES = new Set(['admin', 'owner']);

  // Role check first — no DB hit needed for clearly unpermitted roles
  const role = req.user && typeof req.user.role === 'string' ? req.user.role : '';
  if (!PERMITTED_ROLES.has(role)) {
    const err = new Error('Not found');
    err.status = 404;
    throw err;
  }

  // Tenant-scoped existence check
  const invoice = await getInvoiceById(invoiceId, req.tenantId);
  if (!invoice) {
    const err = new Error('Not found');
    err.status = 404;
    throw err;
  }
}

/**
 * GET /api/audit-trail/:invoiceId
 *
 * Returns the audit trail for the given invoice.
 * The response streams (via JSON array) in reverse-chronological order.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get(
  '/:invoiceId',
  authenticateToken,
  extractTenant,
  asyncHandler(async (req, res) => {
    const { invoiceId } = req.params;

    try {
      await assertInvoiceEntitlement(req, invoiceId);
    } catch (_err) {
      return res.status(404).json({ error: 'Not found' });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const events = getInvoiceAuditTrail(invoiceId, limit);

    return res.json({ data: events, invoiceId, count: events.length });
  })
);

// Route-local error handler: forward AppError/status-tagged errors with their
// correct HTTP status so they don't fall through to the generic 500 handler.
router.use(function auditTrailErrorHandler(err, req, res, _next) {
  const status = (err && typeof err.status === 'number') ? err.status : 500;
  if (status === 500) {
    // Let unexpected errors bubble up to the app-level handler
    _next(err);
    return;
  }
  res.status(status).json({ error: err.message || 'Error' });
});

module.exports = router;
module.exports.assertInvoiceEntitlement = assertInvoiceEntitlement;
