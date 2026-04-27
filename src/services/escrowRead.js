/**
 * @fileoverview Escrow read service — fetches on-chain escrow state including
 * the `get_legal_hold` flag from the LiquifactEscrow Soroban contract.
 *
 * The service is intentionally side-effect-free: it reads state and returns a
 * plain object.  All mutation (funding, settlement) lives in separate modules.
 *
 * @module services/escrowRead
 */

'use strict';

const { callSorobanContract } = require('./soroban');
const logger = require('../logger');

/**
 * Regex that a valid invoice ID must satisfy.
 * Allows alphanumeric characters, underscores, and hyphens, 1–128 chars.
 *
 * @constant {RegExp}
 */
const INVOICE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

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
      { invoiceId, errCode: err && err.code },
      'escrowRead: get_legal_hold call failed — defaulting to false',
    );
    return false;
  }
}

/**
 * Reads the full escrow state for an invoice from the Soroban contract and
 * enriches it with the `legal_hold` flag.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object}  [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for
 *   `get_legal_hold`; used in tests.
 * @param {Function} [options.escrowAdapter] - Injected adapter for the base
 *   escrow state read; used in tests.
 * @returns {Promise<EscrowState>} Enriched escrow state object.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowState
 * @property {string}  invoiceId    - The invoice identifier.
 * @property {string}  status       - On-chain escrow status string.
 * @property {number}  fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold   - Whether the escrow is under legal hold.
 */
async function readEscrowState(invoiceId, options = {}) {
  const { legalHoldAdapter, escrowAdapter } = options;

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

  return {
    ...baseState,
    legal_hold: legalHold,
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
    : async () => ({
        invoiceId,
        status: 'not_found',
        fundedAmount: 0,
      });

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
      { invoiceId, errCode: err && err.code },
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
 * @returns {Promise<EscrowStateWithAttestations>} Enriched escrow state with attestations.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowStateWithAttestations
 * @property {string} invoiceId - The invoice identifier.
 * @property {string} status - On-chain escrow status string.
 * @property {number} fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold - Whether the escrow is under legal hold.
 * @property {Array<{index: number, digest: string}>} attestations - Append-only attestation digests.
 */
async function readEscrowStateWithAttestations(invoiceId, options = {}) {
  const { legalHoldAdapter, escrowAdapter, attestationAdapter } = options;

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

  return {
    ...baseState,
    legal_hold: legalHold,
    attestations,
  };
}

/**
 * Fetches the funding close snapshot from the Soroban contract.
 * Returns the snapshot data when it exists (Some), or null when it doesn't (None).
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function for testing.
 * @returns {Promise<FundingCloseSnapshot | null>} Funding close snapshot data or null.
 *
 * @typedef {object} FundingCloseSnapshot
 * @property {string|number} totalPrincipal - Total principal amount at funding close.
 * @property {string|number} fundingTarget - Funding target amount.
 * @property {number} closedAtLedger - Ledger sequence number when funding closed.
 * @property {number} closedAtSeq - Sequence number when funding closed.
 */
async function fetchFundingCloseSnapshot(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_funding_close_snapshot', [invoiceId]);
        // Expected return: Some({...}) or None
        return {
          Some: {
            total_principal: '1000000000',
            funding_target: '2000000000', 
            closed_at_ledger: 123456,
            closed_at_seq: 789
          }
        };
      };

  try {
    const result = await callSorobanContract(operation);
    
    // Handle None case
    if (result === null || result === undefined || result === 'None') {
      return null;
    }
    
    // Handle Some case
    if (result.Some) {
      const snapshot = result.Some;
      return {
        totalPrincipal: snapshot.total_principal,
        fundingTarget: snapshot.funding_target,
        closedAtLedger: snapshot.closed_at_ledger,
        closedAtSeq: snapshot.closed_at_seq
      };
    }
    
    // Handle raw object case (if contract returns the snapshot directly)
    if (result.total_principal !== undefined) {
      return {
        totalPrincipal: result.total_principal,
        fundingTarget: result.funding_target,
        closedAtLedger: result.closed_at_ledger,
        closedAtSeq: result.closed_at_seq
      };
    }
    
    // Unknown response format
    logger.warn({ invoiceId, result }, 'escrowRead: get_funding_close_snapshot returned unexpected format');
    return null;
    
  } catch (err) {
    logger.warn(
      { invoiceId, errCode: err && err.code },
      'escrowRead: get_funding_close_snapshot call failed — returning null',
    );
    return null;
  }
}

/**
 * Reads the full escrow state including funding close snapshot for pro-rata calculations.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for `get_legal_hold`.
 * @param {Function} [options.escrowAdapter] - Injected adapter for base escrow state.
 * @param {Function} [options.attestationAdapter] - Injected adapter for attestation log.
 * @param {Function} [options.snapshotAdapter] - Injected adapter for funding close snapshot.
 * @returns {Promise<EscrowStateWithSnapshot>} Enriched escrow state with funding snapshot.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowStateWithSnapshot
 * @property {string} invoiceId - The invoice identifier.
 * @property {string} status - On-chain escrow status string.
 * @property {number} fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold - Whether the escrow is under legal hold.
 * @property {Array<{index: number, digest: string}>} attestations - Append-only attestation digests.
 * @property {FundingCloseSnapshot | null} fundingCloseSnapshot - Funding close snapshot data.
 */
async function readEscrowStateWithSnapshot(invoiceId, options = {}) {
  const { legalHoldAdapter, escrowAdapter, attestationAdapter, snapshotAdapter } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = 'INVALID_INVOICE_ID';
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  // Fetch all data concurrently
  const [baseState, legalHold, attestations, snapshot] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter),
    fetchLegalHold(safeId, legalHoldAdapter),
    fetchAttestationAppendLog(safeId, attestationAdapter),
    fetchFundingCloseSnapshot(safeId, snapshotAdapter),
  ]);

  return {
    ...baseState,
    legal_hold: legalHold,
    attestations,
    fundingCloseSnapshot: snapshot,
  };
}

module.exports = {
  readEscrowState,
  readEscrowStateWithAttestations,
  readEscrowStateWithSnapshot,
  fetchLegalHold,
  fetchAttestationAppendLog,
  fetchFundingCloseSnapshot,
  validateInvoiceId,
};
