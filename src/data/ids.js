'use strict';

const crypto = require('node:crypto');

/** RFC 4648 base32 alphabet (A–Z, 2–7). */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generates an invoice id: `INV_` + 12-char base32 (fits the contract's
 * 32-char `[A-Za-z0-9_]` invoice id rule).
 *
 * @returns {string} new invoice id
 */
function generateInvoiceId() {
  const bytes = crypto.randomBytes(12);
  let suffix = '';
  for (let i = 0; i < 12; i += 1) {
    suffix += BASE32[bytes[i] % 32];
  }
  return `INV_${suffix}`;
}

module.exports = { generateInvoiceId };
