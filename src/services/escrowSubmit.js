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
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
} = require('@stellar/stellar-sdk');
const { Server } = require('@stellar/stellar-sdk/rpc');

const logger = require('../logger');
const { escrowPreflightRejectedTotal } = require('../metrics');
const { validateAmountStroops } = require('./investorCommitment');

const SIGNING_MODE = {
  DELEGATED: 'delegated',
  CUSTODIAL: 'custodial',
  STUBBED: 'stubbed',
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

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
 * @param {string} params.amountStroops — amount in stroops (integer string)
 * @param {string} params.invoiceId       — used for idempotency / memo
 * @returns {Promise<EscrowSubmitResult>}
 */

const MEMO_MAX_BYTES = 28;

/**
 * Builds a validated Stellar text memo for the invoice ID.
 * @param {string} invoiceId - The invoice identifier.
 * @returns {{ type: string, value: string }} Stellar memo object.
 * @throws {EscrowSubmitError} If memo exceeds 28-byte Stellar limit.
 */
function buildMemo(invoiceId) {
  const memoValue = `lq:${invoiceId}`;
  const byteLength = Buffer.byteLength(memoValue, 'utf8');

  if (byteLength > MEMO_MAX_BYTES) {
    console.warn(
      `Escrow memo truncation detected: "${memoValue}" is ${byteLength} bytes, ` +
      `exceeds Stellar limit of ${MEMO_MAX_BYTES}. Invoice ID would be lost.`
    )
    throw new EscrowSubmitError(
      `Escrow memo truncation detected: "${memoValue}" is ${byteLength} bytes, ` +
      `exceeds Stellar limit of ${MEMO_MAX_BYTES}. Invoice ID would be lost.`
    );
  }

  return { type: 'text', value: memoValue };
}

/**
 * Build and submit (or prepare) the fund_escrow call.
 *
 * @param {Object} params
 * @param {string} params.escrowAddress   — Stellar contract address of the escrow
 * @param {string} params.investorAddress — investor's Stellar public key
 * @param {string} params.amountStroops — amount in stroops (integer string)
 * @param {string} params.invoiceId       — used for idempotency / memo
 * @returns {Promise<EscrowSubmitResult>}
 */
async function submitFundEscrow({ escrowAddress, investorAddress, amountStroops, invoiceId }) {
  validateAmountStroops(amountStroops);

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

  // Fail fast on a missing / stale / wrong escrow contract address before
  // paying any further RPC or sequence-number cost (issue #436). The
  // preflight issues a single getLedgerEntry against the contract's
  // contractCode ledger entry; absence is reported as an empty `val`.
  await _preflightContractExists(server, escrowAddress);

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
    .addMemo(buildMemo(invoiceId))
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
 *
 * @param {import('@stellar/stellar-sdk').Transaction} preparedTx - The prepared transaction.
 * @param {import('@stellar/stellar-sdk/rpc').Server} server - The Soroban RPC server instance.
 * @param {string} escrowAddress - The contract address of the escrow.
 * @returns {Promise<EscrowSubmitResult>} The submission result.
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

/**
 * Generates a stubbed result for testing/staging environments.
 *
 * @param {string} escrowAddress - The contract address.
 * @returns {EscrowSubmitResult} The stubbed result.
 */
function _stubbedResult(escrowAddress) {
  return {
    status: 'stubbed',
    escrowAddress,
    unsignedXdr: null,
    txHash: null,
    ledger: null,
  };
}

/**
 * Custom error class for escrow submission failures.
 *
 * Backwards-compatible: legacy call sites that throw with just `(message)`
 * continue to produce an error without `.code` / `.status`. Preflight
 * rejections (issue #436) set `.code` and `.status` so the existing
 * `mapError()` layer can produce a stable response.
 */
class EscrowSubmitError extends Error {
  /**
   * Creates an instance of EscrowSubmitError.
   *
   * @param {string} message - The error message.
   * @param {string} [code]  - Stable machine-readable code (e.g.
   *   `CONTRACT_NOT_FOUND`, `PREFLIGHT_RPC_ERROR`).
   * @param {number} [status] - HTTP status hint for the API edge layer.
   */
  constructor(message, code = null, status = null) {
    super(message);
    this.name = 'EscrowSubmitError';
    if (code !== null) {
      this.code = code;
    }
    if (status !== null) {
      this.status = status;
    }
  }
}

/**
 * Preflight check: verify a Soroban contract actually exists on-ledger at
 * `escrowAddress` before any signing or further RPC work happens.
 *
 * Issues ONE `getLedgerEntry` call against the contract's `contractCode`
 * ledger entry. The Stellar Soroban RPC returns a successful response with
 * an empty (zero-length) `val` when the entry does not exist, and a non-empty
 * `val` when the contract WASM is deployed. This implementation prefers a
 * single tiny ledger round-trip over a full transaction simulation — both
 * because it is cheaper and because it is the canonical primitive for an
 * existence check.
 *
 * Failure modes (all mapped to a stable `EscrowSubmitError` with safe,
 * user-facing text and a labeled metric increment so operators can observe
 * rejections without grepping logs):
 *
 *   - `invalid_address` — `escrowAddress` cannot be parsed as a contract
 *     address or cannot be rounded-tripped through the XDR layer.
 *   - `not_found`       — the contract has no on-ledger entry.
 *   - `rpc_error`       — the RPC call itself failed (transport, rate limit,
 *     5xx, etc.). The original error message is NEVER surfaced.
 *
 * Security: the function never logs the raw SDK or RPC error message; it
 * surfaces only the sanitized `escrowAddress`, a structured `errorCode`,
 * and the classified `reason`. The thrown `EscrowSubmitError` carries only
 * a fixed user-safe message.
 *
 * @param {import('@stellar/stellar-sdk/rpc').Server} server - Soroban RPC server.
 * @param {string} escrowAddress - C-prefixed Soroban contract address.
 * @returns {Promise<void>} Resolves on success.
 * @throws {EscrowSubmitError} With code `INVALID_CONTRACT_ADDRESS`,
 *   `CONTRACT_NOT_FOUND`, or `PREFLIGHT_RPC_ERROR`.
 */
async function _preflightContractExists(server, escrowAddress) {
  let ledgerKey;
  try {
    const addr = new Address(escrowAddress);
    const scAddress = addr.toScAddress();
    // Wasm/contract-code ledger key: cheapest existence proof.
    // `contractId` here is the contract hash extracted from the ScAddress,
    // not the public-format C… string.
    const contractId = scAddress.contractId();
    ledgerKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ contractId }),
    );
  } catch (_e) {
    escrowPreflightRejectedTotal.inc({ reason: 'invalid_address' });
    throw new EscrowSubmitError(
      'Invalid escrow contract address.',
      'INVALID_CONTRACT_ADDRESS',
      400,
    );
  }

  let response;
  try {
    response = await server.getLedgerEntry(ledgerKey);
  } catch (err) {
    // Transient RPC / transport / rate-limit / 5xx. Do NOT surface raw SDK
    // or RPC text — log structured fields only and emit the rejection
    // metric so operators can alert on it.
    logger.warn(
      {
        escrowAddress,
        errCode: err && err.code ? String(err.code) : undefined,
        errStatus: err && err.status ? Number(err.status) : undefined,
      },
      'escrowSubmit: contract preflight RPC failed',
    );
    escrowPreflightRejectedTotal.inc({ reason: 'rpc_error' });
    throw new EscrowSubmitError(
      'Escrow contract preflight failed; please retry.',
      'PREFLIGHT_RPC_ERROR',
      503,
    );
  }

  const exists = !!(response && response.val && response.val.length > 0);
  if (!exists) {
    escrowPreflightRejectedTotal.inc({ reason: 'not_found' });
    logger.warn(
      { escrowAddress },
      'escrowSubmit: contract preflight found no contract at address',
    );
    throw new EscrowSubmitError(
      'Escrow contract not found on the network.',
      'CONTRACT_NOT_FOUND',
      404,
    );
  }
}

module.exports = {
  submitFundEscrow,
  EscrowSubmitError,
  SIGNING_MODE,
  IDEMPOTENCY_KEY_PATTERN,
  buildMemo
};
