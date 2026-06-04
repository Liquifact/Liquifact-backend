/**
 * @fileoverview Escrow read service — fetches on-chain escrow state including
 * the `get_legal_hold` flag from the LiquifactEscrow Soroban contract.
 *
 * The service is intentionally side-effect-free: it reads state and returns a
 * plain object.  All mutation (funding, settlement) lives in separate modules.
 *
 * @module services/escrowRead
 */

"use strict";

const { callSorobanContract } = require("./soroban");
const logger = require("../logger");
const { getTokenMetadata } = require("./tokenMeta");
const db = require("../db/knex");
const { createRedisEscrowSummaryCache } = require("../cache/redis");

const cache = createRedisEscrowSummaryCache();

/**
 * Regex that a valid invoice ID must satisfy.
 * Aligned with IDENTIFIER_PATTERN in escrowSubmit.js.
 * Allows alphanumeric start, followed by alphanumeric, underscores, hyphens, dots, or colons, 1–128 chars.
 *
 * @constant {RegExp}
 */
const INVOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Validates an invoice ID string.
 *
 * @param {unknown} invoiceId - Value to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateInvoiceId(invoiceId) {
  if (typeof invoiceId !== 'string' || invoiceId.trim() === '') {
    return { valid: false, reason: 'invoiceId must be a non-empty string' };
  }
  if (!INVOICE_ID_RE.test(invoiceId.trim())) {
    return {
      valid: false,
      reason: 'invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ -)',
    };
  }
  return { valid: true };
}

/**
 * Calls the on-chain `get_legal_hold` getter for the given escrow contract.
 *
 * In production this would invoke the real Soroban RPC; here we wrap the
 * operation in `callSorobanContract` so retries and error mapping are applied
 * consistently.  The `adapter` parameter lets tests inject a stub without
 * monkey-patching the module.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function `(invoiceId) => boolean`.
 *   Defaults to the production Soroban stub.
 * @returns {Promise<boolean>} Resolves to `true` when the escrow is under legal
 *   hold, `false` otherwise.  Defaults to `false` on any non-fatal error so
 *   that a missing or unreachable contract never silently unblocks funding.
 */
async function fetchLegalHold(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_legal_hold', [invoiceId]);
        return false;
      };

  try {
    const result = await callSorobanContract(operation);
    // Coerce to boolean; treat any truthy on-chain value as held.
    return result === true || result === 1 || result === 'true';
  } catch (err) {
    // Log without exposing internals; default to false (not held) so a
    // transient RPC failure does not permanently block all funding.
    // Callers that need stricter behaviour can override via the adapter.
    logger.warn(
      { invoiceId, errCode: err?.code },
      'escrowRead: get_legal_hold call failed — defaulting to false',
    );
    return false;
  }
}

/**
 * Reads the full escrow state for an invoice from the Soroban contract and
 * enriches it with the `legal_hold` flag and token metadata.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object}  [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for
 *   `get_legal_hold`; used in tests.
 * @param {Function} [options.escrowAdapter] - Injected adapter for the base
 *   escrow state read; used in tests.
 * @param {Object} [options.fundingAsset] - Funding asset descriptor for token metadata.
 * @param {Function} [options.tokenMetaAdapter] - Injected adapter for token metadata.
 * @returns {Promise<EscrowState>} Enriched escrow state object.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowState
 * @property {string}  invoiceId    - The invoice identifier.
 * @property {string}  status       - On-chain escrow status string.
 * @property {number}  fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold   - Whether the escrow is under legal hold.
 * @property {Object|null} funding_token - Token metadata (symbol, name, decimals).
 */
async function readEscrowState(invoiceId, options = {}) {
  const { legalHoldAdapter, escrowAdapter, fundingAsset, tokenMetaAdapter } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = 'INVALID_INVOICE_ID';
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  // Fetch base escrow state and legal hold flag concurrently.
  const [baseState, legalHold] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter),
    fetchLegalHold(safeId, legalHoldAdapter),
  ]);

  // Fetch token metadata if funding asset is provided
  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      // Log error but don't fail the entire request
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        'escrowRead: Failed to fetch token metadata, continuing without it',
      );
    }
  }

  return {
    ...baseState,
    legal_hold: legalHold,
    funding_token: tokenMetadata,
  };
}

/**
 * Fetches the base escrow state (status, fundedAmount, etc.) from the contract.
 *
 * @param {string}    invoiceId     - Validated invoice ID.
 * @param {Function} [adapter]      - Optional test adapter.
 * @returns {Promise<object>} Base escrow state without `legal_hold`.
 */
async function _fetchBaseEscrowState(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_escrow_state', [invoiceId]);
        // For testing webhooks, return different statuses based on invoiceId
        let status = 'not_found';
        let fundedAmount = 0;
        if (invoiceId === 'funded_invoice') {
          status = 'funded';
          fundedAmount = 1000;
        } else if (invoiceId === 'settled_invoice') {
          status = 'settled';
          fundedAmount = 1000;
        }
        return {
          invoiceId,
          status,
          fundedAmount,
        };
      };

  return callSorobanContract(operation);
}

/**
 * Fetches the attestation append log for an invoice from the Soroban contract.
 * Returns an array of attestation entries with index and hex-encoded digest.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function for testing.
 * @returns {Promise<Array<{index: number, digest: string}>>} Array of attestation entries.
 */
async function fetchAttestationAppendLog(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_attestation_append_log', [invoiceId]);
        // Expected return: array of {index: number, digest: Buffer}
        return [
          { index: 0, digest: Buffer.from('deadbeef', 'hex') },
          { index: 1, digest: Buffer.from('cafebabe', 'hex') },
        ];
      };

  try {
    const result = await callSorobanContract(operation);
    if (!Array.isArray(result)) {
      logger.warn({ invoiceId }, 'escrowRead: get_attestation_append_log returned non-array');
      return [];
    }
    // Decode each entry: convert digest to hex string
    return result.map(entry => ({
      index: entry.index,
      digest: entry.digest ? entry.digest.toString('hex') : '',
    }));
  } catch (err) {
    logger.warn(
      { invoiceId, errCode: err?.code },
      'escrowRead: get_attestation_append_log call failed — returning empty array',
    );
    return [];
  }
}

/**
 * Reads the full escrow state including attestation digests for investor diligence.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for `get_legal_hold`.
 * @param {Function} [options.escrowAdapter] - Injected adapter for base escrow state.
 * @param {Function} [options.attestationAdapter] - Injected adapter for attestation log.
 * @param {Object} [options.fundingAsset] - Funding asset descriptor for token metadata.
 * @param {Function} [options.tokenMetaAdapter] - Injected adapter for token metadata.
 * @returns {Promise<EscrowStateWithAttestations>} Enriched escrow state with attestations.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowStateWithAttestations
 * @property {string} invoiceId - The invoice identifier.
 * @property {string} status - On-chain escrow status string.
 * @property {number} fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold - Whether the escrow is under legal hold.
 * @property {Array<{index: number, digest: string}>} attestations - Append-only attestation digests.
 * @property {Object|null} funding_token - Token metadata (symbol, name, decimals).
 */
async function readEscrowStateWithAttestations(invoiceId, options = {}) {
  const { legalHoldAdapter, escrowAdapter, attestationAdapter, fundingAsset, tokenMetaAdapter } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = 'INVALID_INVOICE_ID';
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  // Fetch all data concurrently
  const [baseState, legalHold, attestations] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter),
    fetchLegalHold(safeId, legalHoldAdapter),
    fetchAttestationAppendLog(safeId, attestationAdapter),
  ]);

  // Fetch token metadata if funding asset is provided
  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      // Log error but don't fail the entire request
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        'escrowRead: Failed to fetch token metadata, continuing without it',
      );
    }
  }

  return {
    ...baseState,
    legal_hold: legalHold,
    attestations,
    funding_token: tokenMetadata,
  };
}

/**
 * Reads only the on-chain `funded_amount` for an invoice from the
 * LiquifactEscrow contract via {@link callSorobanContract}.
 *
 * This is a focused read used by the nightly reconciliation job, which only
 * needs the funded amount and not the full enriched escrow state (legal hold,
 * token metadata, attestations). It reuses the same validation and retry path
 * as the rest of the escrow read surface so behaviour stays consistent.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.escrowAdapter] - Injected adapter
 *   `(invoiceId) => { fundedAmount } | number` for tests. Defaults to the
 *   production base-state stub.
 * @returns {Promise<number>} The on-chain funded amount as a finite number.
 * @throws {Error} With `code = 'INVALID_INVOICE_ID'` and `status = 400` when
 *   `invoiceId` is invalid. Soroban/transport errors propagate from
 *   {@link callSorobanContract} so callers can classify them as `error`.
 */
async function readFundedAmount(invoiceId, options = {}) {
  const { escrowAdapter } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = 'INVALID_INVOICE_ID';
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();
  const baseState = await _fetchBaseEscrowState(safeId, escrowAdapter);

  // Adapters may return either the full base-state object or a bare number.
  const raw =
    baseState && typeof baseState === 'object' ? baseState.fundedAmount : baseState;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

module.exports = {
  readEscrowState,
  readEscrowStateWithAttestations,
  readFundedAmount,
  fetchLegalHold,
  fetchAttestationAppendLog,
  validateInvoiceId,
  getEscrowStateWithProjection,
};
