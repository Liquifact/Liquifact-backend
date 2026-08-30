/**
 * src/routes/invest.js
 *
 * Routes:
 * GET  /api/invest/opportunities   — list open investment opportunities
 * POST /api/invest/fund-invoice    — fund an invoice via the LiquifactEscrow contract
 *
 * The fund-invoice handler replaces the previous hardcoded mock and now:
 * 1. Validates request body
 * 2. Enforces KYC via requireKycForFunding middleware
 * 3. Evaluates legal hold isolation parameters using legalHoldGate middleware
 * 4. Resolves the escrow contract address from escrowMap
 * 5. Calls escrowSubmit to build / simulate / sign the Soroban call
 * 6. Persists the investor commitment via investorCommitment service
 * 7. Returns the real submission status (requires_signature / submitted / stubbed)
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const responseHelper = require('../utils/responseHelper');
const { authenticatedTenantStack } = require('../middleware/stacks');
const { requireKycForFunding } = require('../middleware/kycGating');
const { legalHoldGate } = require('../middleware/legalHoldGate');
const { resolveEscrowAddress, EscrowNotFoundError } = require('../config/escrowMap');
const { submitFundEscrow, EscrowSubmitError } = require('../services/escrowSubmit');
const { invalidateEscrowReadCache } = require('../services/escrowRead');
const {
  persistCommitment,
  normalizeAmountStroopsInput,
  CommitmentValidationError,
} = require('../services/investorCommitment');
const { listOpportunities } = require('../services/investService');
const idempotencyMiddleware = require('../middleware/idempotency');
const { isValidStellarAddress } = require('../utils/validators');
const { fundingErrorHandler } = require('../middleware/fundingErrorHandler');
const {
  createFundingError,
  FUNDING_ERROR_CODES,
  fundingValidationError,
} = require('../errors/fundingErrors');

const router = express.Router();

// ─── Validation helpers ───────────────────────────────────────────────────────

const INVOICE_ID_RE = /^[a-zA-Z0-9_\-]{3,64}$/;
router.use(...authenticatedTenantStack);

/**
 * Validate fund-invoice request body.
 * Returns an array of human-readable error strings; empty array = valid.
 * @param {object} body - Request body.
 * @returns {string[]} Validation errors.
 */
function validateFundInvoiceBody(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }

  const { invoiceId, investorAddress, amountStroops } = body;

  if (!invoiceId || !INVOICE_ID_RE.test(invoiceId)) {
    errors.push('invoiceId must be an alphanumeric string (3-64 chars, hyphens/underscores allowed).');
  }

  if (!investorAddress || !isValidStellarAddress(investorAddress)) {
    errors.push('investorAddress must be a valid Stellar public key (G... or C...).');
  }

  try {
    normalizeAmountStroopsInput(amountStroops);
  } catch (err) {
    if (err instanceof CommitmentValidationError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  return errors;
}

/**
 * GET /api/invest/opportunities — list open investment opportunities
 *
 * Retrieves a paginated list of invoices available for funding, scoped to the
 * authenticated tenant. Each opportunity is enriched with live on-chain escrow
 * state via batched Soroban contract reads. Invoices are filtered to
 * {@link PUBLIC_INVESTABLE_INVOICE_STATUSES} only; non-investable statuses are
 * never exposed. Per-invoice on-chain read failures are tolerated — the invoice
 * is still returned with default on-chain pointers rather than 500'ing the
 * entire list.
 *
 * @param {import('express').Request} req - Express request with `req.tenantId`
 *   set by the `authenticatedTenantStack` middleware.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>} Responds with a JSON envelope containing `data`
 *   (array of {@link InvestmentOpportunity} DTOs) and pagination `meta`.
 */
/**
 * @swagger
 * /api/invest/opportunities:
 *   get:
 *     operationId: listInvestOpportunities
 *     summary: List open investment opportunities
 *     description: |
 *       Retrieve a paginated list of invoices available for funding.
 *       Returns tenant-scoped invoices with verified status and open funding slots.
 *     tags: [Invest]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number (1-based)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Investment opportunities retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardEnvelope'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 */
router.get(
  '/opportunities',
  asyncHandler(async (req, res) => {
    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;

    const result = await listOpportunities({
      tenantId: req.tenantId,
      page,
      limit,
    });

    return res.json({
      ...responseHelper.success(result.data, result.meta),
      message: 'Investment opportunities retrieved successfully.',
    });
  })
);

// ─── POST /api/invest/fund-invoice ───────────────────────────────────────────

/**
 * @swagger
 * /api/invest/fund-invoice:
 *   post:
 *     operationId: fundInvoice
 *     summary: Fund an invoice through the configured escrow contract
 *     tags: [Invest]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [invoiceId, investorAddress, amountStroops]
 *             additionalProperties: true
 *             properties:
 *               invoiceId:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 64
 *                 pattern: '^[A-Za-z0-9_-]+$'
 *               investorAddress:
 *                 type: string
 *                 description: Stellar account or contract address.
 *               amountStroops:
 *                 type: string
 *                 pattern: '^[1-9][0-9]*$'
 *                 maxLength: 19
 *                 description: Digits-only stroop amount, no signs/decimals/scientific notation/leading zeros, and <= 10^18.
 *     responses:
 *       201:
 *         description: Funding request accepted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FundInvoiceResponse'
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       404:
 *         description: No escrow mapping exists for the invoice
 *       409:
 *         description: Funding commitment conflicts with an existing write
 *       502:
 *         description: Escrow transaction preparation failed
 *       503:
 *         description: Legal-hold status could not be verified
 */
router.post(
  '/fund-invoice',
  requireKycForFunding,
  idempotencyMiddleware,
  asyncHandler(async (req, res) => {
    // 1. Input validation
    const validationErrors = validateFundInvoiceBody(req.body);
    if (validationErrors.length > 0) {
      throw fundingValidationError(validationErrors);
    }

    const { invoiceId, investorAddress } = req.body;
    const amountStroops = normalizeAmountStroopsInput(req.body.amountStroops);

    // 2. Intercept execution via legalHoldGate before executing any Soroban network mutations
    // We invoke the check inline manually here to ensure it aligns perfectly within the validated payload lifecycle
    const gateHandler = legalHoldGate();
    await new Promise((resolve, reject) => {
      gateHandler(req, res, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });

    // If the gate intercepted the response (e.g., returned a 423), stop execution processing immediately
    if (res.headersSent) {
      return;
    }

    // 3. Resolve the escrow contract address
    let escrowAddress;
    try {
      escrowAddress = resolveEscrowAddress(invoiceId);
    } catch (err) {
      if (err instanceof EscrowNotFoundError) {
        throw createFundingError(
          FUNDING_ERROR_CODES.ESCROW_NOT_FOUND,
          'The escrow contract for this invoice was not found.',
          { retryable: false },
        );
      }
      throw err; // unexpected config error → 500 via errorHandler
    }

    // 4. Build idempotency key — deterministic per (investor, invoice, amount)
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${investorAddress}:${invoiceId}:${amountStroops}`)
      .digest('hex');

    // 5. Call escrowSubmit — builds, simulates, and optionally signs + broadcasts
    let submitResult;
    try {
      submitResult = await submitFundEscrow({
        escrowAddress,
        investorAddress,
        amountStroops,
        invoiceId,
      });
    } catch (err) {
      if (err instanceof EscrowSubmitError) {
        throw createFundingError(
          FUNDING_ERROR_CODES.ESCROW_SUBMIT_FAILED,
          'The escrow transaction could not be prepared. Please retry.',
          { retryable: true },
        );
      }
      throw err;
    }

    // 6. Persist commitment (idempotency-safe)
    const commitment = await persistCommitment({
      invoiceId,
      investorAddress,
      escrowAddress,
      amountStroops,
      status: submitResult.status,
      unsignedXdr: submitResult.unsignedXdr,
      txHash: submitResult.txHash,
      ledger: submitResult.ledger,
      idempotencyKey,
    });

    // A successful escrow write makes any previously cached read stale.
    await invalidateEscrowReadCache(invoiceId);

    // 7. Return real status — never return internal detail fields like idempotencyKey
    return res.status(200).json({
      commitmentId: commitment.id,
      invoiceId,
      escrowAddress,
      status: submitResult.status,
      // Delegated mode: client needs this to sign and broadcast
      ...(submitResult.unsignedXdr && { unsignedXdr: submitResult.unsignedXdr }),
      // Custodial / submitted mode: transaction is on-chain
      ...(submitResult.txHash && { txHash: submitResult.txHash }),
      ...(submitResult.ledger && { ledger: submitResult.ledger }),
    });
  })
);

// Keep all funding failures on one response contract. This must be after the
// route declarations so errors from auth-adjacent funding middleware and the
// async handler both reach the same classifier before global middleware.
router.use(fundingErrorHandler);

module.exports = router;
