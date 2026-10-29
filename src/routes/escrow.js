'use strict';

const express = require('express');
const config = require('../config');
const { decodeEscrow } = require('../stellar/escrow-decoder');
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
 * Optional test stub. When set, it replaces the RPC simulation call.
 * The stub receives the array of call descriptors and returns the decoded native values.
 */
let sorobanStub = null;

function __setSorobanStub(fn) {
  sorobanStub = fn;
}

/**
 * Simulates a contract call via Soroban RPC and returns the decoded native value.
 *
 * @param {string} method contract method name
 * @param {Array} args array of xdr.ScVal arguments
 * @param {number} timeoutMs abort after this many milliseconds
 * @returns {Promise<any>} the decoded native return value
 */
async function simulateContractCall(method, args = [], timeoutMs = 6000) {
  if (sorobanStub) {
    const calls = [{ method, args }];
    const results = await sorobanStub(calls);
    return Array.isArray(results) ? results[0] : results;
  }
  const sdk = require('@stellar/stellar-sdk');
  const { Contract, TransactionBuilder, Account, BASE_FEE, scValToNative } = sdk;
  const server = getRpcServer();
  // Simulation does not need a real or funded source account.
  const source = new Account(config.simulationSourceAccount, '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(config.contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('RPC timeout')), timeoutMs);
  });
  let sim;
  try {
    sim = await Promise.race([server.simulateTransaction(tx), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!sim.result || !sim.result.retval) {
    throw new Error(sim.error || 'simulation returned no result');
  }
  const latestLedger = Number.isFinite(sim.latestLedger) ? sim.latestLedger : undefined;
  return { native: scValToNative(sim.result.retval), latestLedger };
}

/**
 * Converts decoded Soroban native values into plain JS objects.
 * Maps become objects; bigints become decimal strings.
 */
function toPlainFields(value) {
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries(), ([k, v]) => [String(k), toPlainFields(v)]),
    );
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((e) => Array.isArray(e) && e.length === 2)) {
      return Object.fromEntries(value.map(([k, v]) => [String(k), toPlainFields(v)]));
    }
    return value.map(toPlainFields);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toPlainFields(v)]),
    );
  }
  return value;
}

/**
 * Reads `get_escrow` from the deployed contract via a Soroban RPC simulation.
 *
 * @param {number} timeoutMs abort after this many milliseconds
 * @returns {Promise<object>} the decoded escrow struct
 */
async function readEscrowOnChain(timeoutMs = 6000) {
  const { native } = await simulateContractCall('get_escrow', [], timeoutMs);
  return JSON.parse(
    JSON.stringify(toPlainFields(native), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

/** @returns {object} the deploy snapshot decoded into the shared EscrowState shape */
function decodedSnapshot() {
  return decodeEscrow(DEPLOY_SNAPSHOT);
}

const MAX_FUNDERS_LIMIT = 50;
const DEFAULT_FUNDERS_LIMIT = 20;
const FUNDERS_CACHE_TTL_MS = 5000;
const fundersCache = new Map();

function encodeCursor(start) {
  return Buffer.from(JSON.stringify({ start }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const { start } = parsed;
  if (!Number.isInteger(start) || start < 0) {
    return null;
  }
  return start;
}

function parseLimit(raw) {
  if (raw === undefined) {
    return DEFAULT_FUNDERS_LIMIT;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FUNDERS_LIMIT) {
    return null;
  }
  return limit;
}

function computeSharePct(amount, fundedAmount) {
  if (fundedAmount <= 0n) {
    return '0.0000';
  }
  const scaled = (amount * 1000000n) / fundedAmount;
  const whole = scaled / 10000n;
  const frac = (scaled % 10000n).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}

function buildPage(totalNative, recordsNative, escrowNative) {
  const total = Number(totalNative);
  const fundedAmount = BigInt(escrowNative.funded_amount);
  const records = (recordsNative || []).map(([investor, amount]) => {
    const amountBig = BigInt(amount);
    return {
      investor,
      amount: amountBig.toString(),
      amountDecimal: amountBig.toString(),
      sharePct: computeSharePct(amountBig, fundedAmount),
    };
  });
  return { total, records, fundedAmount };
}

async function readFundersPage(start, limit) {
  const sdk = require('@stellar/stellar-sdk');
  const { nativeToScVal } = sdk;
  const args = [
    nativeToScVal(start, { type: 'u32' }),
    nativeToScVal(limit, { type: 'u32' }),
  ];
  if (sorobanStub) {
    const stubCalls = [
      { method: 'get_unique_funder_count', args: [] },
      { method: 'get_funding_records', args: [{ type: 'u32', value: start }, { type: 'u32', value: limit }] },
      { method: 'get_escrow', args: [] },
    ];
    const results = await sorobanStub(stubCalls);
    const [totalNative, recordsNative, escrowNative] = results;
    return buildPage(totalNative, recordsNative, escrowNative);
  }
  const [totalRes, recordsRes, escrowRes] = await Promise.all([
    simulateContractCall('get_unique_funder_count'),
    simulateContractCall('get_funding_records', args),
    simulateContractCall('get_escrow'),
  ]);
  return buildPage(totalRes.native, recordsRes.native, escrowRes.native);
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

router.get('/funders/count', async (req, res) => {
  try {
    const totalNative = await simulateContractCall('get_unique_funder_count');
    res.json({ total: Number(totalNative.native ?? totalNative) });
  } catch (err) {
    res.status(502).json({ error: 'ESCROW_READ_FAILED', code: 'ESCROW_READ_FAILED', message: err.message });
  }
});

router.get('/funders', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  if (limit === null) {
    return res.status(400).json({ error: 'INVALID_LIMIT', code: 'INVALID_LIMIT', message: 'limit must be an integer between 1 and 50' });
  }
  let start = 0;
  if (req.query.cursor !== undefined) {
    start = decodeCursor(req.query.cursor);
    if (start === null) {
      return res.status(400).json({ error: 'INVALID_CURSOR', code: 'INVALID_CURSOR', message: 'cursor is malformed' });
    }
  }
  const cacheKey = `${start}:${limit}`;
  const cached = fundersCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.payload);
  }
  try {
    const { total, records } = await readFundersPage(start, limit);
    const nextCursor = start + records.length >= total ? null : encodeCursor(start + records.length);
    const payload = {
      data: records,
      total,
      nextCursor,
      latestLedger: null,
    };
    fundersCache.set(cacheKey, { payload, expiresAt: Date.now() + FUNDERS_CACHE_TTL_MS });
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: 'ESCROW_READ_FAILED', code: 'ESCROW_READ_FAILED', message: err.message });
  }
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
    if (strict) {
      console.warn(`escrow live read failed (strict): ${err.message}`);
      return res
        .status(503)
        .json({ error: 'Live escrow read unavailable', code: 'ESCROW_LIVE_UNAVAILABLE' });
    }
    console.warn(`escrow live read failed, serving snapshot fallback: ${err.message}`);
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

const positionCache = new Map();

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
    const reads = POSITION_METHODS.map((method) =>
      contractReader.simulateRead(method,
        method === 'is_allowlist_active' ? [] : [addressScVal]),
    );
    const results = await Promise.all(reads);
    const value = Object.fromEntries(
      POSITION_METHODS.map((method, i) => [method, results[i]]),
    );
    positionCache.set(investor, { value, expiresAt: now + 5000 });
    return res.json(value);
  } catch (err) {
    return res.status(502).json({ error: 'ESCROW_READ_FAILED', code: 'ESCROW_READ_FAILED', message: err.message });
  }
});

module.exports = router;
module.exports.__setSorobanStub = __setSorobanStub;
