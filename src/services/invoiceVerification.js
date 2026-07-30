/**
 * Invoice Verification Service
 * Handles fraud checks and business validation before invoice approval.
 *
 * The fraud-rejection ceiling and manual-review threshold are configuration-driven
 * (see {@link module:config/verificationThresholds}) and support per-tenant
 * overrides. Every non-approval decision carries a stable, machine-readable
 * `reasonCode` so downstream handlers can branch reliably without parsing the
 * human-readable `reason` string.
 */

'use strict';

const {
  resolveThresholds,
  VerificationConfigError,
} = require('../config/verificationThresholds');

/**
 * Stable, machine-readable reason codes for verification decisions.
 *
 * These values are part of the service contract: downstream consumers may switch
 * on them, so existing codes must not be renamed or repurposed. `VERIFIED`
 * outcomes carry no reason code.
 *
 * @readonly
 * @enum {string}
 */
const ReasonCode = Object.freeze({
  /** Payload was missing or not an object. */
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  /** Amount was not a positive, finite number. */
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  /** Customer was missing, not a string, or empty/whitespace. */
  INVALID_CUSTOMER: 'INVALID_CUSTOMER',
  /** Amount exceeded the (per-tenant) fraud-rejection ceiling. */
  AMOUNT_EXCEEDS_FRAUD_CEILING: 'AMOUNT_EXCEEDS_FRAUD_CEILING',
  /** Amount met or exceeded the (per-tenant) manual-review threshold. */
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
  /** Customer string contained suspicious/injection characters. */
  SUSPICIOUS_CUSTOMER: 'SUSPICIOUS_CUSTOMER',
  /** Threshold configuration could not be resolved; failed closed to manual review. */
  CONFIG_UNAVAILABLE: 'CONFIG_UNAVAILABLE',
});

/**
 * Result of an invoice verification.
 * @typedef {Object} VerificationResult
 * @property {string} status - The resulting status: 'VERIFIED', 'REJECTED', or 'MANUAL_REVIEW'.
 * @property {string} [reason] - Human-readable reason for rejection or manual review.
 * @property {string} [reasonCode] - Stable machine-readable code (see {@link ReasonCode}).
 */

/**
 * Options controlling how an invoice is verified.
 * @typedef {Object} VerifyOptions
 * @property {string} [tenantId] - Trusted tenant identifier used to select per-tenant
 *   threshold overrides. MUST come from the authenticated request context, never from
 *   the (untrusted) invoice payload.
 */

/** @type {RegExp} Obvious injection patterns disallowed in the customer field. */
const SUSPICIOUS_PATTERN = /[<>{}$]/;

/**
 * Validates an invoice for fraud and business rules.
 *
 * Decision order (first match wins):
 *   1. Structural validation of the payload, amount, and customer fields.
 *   2. Fraud ceiling: amounts strictly greater than the resolved `fraudCeiling`
 *      are REJECTED ({@link ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING}).
 *   3. Manual review: amounts at or above the resolved `manualReviewThreshold`
 *      require MANUAL_REVIEW ({@link ReasonCode.MANUAL_REVIEW_REQUIRED}).
 *   4. Injection screening of the customer string.
 *
 * Thresholds are resolved from configuration with optional per-tenant overrides
 * (see {@link module:config/verificationThresholds}). If the configuration cannot
 * be resolved the service fails closed to MANUAL_REVIEW
 * ({@link ReasonCode.CONFIG_UNAVAILABLE}) rather than auto-approving or
 * hard-rejecting.
 *
 * Security Assumptions:
 * - The input payload must be an object.
 * - `amount` must be a strictly positive number.
 * - `customer` must be a non-empty string avoiding potentially malicious injection patterns.
 * - Threshold overrides are sourced only from configuration. Any `tenantId` is taken
 *   from the trusted `options` argument; threshold-related fields on the invoice
 *   payload itself are ignored.
 *
 * @param {Object} invoicePayload - The invoice data to verify.
 * @param {number} invoicePayload.amount - The invoice amount in the system's base currency.
 * @param {string} invoicePayload.customer - The customer identifier or name.
 * @param {VerifyOptions} [options] - Verification options (e.g. trusted tenant id).
 * @returns {Promise<VerificationResult>} Returns the verification status, reason, and reason code.
 */
async function verifyInvoice(invoicePayload, options = {}) {
  if (!invoicePayload || typeof invoicePayload !== 'object') {
    return {
      status: 'REJECTED',
      reason: 'Invalid payload structure',
      reasonCode: ReasonCode.INVALID_PAYLOAD,
    };
  }

  const { amount, customer } = invoicePayload;

  // Security: strict type and value checks
  if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
    return {
      status: 'REJECTED',
      reason: 'Invalid amount: must be a positive number',
      reasonCode: ReasonCode.INVALID_AMOUNT,
    };
  }

  if (typeof customer !== 'string' || customer.trim() === '') {
    return {
      status: 'REJECTED',
      reason: 'Invalid customer: must be a non-empty string',
      reasonCode: ReasonCode.INVALID_CUSTOMER,
    };
  }

  // Resolve configured thresholds (with optional per-tenant overrides). The tenant
  // id comes only from the trusted options argument, never from the payload.
  let thresholds;
  try {
    thresholds = resolveThresholds(options ? options.tenantId : undefined);
  } catch (err) {
    if (err instanceof VerificationConfigError) {
      // Fail closed: never auto-approve under broken configuration.
      return {
        status: 'MANUAL_REVIEW',
        reason: 'Threshold configuration unavailable; manual review required',
        reasonCode: ReasonCode.CONFIG_UNAVAILABLE,
      };
    }
    throw err;
  }

  // Business Validation: Fraud Check
  // Reject absurdly high amounts automatically.
  if (amount > thresholds.fraudCeiling) {
    return {
      status: 'REJECTED',
      reason: 'Amount exceeds maximum allowed threshold',
      reasonCode: ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING,
    };
  }

  // Business Validation: Manual Review
  // Require manual review for high value invoices.
  if (amount >= thresholds.manualReviewThreshold) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'High value invoice requires manual approval',
      reasonCode: ReasonCode.MANUAL_REVIEW_REQUIRED,
    };
  }

  // Security: Check for obvious injection patterns in customer string
  if (SUSPICIOUS_PATTERN.test(customer)) {
    return {
      status: 'REJECTED',
      reason: 'Suspicious characters detected in customer data',
      reasonCode: ReasonCode.SUSPICIOUS_CUSTOMER,
    };
  }

  // Verification passed
  return { status: 'VERIFIED' };
}

module.exports = {
  verifyInvoice,
  ReasonCode,
};
