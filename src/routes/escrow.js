'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { createTtlCache } = require('../lib/ttl-cache');

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
 * @param {number} timeoutMs abort after this many milliseconds
 * @returns {Promise<object>} the decoded escrow struct
 */
async function readEscrowOnChain(timeoutMs = 6000) {
  const sdk = require('@stellar/stellar-sdk');
  const { rpc, Contract, TransactionBuilder, Account, BASE_FEE, scValToNative } = sdk;
  const server = new rpc.Server(config.rpcUrl);
  // Simulation does not need a real or funded source account.
  const source = new Account('GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5', '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(config.contractId).call('get_escrow'))
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
      res.status(503).json({
        code: 'ESCROW_LIVE_UNAVAILABLE',
        contractId: config.contractId,
        message: `Live read unavailable: ${err.message}`,
      });
      return;
    }
    res.json({
      source: 'snapshot',
      contractId: config.contractId,
      warning: `Live read unavailable: ${err.message}`,
      escrow: DEPLOY_SNAPSHOT,
    });
  }
});

module.exports = router;
module.exports.DEPLOY_SNAPSHOT = DEPLOY_SNAPSHOT;
module.exports.readEscrowOnChain = readEscrowOnChain;
module.exports.escrowCacheKey = escrowCacheKey;
module.exports.escrowETag = escrowETag;
