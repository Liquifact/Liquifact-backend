'use strict';

/**
 * @fileoverview LiquifactEscrow wasm version registry and on-chain comparison.
 *
 * Maps known semver release tags to their expected on-chain SCHEMA_VERSION
 * (a u32 stored in the contract's persistent storage).
 *
 * @module config/escrowVersions
 */

const { callSorobanContract } = require('../services/soroban');
const logger = require('../logger');
const { isValidStellarContractAddress } = require('../utils/validators');

/**
 * Known LiquifactEscrow deployments: semver -> SCHEMA_VERSION (u32).
 * Add a new entry here whenever a wasm upgrade increments SCHEMA_VERSION.
 *
 * Runtime updates are unsupported; change this source and redeploy.
 * @type {Readonly<Record<string, number>>}
 */
const REGISTRY = Object.freeze({
  '1.0.0': 1,
  '1.1.0': 2,
  '1.2.0': 3,
});

const MAX_SCHEMA_VERSION = 0xffffffff;

/**
 * Validates schema versions before classification or alerting.
 *
 * @description Rejects coercible values and enforces the full Stellar u32 domain.
 * Zero is a valid unregistered version; strings and boxed numbers are not versions.
 * @param {unknown} value - Untrusted schema version.
 * @returns {number} The validated primitive integer.
 */
function validateSchemaVersion(value) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SCHEMA_VERSION
  ) {
    const err = new Error('SCHEMA_VERSION must be an integer between 0 and 4294967295');
    err.code = 'INVALID_SCHEMA_VERSION';
    throw err;
  }
  return value;
}

/**
 * Checks RPC configuration without exposing its contents.
 *
 * @description Validates RPC configuration before retrying any network request.
 * @param {unknown} value - Configured RPC URL (never included in diagnostics).
 * @returns {URL} Parsed HTTP(S) endpoint.
 */
function validateRpcUrl(value) {
  try {
    if (typeof value !== 'string' || !value || value.trim() !== value) {
      throw new Error();
    }
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error();
    }
    return url;
  } catch (_err) {
    const err = new Error('Invalid SOROBAN_RPC_URL configuration');
    err.code = 'INVALID_RPC_URL';
    throw err;
  }
}

/**
 * Validates a Stellar contract address.
 *
 * @param {string} contractId
 * @returns {boolean}
 */
function isValidContractId(contractId) {
  return isValidStellarContractAddress(contractId);
}

/**
 * Reads SCHEMA_VERSION from the deployed LiquifactEscrow contract via Soroban RPC.
 *
 * Fetches persistent contract data for the key `SCHEMA_VERSION` (a Symbol ScVal)
 * and decodes the returned XDR value as a u32.  Uses `callSorobanContract` for
 * automatic retry on transient errors.
 *
 * Rejects with a structured error on RPC failure — never calls process.exit.
 *
 * @param {string} [contractId] - Contract address (C…56 chars). Defaults to
 *   `ESCROW_CONTRACT_ID` env var.
 * @returns {Promise<number>} The on-chain SCHEMA_VERSION u32.
 * @throws {{ code: 'INVALID_CONTRACT_ID'|'RPC_ERROR', message: string }}
 */
async function getOnChainSchemaVersion(contractId) {
  const id = contractId === undefined ? process.env.ESCROW_CONTRACT_ID : contractId;

  if (!isValidContractId(id)) {
    const err = new Error('Invalid or missing ESCROW_CONTRACT_ID');
    err.code = 'INVALID_CONTRACT_ID';
    throw err;
  }

  try {
    const rpcUrl = validateRpcUrl(process.env.SOROBAN_RPC_URL);
    const version = await callSorobanContract(async () => {
      const { xdr, Address } = require('@stellar/stellar-sdk');
      const { Server } = require('@stellar/stellar-sdk/rpc');
      const server = new Server(rpcUrl.href, { allowHttp: rpcUrl.protocol === 'http:' });
      const key = xdr.ScVal.scvSymbol('SCHEMA_VERSION');
      const contract = new Address(id).toScAddress();
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract,
          key,
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const response = await server.getLedgerEntries(ledgerKey);
      try {
        // A one-key request must produce one persistent contract-data u32 entry.
        if (!response || !Array.isArray(response.entries) || response.entries.length !== 1) {
          throw new Error();
        }
        const data = response.entries[0].val.contractData();
        if (
          data.contract().toXDR('base64') !== contract.toXDR('base64') ||
          data.key().toXDR('base64') !== key.toXDR('base64') ||
          data.durability().name !== 'persistent'
        ) {
          throw new Error();
        }
        const scVal = data.val();
        if (scVal.switch().name !== 'scvU32') {
          throw new Error();
        }
        return validateSchemaVersion(scVal.u32());
      } catch (_err) {
        const err = new Error('Invalid or missing SCHEMA_VERSION ledger entry');
        err.code = 'INVALID_RPC_RESPONSE';
        throw err;
      }
    });
    // Also validate wrapper output; no malformed version can reach comparison/alerts.
    return validateSchemaVersion(version);
  } catch (err) {
    const reason = ['INVALID_RPC_URL', 'INVALID_RPC_RESPONSE', 'INVALID_SCHEMA_VERSION'].includes(
      err?.code,
    )
      ? err.code
      : 'UPSTREAM_FAILURE';
    // SDK errors may contain credentials, URLs or response bodies. Log bounded codes only.
    logger.error({ contractId: id, reason }, 'Failed to read on-chain SCHEMA_VERSION');
    const rpcErr = new Error('Soroban RPC schema version read failed');
    rpcErr.code = 'RPC_ERROR';
    throw rpcErr;
  }
}

/**
 * Classifies a validated on-chain version against known releases.
 *
 * @description Compares a primitive u32 SCHEMA_VERSION against the immutable registry.
 * @throws {Error} INVALID_SCHEMA_VERSION for non-integers or values outside u32.
 *
 * @param {number} onChainVersion - Value returned by getOnChainSchemaVersion.
 * @returns {{ status: 'current'|'ahead'|'unknown', knownVersion: string|null }}
 *   - `current`  — matches the highest registry entry.
 *   - `ahead`    — higher than every registry entry; refresh required.
 *   - `unknown`  — not found in registry and not higher than any entry.
 */
function compareVersions(onChainVersion) {
  validateSchemaVersion(onChainVersion);
  const entries = Object.entries(REGISTRY); // [semver, schemaVersion]

  // Find the registry entry with the highest SCHEMA_VERSION.
  const maxEntry = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  const maxSchemaVersion = maxEntry[1];
  const maxSemver = maxEntry[0];

  if (onChainVersion === maxSchemaVersion) {
    return { status: 'current', knownVersion: maxSemver };
  }

  if (onChainVersion > maxSchemaVersion) {
    return { status: 'ahead', knownVersion: maxSemver };
  }

  // Check if it matches any lower entry.
  const match = entries.find(([, v]) => v === onChainVersion);
  return { status: 'unknown', knownVersion: match ? match[0] : null };
}

module.exports = {
  REGISTRY,
  getOnChainSchemaVersion,
  compareVersions,
  isValidContractId,
};
