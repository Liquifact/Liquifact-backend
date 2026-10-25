'use strict';

const config = require('../config');
const { getRpcServer } = require('../stellar/rpc');

/**
 * Short, non-sensitive error codes reported by the readiness checks. Raw
 * upstream messages (RPC error strings, URLs, stack traces) are never
 * forwarded to callers: a probe tells an operator *what* broke, nothing about
 * how the upstream failed.
 */
const ERROR_CODES = Object.freeze({
  /** The check did not answer within READY_CHECK_TIMEOUT_MS. */
  TIMEOUT: 'TIMEOUT',
  /** The RPC reports a different network than the configured passphrase. */
  PASSPHRASE_MISMATCH: 'PASSPHRASE_MISMATCH',
  /** The latest ledger is older than READY_MAX_LEDGER_AGE_SECONDS. */
  STALE_LEDGER: 'STALE_LEDGER',
  /** The configured escrow contract does not exist on the RPC network. */
  CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
  /** The RPC call failed, timed out or answered something unusable. */
  RPC_ERROR: 'RPC_ERROR',
});

/**
 * Cached readiness result. The probe result (success or failure) is cached so
 * that frequent probes cannot hammer the RPC.
 *
 * @type {{ at: number, promise: Promise<object> } | null}
 */
let cache = null;

/**
 * Races a promise against a timeout.
 *
 * @param {Promise<unknown>} promise work to bound
 * @param {number} timeoutMs milliseconds before the work is abandoned
 * @returns {Promise<unknown>} the work result, or a rejection with code TIMEOUT
 */
function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('readiness check timed out');
      err.code = ERROR_CODES.TIMEOUT;
      reject(err);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/**
 * Maps a thrown error to one of the public error codes.
 *
 * @param {unknown} err error thrown by the RPC client
 * @returns {string} one of ERROR_CODES
 */
function errorCodeFor(err) {
  if (err && (err.code === ERROR_CODES.TIMEOUT || err.name === 'TimeoutError')) {
    return ERROR_CODES.TIMEOUT;
  }
  return ERROR_CODES.RPC_ERROR;
}

/**
 * Normalises a ledger close time to whole unix seconds. RPC builds report it
 * as a string of seconds; millisecond values are accepted as well.
 *
 * @param {unknown} value raw close time
 * @returns {number | null} unix seconds, or null when the value is unusable
 */
function toEpochSeconds(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
}

/**
 * Resolves the close time of the latest ledger.
 *
 * `getLatestLedger` returns the close time on current RPC builds. Older
 * builds omit it, in which case the health endpoint (which reports the close
 * time of the latest ledger) is used, and as a last resort the `getLedgers`
 * endpoint, which always exposes ledger close times.
 *
 * @param {object} server RPC client
 * @param {object} latest result of `getLatestLedger()`
 * @returns {Promise<number | null>} unix seconds, or null when unavailable
 */
async function resolveLedgerCloseTime(server, latest) {
  const direct = toEpochSeconds(latest && latest.closeTime);
  if (direct !== null) {
    return direct;
  }
  try {
    const health = await server.getHealth();
    const fromHealth = toEpochSeconds(health && health.latestLedgerCloseTime);
    if (fromHealth !== null) {
      return fromHealth;
    }
    const sequence = Number(latest && latest.sequence);
    if (typeof server.getLedgers === 'function' && Number.isFinite(sequence)) {
      const ledgers = await server.getLedgers({ startLedger: sequence, pagination: { limit: 1 } });
      const first = ledgers && Array.isArray(ledgers.ledgers) ? ledgers.ledgers[0] : null;
      const fromLedgers = first
        ? toEpochSeconds(first.ledgerCloseTime)
        : toEpochSeconds(ledgers && ledgers.latestLedgerCloseTime);
      if (fromLedgers !== null) {
        return fromLedgers;
      }
    }
  } catch {
    // The close time is best effort: a failure here must not mask the other
    // checks, it only means the ledger age cannot be evaluated.
  }
  return null;
}

/**
 * Checks that the Soroban RPC answers and reports itself as healthy.
 *
 * @param {object} server RPC client
 * @param {number} timeoutMs per-check timeout
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>} check result
 */
async function checkRpc(server, timeoutMs) {
  const startedAt = Date.now();
  try {
    const health = await withTimeout(server.getHealth(), timeoutMs);
    const latencyMs = Date.now() - startedAt;
    if (!health || health.status !== 'healthy') {
      return { ok: false, latencyMs, error: ERROR_CODES.RPC_ERROR };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: errorCodeFor(err) };
  }
}

/**
 * Checks that the RPC serves the network the API is configured for. A
 * mainnet RPC paired with a testnet passphrase (or any other mismatch) makes
 * every simulation fail, so this check compares the passphrase reported by the
 * RPC with the configured one.
 *
 * @param {object} server RPC client
 * @param {number} timeoutMs per-check timeout
 * @param {string} expectedPassphrase configured network passphrase
 * @returns {Promise<{ ok: boolean, expected: string, actual: string | null, error?: string }>} check result
 */
async function checkNetwork(server, timeoutMs, expectedPassphrase) {
  try {
    const network = await withTimeout(server.getNetwork(), timeoutMs);
    const actual = network && typeof network.passphrase === 'string' ? network.passphrase : null;
    if (actual !== null && actual === expectedPassphrase) {
      return { ok: true, expected: expectedPassphrase, actual };
    }
    return { ok: false, expected: expectedPassphrase, actual, error: ERROR_CODES.PASSPHRASE_MISMATCH };
  } catch (err) {
    return { ok: false, expected: expectedPassphrase, actual: null, error: errorCodeFor(err) };
  }
}

/**
 * Checks that the latest ledger is recent enough to be served by a healthy
 * node. A node whose latest ledger is far behind the network is replaying or
 * lagging, and reads through it are not trustworthy.
 *
 * @param {object} server RPC client
 * @param {number} timeoutMs per-check timeout
 * @param {number} maxAgeSeconds maximum accepted ledger age
 * @param {number} now current time in milliseconds
 * @returns {Promise<{ ok: boolean, sequence: number | null, ageSeconds: number | null, error?: string }>} check result
 */
async function checkLedger(server, timeoutMs, maxAgeSeconds, now) {
  try {
    const latest = await withTimeout(server.getLatestLedger(), timeoutMs);
    const sequence = Number(latest && latest.sequence);
    if (!Number.isFinite(sequence)) {
      return { ok: false, sequence: null, ageSeconds: null, error: ERROR_CODES.RPC_ERROR };
    }
    const closeTime = await withTimeout(resolveLedgerCloseTime(server, latest), timeoutMs);
    if (closeTime === null) {
      // The RPC does not expose a ledger close time, so the age cannot be
      // evaluated. The ledger itself is reachable, so this is not a failure.
      return { ok: true, sequence, ageSeconds: null };
    }
    const ageSeconds = Math.max(0, Math.floor(now / 1000 - closeTime));
    if (ageSeconds > maxAgeSeconds) {
      return { ok: false, sequence, ageSeconds, error: ERROR_CODES.STALE_LEDGER };
    }
    return { ok: true, sequence, ageSeconds };
  } catch (err) {
    return { ok: false, sequence: null, ageSeconds: null, error: errorCodeFor(err) };
  }
}

/**
 * Builds the ledger key of a contract instance (its persistent instance
 * entry), the entry `getContractData` looks up.
 *
 * @param {string} contractId escrow contract id
 * @returns {object} the contract instance ledger key
 */
function contractInstanceKey(contractId) {
  const { xdr, Contract } = require('@stellar/stellar-sdk');
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      contract: new Contract(contractId).address().toScAddress(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Checks that the configured escrow contract is deployed on the RPC network.
 *
 * The instance entry is read with `getLedgerEntries` rather than
 * `getContractData`: the SDK maps *every* failure of the latter (a transport
 * error included) to a "contract data not found" error, which would make the
 * probe blame the contract whenever the RPC is simply unreachable.
 * `getLedgerEntries` answers with an empty entry list when the contract does
 * not exist and rejects when the call itself fails.
 *
 * @param {object} server RPC client
 * @param {number} timeoutMs per-check timeout
 * @param {string} contractId configured escrow contract id
 * @returns {Promise<{ ok: boolean, error?: string }>} check result
 */
async function checkContract(server, timeoutMs, contractId) {
  try {
    const result = await withTimeout(
      server.getLedgerEntries(contractInstanceKey(contractId)),
      timeoutMs,
    );
    const entries = result && Array.isArray(result.entries) ? result.entries : [];
    if (entries.length === 0) {
      return { ok: false, error: ERROR_CODES.CONTRACT_NOT_FOUND };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorCodeFor(err) };
  }
}

/**
 * Runs every readiness check in parallel and aggregates the outcome.
 *
 * @param {object} [options] check overrides, mostly for tests
 * @param {object} [options.server] RPC client to use (defaults to the shared one)
 * @param {number} [options.timeoutMs] per-check timeout
 * @param {number} [options.maxLedgerAgeSeconds] maximum accepted ledger age
 * @param {string} [options.networkPassphrase] expected network passphrase
 * @param {string} [options.contractId] expected escrow contract id
 * @param {number} [options.now] current time in milliseconds
 * @returns {Promise<{ status: string, checks: object }>} the readiness result
 */
async function runReadinessChecks(options = {}) {
  const server = options.server || getRpcServer();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.readyCheckTimeoutMs;
  const maxAgeSeconds = Number.isFinite(options.maxLedgerAgeSeconds)
    ? options.maxLedgerAgeSeconds
    : config.readyMaxLedgerAgeSeconds;
  const expectedPassphrase = options.networkPassphrase || config.networkPassphrase;
  const contractId = options.contractId || config.contractId;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const [rpc, network, ledger, contract] = await Promise.all([
    checkRpc(server, timeoutMs),
    checkNetwork(server, timeoutMs, expectedPassphrase),
    checkLedger(server, timeoutMs, maxAgeSeconds, now),
    checkContract(server, timeoutMs, contractId),
  ]);

  const checks = { rpc, network, ledger, contract };
  const ok = rpc.ok && network.ok && ledger.ok && contract.ok;
  return { status: ok ? 'ready' : 'not_ready', checks };
}

/**
 * Returns the readiness result, using the cached result while it is still
 * fresh. The cached promise is shared, so concurrent probes trigger a single
 * round of RPC calls.
 *
 * @param {object} [options] forwarded to runReadinessChecks
 * @param {boolean} [options.force] bypass the cache
 * @returns {Promise<{ status: string, checks: object }>} the readiness result
 */
function getReadiness(options = {}) {
  const ttlMs = config.readyCacheSeconds * 1000;
  const now = Date.now();
  if (!options.force && cache && now - cache.at < ttlMs) {
    return cache.promise;
  }
  const promise = runReadinessChecks(options).catch(() => ({
    status: 'not_ready',
    checks: {
      rpc: { ok: false, error: ERROR_CODES.RPC_ERROR },
      network: { ok: false, expected: config.networkPassphrase, actual: null, error: ERROR_CODES.RPC_ERROR },
      ledger: { ok: false, sequence: null, ageSeconds: null, error: ERROR_CODES.RPC_ERROR },
      contract: { ok: false, error: ERROR_CODES.RPC_ERROR },
    },
  }));
  cache = { at: now, promise };
  return promise;
}

/**
 * Drops the cached readiness result.
 *
 * @returns {void}
 */
function resetReadinessCache() {
  cache = null;
}

module.exports = {
  ERROR_CODES,
  runReadinessChecks,
  getReadiness,
  resetReadinessCache,
};
