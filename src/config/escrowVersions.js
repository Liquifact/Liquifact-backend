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
 * @type {Record<string, number>}
 */
const REGISTRY = {
  '1.0.0': 1,
  '1.1.0': 2,
  '1.2.0': 3,
};

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
  const id = contractId || process.env.ESCROW_CONTRACT_ID;

  if (!isValidContractId(id)) {
    const err = new Error('Invalid or missing ESCROW_CONTRACT_ID');
    err.code = 'INVALID_CONTRACT_ID';
    throw err;
  }

  try {
    /**
     * Read the persistent `SCHEMA_VERSION` Symbol key from the contract.
     *
     * The Stellar SDK's `SorobanRpc.Server.getContractData` accepts:
     *   - contract: the StrKey-encoded contract address
     *   - key:      an ScVal identifying the storage key
     *   - durability: 'persistent' | 'temporary'
     *
     * It resolves to an `LedgerEntryResult` whose `.val` is the raw ScVal.
     * We decode it with `.u32()` since SCHEMA_VERSION is always a u32.
     *
     * @returns {Promise<number>}
     */
    const version = await callSorobanContract(async () => {
      const { SorobanRpc, xdr, Contract } = require('@stellar/stellar-sdk');
      const rpcUrl = process.env.SOROBAN_RPC_URL;
      const server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
      const key = xdr.ScVal.scvSymbol('SCHEMA_VERSION');
      const contract = new Contract(id);
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contract.address().toScAddress(),
          key,
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      const response = await server.getLedgerEntries(ledgerKey);
      if (!response.entries || response.entries.length === 0) {
        throw new Error('SCHEMA_VERSION not found in contract persistent storage');
      }
      return response.entries[0].val.contractData().val().u32();
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
