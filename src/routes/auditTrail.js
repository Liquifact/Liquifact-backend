'use strict';

/**
 * @fileoverview Admin routes for invoice audit trail and state-transition history export.
 * All routes require admin authentication (JWT or API key) and tenant isolation.
 *
 * Routes:
 *   GET /api/admin/audit/invoices/:invoiceId        - Paginated audit trail
 *   GET /api/admin/audit/invoices/:invoiceId/transitions - State-transition history
 *   GET /api/admin/audit/invoices/:invoiceId/export  - Export as JSON or CSV
 *
 * @module routes/auditTrail
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiKeyAuth } = require('../middleware/apiKey');
const { extractTenant } = require('../middleware/tenant');
const { getInvoiceAuditTrail, countAuditLogs, exportInvoiceAuditLogs, getAuditLogs } = require('../services/auditLog');
const { getTransitionHistory } = require('../services/invoiceStateMachine');
const AppError = require('../errors/AppError');

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/**
 * Accepts either a valid admin JWT or a valid API key.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return apiKeyAuth(req, res, next);
  }
  return authenticateToken(req, res, next);
}

/**
 * Parse and clamp pagination params from query string.
 * @param {object} query
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

/**
 * Validate invoiceId path param — reject obviously malformed values.
 * @param {string} invoiceId
 * @returns {boolean}
 */
function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && invoiceId.length > 0 && invoiceId.length <= 128;
}

// ── Middleware stack for all routes ──────────────────────────────────────────
router.use(adminAuth, extractTenant);

/**
 * GET /api/admin/audit/invoices/:invoiceId
 * Returns paginated audit trail for a specific invoice.
 * Tenant-scoped: only returns records matching req.tenantId.
 */
router.get('/invoices/:invoiceId', (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    if (!isValidInvoiceId(invoiceId)) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invalid invoiceId.',
      }));
    }

    const { limit, offset } = parsePagination(req.query);
    const logs = getInvoiceAuditTrail(invoiceId, limit, offset, req.tenantId);
    const total = countAuditLogs({ resourceId: invoiceId, resourceType: 'invoice', tenantId: req.tenantId });

    return res.json({
      data: logs,
      meta: { invoiceId, limit, offset, total },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/admin/audit/invoices/:invoiceId/transitions
 * Returns state-transition history for a specific invoice.
 */
router.get('/invoices/:invoiceId/transitions', (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    if (!isValidInvoiceId(invoiceId)) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invalid invoiceId.',
      }));
    }

    const transitions = getTransitionHistory(invoiceId, (opts) =>
      getAuditLogs({ ...opts, tenantId: req.tenantId })
    );

    return res.json({ data: transitions, meta: { invoiceId } });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/admin/audit/invoices/:invoiceId/export
 * Exports audit trail as JSON or CSV.
 * Query params: format=json|csv, limit, offset
 */
router.get('/invoices/:invoiceId/export', (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    if (!isValidInvoiceId(invoiceId)) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invalid invoiceId.',
      }));
    }

    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const { limit } = parsePagination(req.query);
    const output = exportInvoiceAuditLogs({ invoiceId, limit, format, tenantId: req.tenantId });

    if (format === 'csv') {
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', `attachment; filename="audit-${invoiceId}.csv"`);
      return res.send(output);
    }

    res.set('Content-Type', 'application/json');
    return res.send(output);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
