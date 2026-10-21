'use strict';

const express = require('express');
const config = require('../config');
const { decodeEscrow } = require('../stellar/escrow-decoder');
const { getRpcServer } = require('../stellar/rpc');

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
 * @param {number} timeoutMs abort after this many milliseconds
 * @returns {Promise<{ native: import('@stellar/stellar-sdk').xdr.ScVal, latestLedger?: number }>}
 *   the raw simulation result and the ledger it was read from
 */
async function readEscrowOnChain(timeoutMs = 6000) {
  const sdk = require('@stellar/stellar-sdk');
  const { Contract, TransactionBuilder, Account, BASE_FEE, scValToNative } = sdk;
  const server = getRpcServer();
  // Simulation does not need a real or funded source account.
  const source = new Account('GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5', '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(config.contractId).call('get_escrow'))
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
      return res
        .status(503)
        .json({ error: 'Live escrow read unavailable', code: 'ESCROW_LIVE_UNAVAILABLE' });
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

// Mount attestation sub-router at /attestations
router.use('/attestations', require('./attestation'));

module.exports = router;
module.exports.DEPLOY_SNAPSHOT = DEPLOY_SNAPSHOT;
