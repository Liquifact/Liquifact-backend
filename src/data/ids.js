'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * @returns {string} `INV_` + 12 random base32 chars (16 chars, within the
 * contract's 32-char `[A-Za-z0-9_]` invoice id rule)
 */
function newInvoiceId() {
  // 256 is a multiple of 32, so masking the low 5 bits is unbiased.
  const bytes = crypto.randomBytes(12);
  let out = 'INV_';
  for (const b of bytes) {
    out += ALPHABET[b & 31];
  }
  return out;
}

module.exports = { newInvoiceId };
