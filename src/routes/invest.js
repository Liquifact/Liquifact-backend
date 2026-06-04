/**
 * src/routes/invest.js
 *
 * Routes:
 *   GET  /api/invest/opportunities   — list open investment opportunities
 *   POST /api/invest/fund-invoice    — fund an invoice via the LiquifactEscrow contract
 *
 * The fund-invoice handler replaces the previous hardcoded mock and now:
 *   1. Validates request body
 *   2. Enforces KYC via requireKycForFunding middleware
 *   3. Resolves the escrow contract address from escrowMap
 *   4. Calls escrowSubmit to build / simulate / sign the Soroban call
 *   5. Persists the investor commitment via investorCommitment service
 *   6. Returns the real submission status (requires_signature / submitted / stubbed)
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requireKycForFunding } = require('../middleware/kyc');
const { resolveEscrowAddress, EscrowNotFoundError } = require('../config/escrowMap');
const { submitFundEscrow, EscrowSubmitError } = require('../services/escrowSubmit');
const { persistCommitment } = require('../services/investorCommitment');

const router = express.Router();

// ─── Validation helpers ───────────────────────────────────────────────────────

const INVOICE_ID_RE = /^[a-zA-Z0-9_\-]{3,64}$/;
const STELLAR_ADDRESS_RE = /^[CG][A-Z2-7]{55}$/;

router.use(authenticateToken, extractTenant);

/**
 * Validate fund-invoice request body.
 * Returns an array of human-readable error strings; empty array = valid.
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

  if (!investorAddress || !STELLAR_ADDRESS_RE.test(investorAddress)) {
    errors.push('investorAddress must be a valid Stellar public key (G... or C...).');
  }

  // amountStroops: must be a positive integer (as number or numeric string)
  const parsed = Number(amountStroops);
  if (!amountStroops || !Number.isInteger(parsed) || parsed <= 0) {
    errors.push('amountStroops must be a positive integer representing the fund amount in stroops.');
  }

  return errors;
}

// ─── GET /api/invest/opportunities ───────────────────────────────────────────

router.get(
  '/opportunities',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Placeholder — replace with real marketplace query in a future issue
    res.json({
      opportunities: [],
      meta: { total: 0, page: 1 },
    });
  })
);

// ─── POST /api/invest/fund-invoice ───────────────────────────────────────────

router.post(
  '/fund-invoice',
  requireAuth,
  requireKycForFunding,
  asyncHandler(async (req, res) => {
    // 1. Input validation
    const validationErrors = validateFundInvoiceBody(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: validationErrors[0],
          details: validationErrors,
          retryable: false,
        },
      });
    }

    const { invoiceId, investorAddress, amountStroops } = req.body;

    // 2. Resolve the escrow contract address
    let escrowAddress;
    try {
      escrowAddress = resolveEscrowAddress(invoiceId);
    } catch (err) {
      if (err instanceof EscrowNotFoundError) {
        return res.status(422).json({
          error: {
            code: 'ESCROW_NOT_FOUND',
            message: `No escrow contract is configured for invoice: ${invoiceId}`,
            retryable: false,
          },
        });
      }
      throw err; // unexpected config error → 500 via errorHandler
    }

    // 3. Build idempotency key — deterministic per (investor, invoice, amount)
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${investorAddress}:${invoiceId}:${amountStroops}`)
      .digest('hex');

    // 4. Call escrowSubmit — builds, simulates, and optionally signs + broadcasts
    let submitResult;
    try {
      submitResult = await submitFundEscrow({
        escrowAddress,
        investorAddress,
        amountStroops: String(amountStroops),
        invoiceId,
      });
    } catch (err) {
      if (err instanceof EscrowSubmitError) {
        return res.status(502).json({
          error: {
            code: 'ESCROW_SUBMIT_FAILED',
            message: 'Failed to prepare the escrow transaction. Please try again.',
            // Do NOT expose err.message to the client — it may contain RPC details
            retryable: true,
          },
        });
      }
      throw err;
    }

    // 5. Persist commitment (idempotency-safe)
    const commitment = await persistCommitment({
      invoiceId,
      investorAddress,
      escrowAddress,
      amountStroops: String(amountStroops),
      status: submitResult.status,
      unsignedXdr: submitResult.unsignedXdr,
      txHash: submitResult.txHash,
      ledger: submitResult.ledger,
      idempotencyKey,
    });

    // 6. Return real status — never return internal detail fields like idempotencyKey
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

module.exports = router;