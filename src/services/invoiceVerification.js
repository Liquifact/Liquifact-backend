/**
 * Invoice Verification Service
 * Handles fraud checks and business validation before invoice approval.
 */

/**
 * Result of an invoice verification.
 * @typedef {Object} VerificationResult
 * @property {string} status - The resulting status: 'VERIFIED', 'REJECTED', or 'MANUAL_REVIEW'.
 * @property {string} [reason] - The reason for rejection or manual review, if applicable.
 */

/**
 * Validates an invoice for fraud and business rules.
 * 
 * Security Assumptions:
 * - The input payload must be an object.
 * - `amount` must be a strictly positive number.
 * - `customer` must be a non-empty string avoiding potentially malicious injection patterns.
 * 
 * @param {Object} invoicePayload - The invoice data to verify.
 * @param {number} invoicePayload.amount - The invoice amount in the system's base currency.
 * @param {string} invoicePayload.customer - The customer identifier or name.
 * @returns {Promise<VerificationResult>} Returns the verification status and optional reason.
 */
async function verifyInvoice(invoicePayload) {
  if (!invoicePayload || typeof invoicePayload !== 'object') {
    return { status: 'REJECTED', reason: 'Invalid payload structure' };
  }

  const { amount, customer } = invoicePayload;

  // Security: strict type and value checks
  if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
    return { status: 'REJECTED', reason: 'Invalid amount: must be a positive number' };
  }

  if (typeof customer !== 'string' || customer.trim() === '') {
    return { status: 'REJECTED', reason: 'Invalid customer: must be a non-empty string' };
  }

  // Business Validation: Fraud Check Example
  // Reject absurdly high amounts automatically
  if (amount > 10000000) {
    return { status: 'REJECTED', reason: 'Amount exceeds maximum allowed threshold' };
  }

  // Business Validation: Manual Review Example
  // Require manual review for high value invoices
  if (amount >= 1000000) {
    return { status: 'MANUAL_REVIEW', reason: 'High value invoice requires manual approval' };
  }

  // Security: Check for obvious injection patterns in customer string
  const suspiciousPatterns = /[<>{}$]/;
  if (suspiciousPatterns.test(customer)) {
    return { status: 'REJECTED', reason: 'Suspicious characters detected in customer data' };
  }

  // Verification passed
  return { status: 'VERIFIED' };
}

module.exports = {
  verifyInvoice
};
