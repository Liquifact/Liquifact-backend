'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { createTtlCache } = require('../lib/ttl-cache');
const { conflict } = require('../errors');
const { getRpcServer } = require('../stellar/rpc');
const contractReader = require('../stellar/contract-reader');
const { Address, StrKey } = require('@stellar/stellar-sdk');

const router = express.Router();

function envInt(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const CACHE_TTL_MS = envInt('ESCROW_CACHE_TTL_MS', 5000);
const CACHE_STALE_MS = envInt('ESCROW_CACHE_STALE_MS', 60000);
const CACHE_ERROR_TTL_MS = envInt('ESCROW_CACHE_ERROR_TTL_MS', 2000);
const CACHE_MAX_ENTRIES = envInt('ESCROW_CACHE_MAX_ENTRIES', 500);
const LIVE_CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=30';

const escrowCache = createTtlCache({
  maxEntries: CACHE_MAX_ENTRIES,
  errorTtlMs: CACHE_ERROR_TTL_MS,
});

/** Snapshot of the on-chain state captured at deployment (fallback when RPC is slow). */
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
  capturedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Reads `get_escrow` from the deployed contract via a Soroban RPC simulation.
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
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(new Error('RPC timeout')), timeoutMs);
  });
  try {
    const sim = await Promise.race([server.simulateTransaction(tx), timeout]);
    if (sim instanceof Error) {
      throw sim;
    }
    if (!sim.result || !sim.result.retval) {
      throw new Error(sim.error || 'simulation returned no result');
    }
    return JSON.parse(
      JSON.stringify(scValToNative(sim.result.retval), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the cache key for an escrow read.
 *
 * @param {string} fn contract function name
 * @param {Array} args contract call arguments
 * @returns {string}
 */
function escrowCacheKey(fn, args = []) {
  return `${config.contractId}:${fn}:${JSON.stringify(args)}`;
}

/**
 * Computes a stable ETag from the escrow payload.
 *
 * @param {object} escrow decoded escrow struct
 * @returns {string}
 */
function escrowETag(escrow) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(escrow)).digest('hex');
  return `"${hash}"`;
}

router.get('/', (req, res) => {
  res.json({
    contractId: config.contractId,
    network: config.network,
    rpcUrl: config.rpcUrl,
    explorer: config.explorerUrl,
    snapshot: DEPLOY_SNAPSHOT,
  });
});

router.get('/live', async (req, res) => {
  const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const strict = req.query.strict === 'true';
  const key = escrowCacheKey('get_escrow');
  try {
    const result = await escrowCache.getOrLoad(key, () => readEscrowOnChain(), {
      ttlMs: CACHE_TTL_MS,
      staleMs: CACHE_STALE_MS,
      errorTtlMs: CACHE_ERROR_TTL_MS,
      fresh,
    });
    const etag = escrowETag(result.value);
    res.set('Cache-Control', LIVE_CACHE_CONTROL);
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.json({
      source: 'soroban-rpc',
      contractId: config.contractId,
      escrow: result.value,
      cache: {
        status: result.status,
        ageMs: result.ageMs,
        fetchedAt: result.fetchedAt,
      },
    });
  } catch (err) {
    res.set('Cache-Control', 'no-store');
    if (strict) {
      throw conflict('ESCROW_LIVE_UNAVAILABLE');
    }
    res.json({
      source: 'snapshot',
      contractId: config.contractId,
      warning: `Live read unavailable: ${err.message}`,
      escrow: DEPLOY_SNAPSHOT,
    });
  }
});

const POSITION_CACHE_TTL_MS = 5000;
const POSITION_CACHE_LIMIT = 1000;
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
    positionCache.set(investor, { value: snapshot, expiresAt: Date.now() + POSITION_CACHE_TTL_MS });
    while (positionCache.size > POSITION_CACHE_LIMIT) {
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
module.exports.escrowCacheKey = escrowCacheKey;
module.exports.escrowETag = escrowETag;
