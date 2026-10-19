'use strict';

const { StrKey } = require('@stellar/stellar-sdk');

/**
 * Stellar address validation helpers. Every helper accepts any value and
 * returns false for non-strings; none of them ever throws or echoes input.
 */

/**
 * @param {unknown} s candidate
 * @returns {boolean} true for a valid ed25519 public key (G...)
 */
function isAccountId(s) {
  return typeof s === 'string' && StrKey.isValidEd25519PublicKey(s);
}

/**
 * @param {unknown} s candidate
 * @returns {boolean} true for a valid contract id (C...)
 */
function isContractId(s) {
  return typeof s === 'string' && StrKey.isValidContract(s);
}

/**
 * @param {unknown} s candidate
 * @returns {boolean} true if the value is a valid secret seed (S...)
 */
function looksLikeSecret(s) {
  return typeof s === 'string' && StrKey.isValidEd25519SecretSeed(s);
}

/**
 * @param {unknown} s candidate
 * @returns {boolean} true for a valid muxed account (M...)
 */
function isMuxedAddress(s) {
  return typeof s === 'string' && StrKey.isValidMed25519PublicKey(s);
}

/**
 * Checks a user-supplied address without ever including it in the result.
 *
 * @param {unknown} s candidate
 * @returns {{ ok: true } | { ok: false, code: string, message: string }} outcome
 */
function checkAddress(s) {
  if (looksLikeSecret(s)) {
    return {
      ok: false,
      code: 'SECRET_KEY_SUBMITTED',
      message:
        'A Stellar secret key was submitted. Treat it as compromised and rotate it immediately; ' +
        'only public addresses (G... or C...) are accepted.',
    };
  }
  if (isMuxedAddress(s)) {
    return {
      ok: false,
      code: 'INVALID_STELLAR_ADDRESS',
      message: 'Muxed (M...) addresses are not supported; use the underlying G... account address.',
    };
  }
  if (isAccountId(s) || isContractId(s)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'INVALID_STELLAR_ADDRESS',
    message: 'smeAddress must be a valid Stellar public key (G...) or contract id (C...)',
  };
}

module.exports = { isAccountId, isContractId, looksLikeSecret, isMuxedAddress, checkAddress };
