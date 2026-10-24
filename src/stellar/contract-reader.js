'use strict';

const { rpc, Contract, TransactionBuilder, Account, BASE_FEE, scValToNative } = require('@stellar/stellar-sdk');
const config = require('../config');

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, field) => typeof field === 'bigint' ? field.toString() : field));
}

/** Read a Soroban view. Reject failures; never substitute deployment snapshots. */
async function simulateRead(method, args = [], { timeoutMs = 5000 } = {}) {
  const source = new Account(config.simulationSourceAccount, '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(config.contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const server = new rpc.Server(config.rpcUrl);
  let timer;
  try {
    const sim = await Promise.race([
      server.simulateTransaction(tx),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RPC timeout')), timeoutMs); }),
    ]);
    if (!sim.result || !sim.result.retval) {
      throw new Error('No Soroban simulation result');
    }
    return jsonSafe(scValToNative(sim.result.retval));
  } finally {
    clearTimeout(timer);
  }
}

async function latestLedger() {
  const server = new rpc.Server(config.rpcUrl);
  const ledger = await server.getLatestLedger();
  if (!Number.isSafeInteger(ledger.sequence)) {
    throw new Error('Invalid latest ledger');
  }
  return ledger.sequence;
}

module.exports = { simulateRead, latestLedger };
