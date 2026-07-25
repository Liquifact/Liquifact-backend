'use strict';

/**
 * @fileoverview Contract list refresh job for LiquifactEscrow wasm upgrades.
 *
 * Reads the on-chain SCHEMA_VERSION, compares it against the registry, and
 * returns a structured result.  Never calls process.exit on error.
 *
 * When the on-chain version diverges from the expected/known registry version
 * an operator-facing alert is raised (dedicated metric + `error`-severity log).
 * A version mismatch signals a contract upgrade or an unexpected/rolled-back
 * deployment that the backend may not yet support, so it must not be noticed
 * silently. See {@link raiseVersionMismatchAlert} and `docs/wasm-ops.md`.
 *
 * @module jobs/contractListRefresh
 */

const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const logger = require('../logger');
const { contractWasmVersionMismatchAlertsTotal } = require('../metrics');

/**
 * Comparison statuses that represent a version mismatch (i.e. anything other
 * than `current`). `ahead` — on-chain version is newer than every registry
 * entry; `unknown` — on-chain version is not tracked by the registry.
 *
 * @type {ReadonlySet<string>}
 */
const MISMATCH_STATUSES = new Set(['ahead', 'unknown']);

/**
 * De-dupe state for raised mismatch alerts, keyed by resolved contract id.
 * The value is the last alerted `expected|observed` version-pair signature, so a
 * persistent, already-reported mismatch does not re-alert on every scheduled
 * run. The entry is cleared once the contract's version returns to `current`,
 * allowing a future regression to alert again.
 *
 * @type {Map<string, string>}
 */
const _alertedMismatches = new Map();

/**
 * Builds the de-dupe map key for a contract.
 *
 * @param {string|null} contractId - Resolved contract address (or null).
 * @returns {string} A stable key, falling back to a sentinel for the default.
 */
function dedupeMapKey(contractId) {
  return contractId || '<default>';
}

/**
 * Raises an operator-facing alert for an on-chain wasm version mismatch.
 *
 * Increments the dedicated {@link contractWasmVersionMismatchAlertsTotal} metric
 * and writes an `error`-severity structured log — the severity the existing
 * alerting pipeline consumes — tagged with `alert: 'contract_wasm_version_mismatch'`.
 *
 * The alert is de-duplicated by `(contractId, expected, observed)`: while the
 * same mismatch persists across runs no new alert is emitted. State is reset for
 * a contract once it returns to `current` (see {@link runContractListRefresh}).
 *
 * Security: only non-secret, publicly observable values are surfaced — the
 * contract address (a public on-chain identifier), the expected registry version
 * label, the observed on-chain SCHEMA_VERSION integer, and the status. No RPC
 * URLs, keys, or other secrets are included in the payload.
 *
 * @param {object} params - Alert parameters.
 * @param {string|null} params.contractId - Resolved contract address.
 * @param {number} params.observedVersion - Observed on-chain SCHEMA_VERSION (u32).
 * @param {string|null} params.expectedVersion - Closest known registry semver, or null.
 * @param {'ahead'|'unknown'} params.status - Comparison status driving the alert.
 * @returns {boolean} `true` when a new alert was raised, `false` when de-duped.
 */
function raiseVersionMismatchAlert({ contractId, observedVersion, expectedVersion, status }) {
  const mapKey = dedupeMapKey(contractId);
  const signature = `${expectedVersion || 'none'}|${observedVersion}`;

  if (_alertedMismatches.get(mapKey) === signature) {
    // Same mismatch already alerted — stay quiet to avoid spamming ops.
    return false;
  }
  _alertedMismatches.set(mapKey, signature);

  try {
    contractWasmVersionMismatchAlertsTotal.inc({ status });
  } catch (_e) {
    // Metric backend is optional/best-effort; never let it break the job.
  }

  logger.error(
    {
      alert: 'contract_wasm_version_mismatch',
      contractId: contractId || null,
      expectedVersion: expectedVersion || null,
      observedVersion,
      status,
    },
    'ALERT: on-chain wasm SCHEMA_VERSION mismatch detected'
  );

  return true;
}

/**
 * Clears the version-mismatch alert de-dupe state.
 *
 * Intended for tests and operational resets (e.g. forcing the next run to
 * re-alert on a still-present mismatch).
 *
 * @returns {void}
 */
function resetVersionMismatchAlertState() {
  _alertedMismatches.clear();
}

/**
 * Runs the contract list refresh job.
 *
 * Reads the on-chain SCHEMA_VERSION and compares it to the registry. On a
 * mismatch (`ahead`/`unknown`) it raises a de-duplicated operator alert; on a
 * `current` match it clears any prior alert state for the contract so a future
 * regression re-alerts. A read failure propagates and is **not** treated as a
 * mismatch (no alert is raised).
 *
 * @param {string} [contractId] - Override for ESCROW_CONTRACT_ID.
 * @returns {Promise<{ onChainVersion: number, knownVersion: string|null, status: string }>}
 * @throws On RPC failure or invalid contract ID.
 */
async function runContractListRefresh(contractId) {
  logger.info({ contractId }, 'Starting contract list refresh');

  const onChainVersion = await getOnChainSchemaVersion(contractId);
  const { status, knownVersion } = compareVersions(onChainVersion);

  const resolvedId = contractId || process.env.ESCROW_CONTRACT_ID || null;

  if (MISMATCH_STATUSES.has(status)) {
    raiseVersionMismatchAlert({
      contractId: resolvedId,
      observedVersion: onChainVersion,
      expectedVersion: knownVersion,
      status,
    });
  } else {
    // Versions match — drop any prior alert state so a later regression alerts.
    _alertedMismatches.delete(dedupeMapKey(resolvedId));
  }

  logger.info({ onChainVersion, knownVersion, status }, 'Contract list refresh complete');

  return { onChainVersion, knownVersion, status };
}

module.exports = {
  runContractListRefresh,
  raiseVersionMismatchAlert,
  resetVersionMismatchAlertState,
  MISMATCH_STATUSES,
};
