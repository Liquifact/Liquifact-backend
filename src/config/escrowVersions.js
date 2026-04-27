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

/**
 * Known LiquifactEscrow deployments: semver -> SCHEMA_VERSION (u32).
 * Add a new entry here whenever a wasm upgrade increments SCHEMA_VERSION.
 *
 * @type {Record<string, number>}
 */
const REGISTRY = {
  '1.0.0': 1,
  '1.1.0': 2,
  '1.2.0': 3,
};

/**
 * Stellar contract address pattern (C + 55 base-32 chars).
 * @type {RegExp}
 */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/**
 * Validates a Stellar contract address.
 *
 * @param {string} contractId
 * @returns {boolean}
 */
function isValidContractId(contractId) {
  return typeof contractId === 'string' && CONTRACT_ID_RE.test(contractId);
}

/**
 * Reads SCHEMA_VERSION from the deployed LiquifactEscrow contract via Soroban RPC.
 *
 * Uses `callSorobanContract` for automatic retry on transient errors.
 * Rejects with a structured error on RPC failure — never calls process.exit.
 *
 * @param {string} [contractId] - Contract address. Defaults to ESCROW_CONTRACT_ID env var.
 * @returns {Promise<number>} The on-chain SCHEMA_VERSION integer.
 * @throws {{ code: string, message: string }} On invalid input or RPC failure.
 */
async function getOnChainSchemaVersion(contractId) {
  const id = contractId || process.env.ESCROW_CONTRACT_ID;

  if (!isValidContractId(id)) {
    const err = new Error('Invalid or missing ESCROW_CONTRACT_ID');
    err.code = 'INVALID_CONTRACT_ID';
    throw err;
  }

  try {
    const version = await callSorobanContract(async () => {
      // Real implementation would use SorobanClient to read persistent storage:
      //   const rpc = new SorobanClient.Server(process.env.SOROBAN_RPC_URL);
      //   const key = SorobanClient.xdr.ScVal.scvSymbol('SCHEMA_VERSION');
      //   const { entries } = await rpc.getContractData(id, key);
      //   return Number(entries[0].val.u32());
      //
      // Placeholder: resolved by the caller / test mock.
      throw new Error('RPC_NOT_IMPLEMENTED');
    });
    return version;
  } catch (err) {
    logger.error({ contractId: id, err: err.message }, 'Failed to read on-chain SCHEMA_VERSION');
    const rpcErr = new Error(`RPC read failed: ${err.message}`);
    rpcErr.code = 'RPC_ERROR';
    throw rpcErr;
  }
}

/**
 * Compares an on-chain SCHEMA_VERSION against the registry.
 *
 * @param {number} onChainVersion - Value returned by getOnChainSchemaVersion.
 * @returns {{ status: 'current'|'ahead'|'unknown', knownVersion: string|null }}
 *   - `current`  — matches the highest registry entry.
 *   - `ahead`    — higher than every registry entry; refresh required.
 *   - `unknown`  — not found in registry and not higher than any entry.
 */
function compareVersions(onChainVersion) {
  const entries = Object.entries(REGISTRY); // [semver, schemaVersion]

  if (entries.length === 0) {
    return { status: 'unknown', knownVersion: null };
  }

  // Find the registry entry with the highest SCHEMA_VERSION.
  const maxEntry = entries.reduce((best, cur) =>
    cur[1] > best[1] ? cur : best
  );
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
