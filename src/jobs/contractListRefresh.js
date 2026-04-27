'use strict';

/**
 * @fileoverview Contract list refresh job for LiquifactEscrow wasm upgrades.
 *
 * Reads the on-chain SCHEMA_VERSION, compares it against the registry, and
 * returns a structured result.  Never calls process.exit on error.
 *
 * @module jobs/contractListRefresh
 */

const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const logger = require('../logger');

/**
 * Runs the contract list refresh job.
 *
 * @param {string} [contractId] - Override for ESCROW_CONTRACT_ID.
 * @returns {Promise<{ onChainVersion: number, knownVersion: string|null, status: string }>}
 * @throws On RPC failure or invalid contract ID.
 */
async function runContractListRefresh(contractId) {
  logger.info({ contractId }, 'Starting contract list refresh');

  const onChainVersion = await getOnChainSchemaVersion(contractId);
  const { status, knownVersion } = compareVersions(onChainVersion);

  logger.info({ onChainVersion, knownVersion, status }, 'Contract list refresh complete');

  return { onChainVersion, knownVersion, status };
}

module.exports = { runContractListRefresh };
