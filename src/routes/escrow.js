'use strict';

const express = require('express');
const config = require('../config');

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
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), timeoutMs));
  const sim = await Promise.race([server.simulateTransaction(tx), timeout]);
  if (!sim.result || !sim.result.retval) {
    throw new Error(sim.error || 'simulation returned no result');
  }
  return JSON.parse(
    JSON.stringify(scValToNative(sim.result.retval), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
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

// Mount attestation sub-router at /attestations
router.use('/attestations', require('./attestation'));

module.exports = router;
module.exports.DEPLOY_SNAPSHOT = DEPLOY_SNAPSHOT;
