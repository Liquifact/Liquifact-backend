/**
 * src/services/escrowSubmit.js
 *
 * Builds the `fund_escrow` Soroban contract invocation for the LiquifactEscrow
 * contract and, depending on ESCROW_SIGNING_MODE, either:
 *
 *   "delegated"  — returns an unsigned transaction XDR for the investor to sign
 *                  client-side (e.g. via Freighter / Albedo). Status: requires_signature.
 *
 *   "custodial"  — the platform signs with a server keypair that MUST be supplied
 *                  via ESCROW_PLATFORM_SECRET (never committed to source). Status: submitted.
 *
 *   "stubbed"    — (test / staging fallback) skips on-chain submission and returns
 *                  a deterministic stub. Status: stubbed.
 *
 * IMPORTANT: Raw secret keys are NEVER logged, returned in API responses, or
 * persisted. The only place a secret is touched is inside _signAndSubmit(), in
 * memory, for the lifetime of a single request.
 *
 * Environment variables consumed:
 *   ESCROW_SIGNING_MODE        — "delegated" | "custodial" | "stubbed"  (default: stubbed)
 *   SOROBAN_RPC_URL            — e.g. https://soroban-testnet.stellar.org
 *   STELLAR_NETWORK_PASSPHRASE — matched from STELLAR_NETWORK by stellar.js at boot
 *   ESCROW_PLATFORM_SECRET     — custodial only; loaded from secrets manager / env
 *   ESCROW_PLATFORM_ADDRESS    — source account for the transaction (both modes)
 */

'use strict';

const {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  Address,
} = require('@stellar/stellar-sdk');
const { Server } = require('@stellar/stellar-sdk/rpc');

const SIGNING_MODE = {
  DELEGATED: 'delegated',
  CUSTODIAL: 'custodial',
  STUBBED: 'stubbed',
};

/**
 * @typedef {Object} EscrowSubmitResult
 * @property {'requires_signature'|'submitted'|'stubbed'} status
 * @property {string} escrowAddress      — on-chain contract address
 * @property {string|null} unsignedXdr   — present when status === 'requires_signature'
 * @property {string|null} txHash        — present when status === 'submitted'
 * @property {string|null} ledger        — present when status === 'submitted'
 */

/**
 * Build and submit (or prepare) the fund_escrow call.
 *
 * @param {Object} params
 * @param {string} params.escrowAddress   — Stellar contract address of the escrow
 * @param {string} params.investorAddress — investor's Stellar public key
 * @param {string|number} params.amountStroops — amount in stroops (integer string)
 * @param {string} params.invoiceId       — used for idempotency / memo
 * @returns {Promise<EscrowSubmitResult>}
 */
async function submitFundEscrow({ escrowAddress, investorAddress, amountStroops, invoiceId }) {
  const mode = (process.env.ESCROW_SIGNING_MODE || SIGNING_MODE.STUBBED).toLowerCase();

  if (mode === SIGNING_MODE.STUBBED) {
    return _stubbedResult(escrowAddress);
  }

  const rpcUrl = process.env.SOROBAN_RPC_URL;
  if (!rpcUrl) {
    throw new EscrowSubmitError('SOROBAN_RPC_URL is not configured.');
  }

  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  if (!passphrase) {
    throw new EscrowSubmitError('STELLAR_NETWORK_PASSPHRASE is not configured.');
  }

  const platformAddress = process.env.ESCROW_PLATFORM_ADDRESS;
  if (!platformAddress) {
    throw new EscrowSubmitError('ESCROW_PLATFORM_ADDRESS is not configured.');
  }

  // Build the unsigned transaction
  const server = new Server(rpcUrl);
  const sourceAccount = await server.getAccount(platformAddress);

  const contract = new Contract(escrowAddress);

  // fund_escrow(investor: Address, amount: i128)
  const operation = contract.call(
    'fund_escrow',
    new Address(investorAddress).toScVal(),
    nativeToScVal(BigInt(amountStroops), { type: 'i128' })
  );

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(operation)
    .addMemo({ type: 'text', value: `lq:${invoiceId}`.slice(0, 28) })
    .setTimeout(180)
    .build();

  // Simulate to populate the transaction footprint (required before submission)
  const simResult = await server.simulateTransaction(tx);
  if (simResult.error) {
    throw new EscrowSubmitError(`Soroban simulation failed: ${simResult.error}`);
  }

  const preparedTx = await server.prepareTransaction(tx);

  if (mode === SIGNING_MODE.DELEGATED) {
    // Return unsigned XDR; the client will sign and submit independently
    return {
      status: 'requires_signature',
      escrowAddress,
      unsignedXdr: preparedTx.toXDR(),
      txHash: null,
      ledger: null,
    };
  }

  if (mode === SIGNING_MODE.CUSTODIAL) {
    return await _signAndSubmit(preparedTx, server, escrowAddress);
  }

  throw new EscrowSubmitError(`Unknown ESCROW_SIGNING_MODE: "${mode}"`);
}

/**
 * Sign with the platform secret and broadcast. Secret is only held in memory
 * for the duration of this function call.
 */
async function _signAndSubmit(preparedTx, server, escrowAddress) {
  const secret = process.env.ESCROW_PLATFORM_SECRET;
  if (!secret) {
    throw new EscrowSubmitError(
      'ESCROW_PLATFORM_SECRET is required for custodial signing mode.'
    );
  }

  // Dynamic import to keep the secret out of module-level scope
  const { Keypair } = require('@stellar/stellar-sdk');
  let keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    throw new EscrowSubmitError('ESCROW_PLATFORM_SECRET is not a valid Stellar secret key.');
  }

  preparedTx.sign(keypair);

  const response = await server.sendTransaction(preparedTx);

  if (response.status === 'ERROR') {
    throw new EscrowSubmitError(
      `Transaction submission failed: ${JSON.stringify(response.errorResult)}`
    );
  }

  return {
    status: 'submitted',
    escrowAddress,
    unsignedXdr: null,
    txHash: response.hash,
    ledger: response.latestLedger ? String(response.latestLedger) : null,
  };
}

function _stubbedResult(escrowAddress) {
  return {
    status: 'stubbed',
    escrowAddress,
    unsignedXdr: null,
    txHash: null,
    ledger: null,
  };
}

class EscrowSubmitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EscrowSubmitError';
  }
}

module.exports = {
  submitFundEscrow,
  EscrowSubmitError,
  SIGNING_MODE,
};