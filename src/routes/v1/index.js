/**
 * V1 API Router — Invoice endpoints with full DB persistence and tenant isolation.
 *
 * Replaces the former in-memory `invoices` array with service-layer calls
 * backed by Knex (sqlite3 in dev/test, PostgreSQL in production).
 *
 * Middleware stack per invoice route:
 *   extractTenant  → resolves req.tenantId from header or JWT claim
 *   route handler  → delegates all persistence to invoiceService
 *   next(err)      → bubbles to the global errorHandler / problemJsonHandler
 *
 * @module routes/v1/index
 */

'use strict';

const express = require('express');

const router = express.Router();
const investRoutes = require('../invest');
const smeRouter = require('../sme');
const apiKeysRoutes = require('../apiKeys');
const { extractTenant } = require('../../middleware/tenant');
const { authenticateToken } = require('../../middleware/auth');
const invoiceService = require('../../services/invoiceService');
const { getEscrowRead, getEscrowReadBatch } = require('../../services/escrowReadService');
const { escrowReadLimiter } = require('../../middleware/rateLimit');
const { recordEscrowRead } = require('../../services/escrowReadMetrics');
const AppError = require('../../errors/AppError');
const { invoiceCreateSchema, invoiceUpdateSchema, parseValidationErrors } = require('../../schemas/invoice');
const { escrowBatchReadSchema } = require('../../schemas/escrowBatchRead');
const { validatePatchFields, detectLockedFieldChange } = require('../../middleware/patchInvoice');
const { validateHealthQuery, rejectBodyOnGet } = require('../../schemas/health');
const { z } = require('zod');

const validateEscrowReadParams = z.object({
  invoiceId: z.string().min(1).max(64),
});

// ── Sub-router mounts ────────────────────────────────────────────────────────
router.use('/invest', investRoutes);
router.use('/sme', smeRouter);
router.use('/api-keys', apiKeysRoutes); // ← Added

// ── Utility routes ───────────────────────────────────────────────────────────

router.get('/health', rejectBodyOnGet, validateHealthQuery, (req, res) => {
  return res.json({
    status: 'ok',
    service: 'liquifact-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

router.get('/', (req, res) => {
  return res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    version: 'v1',
    endpoints: {
      health: 'GET /v1/health',
      invoices: 'GET/POST /v1/invoices',
      escrow: 'GET/POST /v1/escrow',
      'escrow-batch': 'POST /v1/escrow/batch',
      sme: 'POST /v1/sme/invoice',
      'api-keys': 'GET /v1/api-keys',
    },
  });
});

// ── Invoice routes ───────────────────────────────────────────────────────────

/**
 * GET /v1/invoices
 *
 * Lists invoices for the authenticated tenant.
 * Active invoices (deleted_at IS NULL) are returned by default.
 * Pass `?includeDeleted=true` to include soft-deleted records.
 *
 * Query params:
 *   includeDeleted  {string} "true" to include soft-deleted records
 *
 * Response 200:
 *   { data: Invoice[], message: string }
 */
router.get('/invoices', extractTenant, async (req, res, next) => {
  try {
    const includeDeleted = req.query.includeDeleted === 'true';
    const invoices = await invoiceService.listInvoices(req.tenantId, { includeDeleted });

    return res.json({
      data: invoices,
      message: includeDeleted
        ? 'Showing all invoices (including deleted).'
        : 'Showing active invoices.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /v1/invoices
 *
 * Creates a new invoice scoped to the authenticated tenant.
 *
 * Request body is validated against `invoiceCreateSchema` (Zod).
 * Validation failures yield a 422 RFC 7807 Problem Details response.
 *
 * Body:
 *   amount    {number}  positive finite number (required)
 *   customer  {string}  buyer / customer name  (required — alias for `buyer`)
 *   buyer     {string}  alternative to `customer`
 *   dueDate   {string}  YYYY-MM-DD  (optional)
 *   currency  {string}  ISO 4217     (optional)
 *   description {string}            (optional)
 *   invoiceNumber {string}          (optional)
 *
 * Response 201:
 *   { data: Invoice, message: string }
 */
router.post('/invoices', extractTenant, async (req, res, next) => {
  try {
    // --- Zod validation -------------------------------------------------------
    const parsed = invoiceCreateSchema.safeParse(req.body);

    if (!parsed.success) {
      const fieldErrors = parseValidationErrors(parsed.error);
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: 'Request body contains invalid or missing fields.',
          instance: req.originalUrl,
          code: 'VALIDATION_ERROR',
          retryable: false,
          retryHint: 'Correct the highlighted fields and retry.',
          fieldErrors,
        }),
      );
    }

    const body = parsed.data;

    // Normalise buyer / customer: prefer `buyer`, fall back to `customer`
    const customerName = (body.buyer || body.customer || '').trim();

    const invoice = await invoiceService.createInvoice(
      {
        amount: body.amount,
        customer: customerName,
        currency: body.currency,
        dueDate: body.dueDate,
        description: body.description,
        invoiceNumber: body.invoiceNumber,
      },
      req.tenantId,
    );

    return res.status(201).json({
      data: invoice,
      message: 'Invoice created successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /v1/escrow/:invoiceId
 *
 * Returns escrow state with derived display fields.
 * Authentication is required for versioned escrow reads.
 */
router.get('/escrow/:invoiceId', escrowReadLimiter, authenticateToken, async (req, res, next) => {
  const startTime = Date.now();
  try {
    const invoiceId = req.params.invoiceId;
    const { result, escrowAddress, error, code, statusCode } = await getEscrowRead(invoiceId);

    if (error) {
      res.status(statusCode).json({ error, code });
      return;
    }

    res.set('X-Escrow-Address', escrowAddress);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /v1/escrow/batch
 *
 * Reads escrow state for a bounded batch of invoice IDs in a single request.
 * Each ID is resolved and read independently: an unmapped invoice ID or a
 * failed on-chain read is reported per-item in `errors` rather than failing
 * the whole batch (mirrors the failure-isolation semantics already used by
 * {@link module:services/escrowBatchRead}).
 *
 * Body:
 *   invoiceIds  {string[]}  1–100 invoice identifiers (required)
 *
 * Response 200:
 *   { data: { results: object[], errors: object[] }, message: string }
 */
router.post('/escrow/batch', authenticateToken, async (req, res, next) => {
  try {
    const parsed = escrowBatchReadSchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors = parseValidationErrors(parsed.error);
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: 'Request body contains invalid or missing fields.',
          instance: req.originalUrl,
          code: 'VALIDATION_ERROR',
          retryable: false,
          retryHint: 'Correct the highlighted fields and retry.',
          fieldErrors,
        }),
      );
    }

    const { invoiceIds } = parsed.data;
    const { results, errors } = await getEscrowReadBatch(invoiceIds);

    return res.json({
      data: { results, errors },
      message: `Processed ${invoiceIds.length} invoice ID(s): ${results.length} succeeded, ${errors.length} failed.`,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /v1/invoices/:id
 *
 * Partially updates an invoice scoped to the authenticated tenant. Field-level
 * guards are applied via `validatePatchFields` which strips unknown keys and
 * enforces the mutable-field set. Attempts to change locked fields for
 * invoices in locked statuses result in a 422 AppError.
 */
router.patch('/invoices/:id', extractTenant, validatePatchFields, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();

    // Validate sanitized payload with Zod update schema
    const parsed = invoiceUpdateSchema.safeParse(req.sanitizedUpdate);
    if (!parsed.success) {
      const fieldErrors = parseValidationErrors(parsed.error);
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: 'Request body contains invalid or missing fields.',
          instance: req.originalUrl,
          code: 'VALIDATION_ERROR',
          retryable: false,
          fieldErrors,
        }),
      );
    }

    // Ensure resource exists and belongs to tenant
    const existing = await invoiceService.getInvoiceById(invoiceId, req.tenantId);
    if (!existing) {
      return next(new AppError({ title: 'Not Found', status: 404, detail: 'Invoice not found' }));
    }

    // Enforce locked-field rules
    const { locked, field } = detectLockedFieldChange(req.sanitizedUpdate, existing.status);
    if (locked) {
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: `Field '\( {field}' cannot be modified when invoice status is ' \){existing.status}'.`,
          instance: req.originalUrl,
          code: 'LOCKED_FIELD',
          retryable: false,
          fieldErrors: { [field]: 'Field is locked for this invoice status' },
        }),
      );
    }

    const updates = parsed.data;
    const updated = await invoiceService.updateInvoice(invoiceId, updates, req.tenantId);

    if (!updated) {
      return next(new AppError({ title: 'Not Found', status: 404, detail: 'Invoice not found' }));
    }

    return res.json({ data: updated, message: 'Invoice updated successfully.' });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /v1/invoices/:id
 *
 * Soft-deletes the invoice by setting `deleted_at`. Scoped to tenant.
 */
router.delete('/invoices/:id', extractTenant, async (req, res, next) => {
  try {
    const invoiceId = String(req.params.id || '').trim();

    const deleted = await invoiceService.deleteInvoice(invoiceId, req.tenantId);
    if (!deleted) {
      return next(new AppError({ title: 'Not Found', status: 404, detail: 'Invoice not found' }));
    }

    return res.json({ data: deleted, message: 'Invoice deleted (soft-delete) successfully.' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
