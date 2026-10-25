'use strict';

const express = require('express');
const config = require('../config');
const { decodeEscrow } = require('../stellar/escrow-decoder');
const { conflict } = require('../errors');
const { getRpcServer } = require('../stellar/rpc');
const contractReader = require('../stellar/contract-reader');
const { Address, StrKey } = require('@stellar/stellar-sdk');

const router = express.Router();

/**
 * Snapshot of the on-chain state captured at deployment, kept in raw on-chain
 * form (decimal stroop strings, numeric status/yield/maturity) so it runs
 * through the same decoder as the live read. `capturedAt` records when the
 * snapshot was taken and is surfaced as `snapshotCapturedAt`.
 */
const DEPLOY_SNAPSHOT = {
  invoice_id: 'INV_0001',
  admin: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
  sme_address: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
  amount: '1000000000',
  funding_target: '1000000000',
  funded_amount: '0',
  yield_bps: 800,
  maturity: 1800132005,
  status: 0,
  capturedAt: new Date().toISOString(),
};

/**
 * Reads `get_escrow` from the deployed contract via a Soroban RPC simulation.
 * Returns the raw `ScVal` so callers decode it with `decodeEscrow`.
 *
 * @param {string} [contractId] escrow contract to read (defaults to the configured contract)
 * @param {number} [timeoutMs] abort after this many milliseconds
 * @returns {Promise<{ native: import('@stellar/stellar-sdk').xdr.ScVal, latestLedger?: number }>}
 *   the raw simulation result and the ledger it was read from
 */
async function readEscrowOnChain(contractId = config.contractId, timeoutMs = 6000) {
  const sdk = require('@stellar/stellar-sdk');
  const { Contract, TransactionBuilder, Account, BASE_FEE, scValToNative } = sdk;
  const server = getRpcServer();
  // Simulation does not need a real or funded source account.
  const source = new Account(config.simulationSourceAccount, '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(contractId).call('get_escrow'))
    .setTimeout(30)
    .build();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), timeoutMs));
  const sim = await Promise.race([server.simulateTransaction(tx), timeout]);
  if (!sim.result || !sim.result.retval) {
    throw new Error(sim.error || 'simulation returned no result');
  }
  const latestLedger = Number.isFinite(sim.latestLedger) ? sim.latestLedger : undefined;
  return { native: scValToNative(sim.result.retval), latestLedger };
}

/** @returns {object} the deploy snapshot decoded into the shared EscrowState shape */
function decodedSnapshot() {
  return decodeEscrow(DEPLOY_SNAPSHOT);
}

router.get('/', (req, res) => {
  res.json({
    contractId: config.contractId,
    network: config.network,
    rpcUrl: config.rpcUrl,
    explorer: config.explorerUrl,
    snapshot: decodedSnapshot(),
    snapshotCapturedAt: DEPLOY_SNAPSHOT.capturedAt,
  });
});

router.get('/live', async (req, res) => {
  // `?strict=true` opts the caller into live-only reads: no snapshot fallback.
  const strict = req.query.strict === 'true' || req.query.strict === '1';
  try {
    const { native, latestLedger } = await readEscrowOnChain();
    // A malformed contract response throws here and is treated as a read
    // failure rather than passed through to clients.
    const escrow = decodeEscrow(native);
    const body = {
      source: 'soroban-rpc',
      contractId: config.contractId,
      network: config.network,
      escrow,
    };
    if (latestLedger !== undefined) {
      body.latestLedger = latestLedger;
    }
    return res.json(body);
  } catch (err) {
    console.warn(`escrow live read failed, serving snapshot fallback: ${err.message}`);
    if (strict) {
      throw conflict('ESCROW_LIVE_UNAVAILABLE');
    }
    return res.json({
      source: 'snapshot',
      contractId: config.contractId,
      network: config.network,
      escrow: decodedSnapshot(),
      snapshotCapturedAt: DEPLOY_SNAPSHOT.capturedAt,
      warning: { code: 'LIVE_READ_FAILED' },
    });
  }
});

const CACHE_TTL_MS = 5000;
const CACHE_LIMIT = 1000;
const positionCache = new Map();

/**
 * @param {string|number|bigint} value raw stroop amount
 * @returns {string} amount with 7 decimals applied and trailing zeros trimmed
 */
function decimalStroops(value) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 10000000n;
  const fractional = (absolute % 10000000n).toString().padStart(7, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fractional ? '.' + fractional : '');
}

/**
 * @param {string|number} seconds unix seconds (0 means "no restriction")
 * @returns {string|null} ISO timestamp, or null for 0
 */
function unixIso(seconds) {
  const n = Number(seconds);
  if (!Number.isSafeInteger(n) || n < 0 || n * 1000 > 8640000000000000) {
    throw new Error('Invalid claim timestamp');
  }
  return n === 0 ? null : new Date(n * 1000).toISOString();
}

const POSITION_METHODS = [
  'get_contribution',
  'get_claimable_payout',
  'is_investor_claimed',
  'get_investor_yield_bps',
  'get_investor_claim_not_before',
  'is_allowlist_active',
  'is_investor_allowlisted',
];

router.get('/investors/:address', async (req, res) => {
  const investor = req.params.address;
  if (!StrKey.isValidEd25519PublicKey(investor) && !StrKey.isValidContract(investor)) {
    return res.status(400).json({ code: 'INVALID_ADDRESS' });
  }
  const now = Date.now();
  const cached = positionCache.get(investor);
  if (cached && cached.expiresAt > now) {
    return res.json(cached.value);
  }
  positionCache.delete(investor);
  const addressScVal = new Address(investor).toScVal();
  try {
    const reads = POSITION_METHODS.map(async (method) => {
      try {
        return await contractReader.simulateRead(method,
          method === 'is_allowlist_active' ? [] : [addressScVal], { timeoutMs: 5000 });
      } catch {
        throw new Error(method);
      }
    });
    reads.push(contractReader.latestLedger().catch(() => {
      throw new Error('latestLedger');
    }));
    const [contribution, claimablePayout, claimed, effectiveYieldBps,
      claimNotBefore, active, allowlisted, latestLedger] = await Promise.all(reads);
    const snapshot = {
      investor,
      contractId: config.contractId,
      contribution: String(contribution),
      contributionDecimal: decimalStroops(contribution),
      claimablePayout: String(claimablePayout),
      claimablePayoutDecimal: decimalStroops(claimablePayout),
      claimed: Boolean(claimed),
      effectiveYieldBps: Number(effectiveYieldBps),
      claimNotBefore: Number(claimNotBefore),
      claimNotBeforeIso: unixIso(claimNotBefore),
      allowlist: { active: Boolean(active), allowlisted: Boolean(allowlisted), eligible: !active || Boolean(allowlisted) },
      latestLedger,
    };
    // Preserve the verified snapshot for five seconds, bounding memory usage.
    positionCache.delete(investor);
    positionCache.set(investor, { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
    while (positionCache.size > CACHE_LIMIT) {
      positionCache.delete(positionCache.keys().next().value);
    }
    return res.json(snapshot);
  } catch (err) {
    const known = [...POSITION_METHODS, 'latestLedger'].includes(err.message);
    return res.status(502).json({ code: 'ESCROW_READ_FAILED', method: known ? err.message : 'decode' });
  }
});

// Mount attestation sub-router at /attestations
router.use('/attestations', require('./attestation'));

module.exports = router;
module.exports.clearPositionCache = () => positionCache.clear();
module.exports.DEPLOY_SNAPSHOT = DEPLOY_SNAPSHOT;
module.exports.readEscrowOnChain = readEscrowOnChain;