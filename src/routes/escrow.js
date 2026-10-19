'use strict';

const express = require('express');
const config = require('../config');
const contractReader = require('../stellar/contract-reader');
const { Address, StrKey } = require('@stellar/stellar-sdk');

const router = express.Router();

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
};

/**
 * Reads `get_escrow` from the deployed contract via a Soroban RPC simulation.
 *
 * @param {number} timeoutMs abort after this many milliseconds
 * @returns {Promise<object>} the decoded escrow struct
 */
async function readEscrowOnChain() {
  return contractReader.simulateRead('get_escrow', [], { timeoutMs: 6000 });
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
  try {
    const escrow = await readEscrowOnChain();
    res.json({ source: 'soroban-rpc', contractId: config.contractId, escrow });
  } catch (err) {
    res.json({
      source: 'snapshot',
      contractId: config.contractId,
      warning: `Live read unavailable: ${err.message}`,
      escrow: DEPLOY_SNAPSHOT,
    });
  }
});

const CACHE_TTL_MS = 5000;
const CACHE_LIMIT = 1000;
const positionCache = new Map();

function decimalStroops(value) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 10000000n;
  const fractional = (absolute % 10000000n).toString().padStart(7, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fractional ? '.' + fractional : '');
}

function unixIso(seconds) {
  const n = Number(seconds);
  if (!Number.isSafeInteger(n) || n < 0 || n * 1000 > 8640000000000000) {
    throw new Error('Invalid claim timestamp');
  }
  return n === 0 ? null : new Date(n * 1000).toISOString();
}

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
  const methods = [
    'get_contribution',
    'get_claimable_payout',
    'is_investor_claimed',
    'get_investor_yield_bps',
    'get_investor_claim_not_before',
    'is_allowlist_active',
    'is_investor_allowlisted',
  ];
  try {
    const values = await Promise.all(methods.map(async (method) => {
      try {
        return await contractReader.simulateRead(method,
          method === 'is_allowlist_active' ? [] : [addressScVal], { timeoutMs: 5000 });
      } catch {
        throw new Error(method);
      }
    }));
    const [contribution, claimablePayout, claimed, effectiveYieldBps,
      claimNotBefore, active, allowlisted] = values;
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
      latestLedger: null,
    };
    // Preserve the verified snapshot for five seconds, bounding memory usage.
    positionCache.delete(investor);
    positionCache.set(investor, { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
    while (positionCache.size > CACHE_LIMIT) {
      positionCache.delete(positionCache.keys().next().value);
    }
    return res.json(snapshot);
  } catch (err) {
    return res.status(502).json({ code: 'ESCROW_READ_FAILED', method: methods.includes(err.message) ? err.message : 'decode' });
  }
});

module.exports = router;
module.exports.clearPositionCache = () => positionCache.clear();
module.exports.DEPLOY_SNAPSHOT = DEPLOY_SNAPSHOT;
