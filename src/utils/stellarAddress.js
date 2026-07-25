'use strict';

const { StrKey } = require('@stellar/stellar-sdk');

/**
 * @fileoverview Shared Stellar StrKey address validation helpers.
 *
 * The Liquifact backend accepts two StrKey address families in different
 * contexts:
 * - Account public keys, which start with `G`
 * - Soroban contract addresses, which start with `C`
 *
 * These helpers validate full StrKey values, not just a permissive prefix
 * regex. That means the encoded payload and checksum must both be valid.
 *
 * @module utils/stellarAddress
 */

/**
 * Returns whether a value is a valid Stellar account public key (`G...`).
 *
 * @param {unknown} value - Candidate account public key.
 * @returns {boolean} `true` when the value is a well-formed `G...` address.
 */
function isValidStellarAccountAddress(value) {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

/**
 * Returns whether a value is a valid Stellar Soroban contract address (`C...`).
 *
 * @param {unknown} value - Candidate contract address.
 * @returns {boolean} `true` when the value is a well-formed `C...` address.
 */
function isValidStellarContractAddress(value) {
  return typeof value === 'string' && StrKey.isValidContract(value);
}

/**
 * Returns whether a value is a valid Stellar StrKey address accepted by
 * Liquifact in wallet/escrow contexts (`G...` account or `C...` contract).
 *
 * Example accepted values:
 * - `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
 * - `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
 *
 * Lowercase, wrong-length, whitespace-padded, mixed-prefix, and checksum-invalid
 * strings are rejected.
 *
 * @param {unknown} value - Candidate Stellar account or contract address.
 * @returns {boolean} `true` when the value is a well-formed `G...` or `C...` StrKey.
 */
function isValidStellarAddress(value) {
  return isValidStellarAccountAddress(value) || isValidStellarContractAddress(value);
}

module.exports = {
  isValidStellarAccountAddress,
  isValidStellarContractAddress,
  isValidStellarAddress,
};
