'use strict';

/**
 * Typed escrow state decoder.
 *
 * `get_escrow` returns a contract struct whose fields arrive as native JS
 * values (`scValToNative`): `i128`/`i64` amounts and timestamps become
 * `BigInt`, `u32`/`i32` stay numbers. The deploy snapshot kept in
 * `src/routes/escrow.js` stores the same values in raw, JSON-safe form
 * (decimal strings and numbers). Both inputs run through `decodeEscrow()` so
 * the live and snapshot paths are guaranteed to produce the identical,
 * explicitly typed `EscrowState` shape.
 *
 * Decoding never throws for an *unknown* status code — it maps to
 * `status: 'unknown'`. A malformed payload (missing field, non-integer or
 * out-of-range value) throws `EscrowDecodeError` and is treated as an error by
 * callers rather than being passed through.
 */

/** Number of decimal places used by the contract's token. */
const DECIMALS = 7;

/** Stroops per whole token unit (10^7). */
const STROOPS_PER_UNIT = 10n ** BigInt(DECIMALS);

/** Contract status codes (escrow/src/lib.rs): 0 open, 1 funded, 2 settled, 3 withdrawn, 4 cancelled. */
const STATUS_BY_CODE = Object.freeze({
  0: 'open',
  1: 'funded',
  2: 'settled',
  3: 'withdrawn',
  4: 'cancelled',
});

/** Human-readable status values an `EscrowState` may carry. */
const STATUSES = Object.freeze(['open', 'funded', 'settled', 'withdrawn', 'cancelled', 'unknown']);

/** Maximum basis-point yield the contract accepts. */
const MAX_YIELD_BPS = 10000;

/** Error thrown when a payload cannot be decoded into a valid EscrowState. */
class EscrowDecodeError extends Error {
  /**
   * @param {string} message human-readable reason
   * @param {string} [field] offending field, when known
   */
  constructor(message, field) {
    super(field ? `${message} (field: ${field})` : message);
    this.name = 'EscrowDecodeError';
    this.code = 'ESCROW_DECODE_FAILED';
    this.field = field;
  }
}

/**
 * Normalises a struct-like value (plain object or `Map`) into a record.
 *
 * @param {unknown} native decoded contract value
 * @returns {Record<string, unknown>} field record
 */
function asRecord(native) {
  if (native instanceof Map) {
    return Object.fromEntries(native);
  }
  if (native !== null && typeof native === 'object' && !Array.isArray(native)) {
    return /** @type {Record<string, unknown>} */ (native);
  }
  throw new EscrowDecodeError('escrow payload must be a map of fields');
}

/**
 * Reads the first present, non-null alias of a field (snake_case or camelCase).
 *
 * @param {Record<string, unknown>} rec field record
 * @param {string[]} aliases candidate key names, in preference order
 * @returns {unknown} the value, or `undefined` when absent
 */
function pick(rec, aliases) {
  for (const alias of aliases) {
    const value = rec[alias];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

/**
 * Converts an on-chain integer (bigint, safe number, or digit string) to a BigInt.
 *
 * @param {unknown} value raw value
 * @param {string} field field name for error reporting
 * @returns {bigint} the integer value
 */
function toBigInt(value, field) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new EscrowDecodeError('must be an integer', field);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    throw new EscrowDecodeError('must be a decimal integer string', field);
  }
  throw new EscrowDecodeError('must be an integer', field);
}

/**
 * Converts an on-chain integer to a JS number, rejecting unsafe values.
 *
 * @param {unknown} value raw value
 * @param {string} field field name for error reporting
 * @returns {number} the integer as a number
 */
function toInteger(value, field) {
  const asBig = toBigInt(value, field);
  const asNumber = Number(asBig);
  if (!Number.isSafeInteger(asNumber)) {
    throw new EscrowDecodeError('must fit in a safe JS integer', field);
  }
  return asNumber;
}

/**
 * Converts an on-chain amount to its raw stroop string (no decimals applied).
 *
 * @param {unknown} value raw amount
 * @param {string} field field name for error reporting
 * @returns {string} non-negative decimal integer string
 */
function toStroopString(value, field) {
  const asBig = toBigInt(value, field);
  if (asBig < 0n) {
    throw new EscrowDecodeError('must not be negative', field);
  }
  return asBig.toString();
}

/**
 * Formats a raw stroop string as a fixed 7-decimal string.
 *
 * @param {string} stroops raw stroop string
 * @returns {string} e.g. `100.0000000`
 */
function toDecimalString(stroops) {
  const asBig = BigInt(stroops);
  const whole = asBig / STROOPS_PER_UNIT;
  const fraction = asBig % STROOPS_PER_UNIT;
  return `${whole}.${fraction.toString().padStart(DECIMALS, '0')}`;
}

/**
 * Reads a required string field.
 *
 * @param {Record<string, unknown>} rec field record
 * @param {string} field canonical field name (first alias)
 * @param {string[]} aliases all accepted key names
 * @returns {string} trimmed, non-empty value
 */
function requiredString(rec, field, aliases) {
  const value = pick(rec, aliases);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EscrowDecodeError('must be a non-empty string', field);
  }
  return value.trim();
}

/**
 * Decodes a raw on-chain (or raw snapshot) escrow struct into an `EscrowState`.
 *
 * @param {unknown} native decoded `get_escrow` value, or a raw snapshot record
 * @returns {EscrowState} the typed escrow state
 * @throws {EscrowDecodeError} when the payload is malformed
 */
function decodeEscrow(native) {
  const rec = asRecord(native);

  const invoiceId = requiredString(rec, 'invoiceId', ['invoice_id', 'invoiceId']);
  const admin = requiredString(rec, 'admin', ['admin']);
  const smeAddress = requiredString(rec, 'sme_address', ['sme_address', 'smeAddress']);

  const amount = toStroopString(pick(rec, ['amount']), 'amount');
  const fundingTarget = toStroopString(pick(rec, ['funding_target', 'fundingTarget']), 'fundingTarget');
  const fundedAmount = toStroopString(pick(rec, ['funded_amount', 'fundedAmount']), 'fundedAmount');

  const yieldBps = toInteger(pick(rec, ['yield_bps', 'yieldBps']), 'yieldBps');
  if (yieldBps < 0 || yieldBps > MAX_YIELD_BPS) {
    throw new EscrowDecodeError(`must be between 0 and ${MAX_YIELD_BPS}`, 'yieldBps');
  }

  const maturity = toInteger(pick(rec, ['maturity']), 'maturity');
  if (maturity < 0) {
    throw new EscrowDecodeError('must not be negative', 'maturity');
  }
  let maturityIso;
  try {
    maturityIso = new Date(maturity * 1000).toISOString();
  } catch {
    throw new EscrowDecodeError('must be a valid unix timestamp in seconds', 'maturity');
  }

  const statusCode = toInteger(pick(rec, ['status']), 'status');
  if (statusCode < 0) {
    throw new EscrowDecodeError('must not be negative', 'status');
  }
  const status = STATUS_BY_CODE[statusCode] || 'unknown';

  return {
    invoiceId,
    admin,
    smeAddress,
    amount,
    fundingTarget,
    fundedAmount,
    amountDecimal: toDecimalString(amount),
    fundingTargetDecimal: toDecimalString(fundingTarget),
    fundedAmountDecimal: toDecimalString(fundedAmount),
    yieldBps,
    maturity,
    maturityIso,
    status,
    statusCode,
  };
}

/**
 * @typedef {object} EscrowState
 * @property {string} invoiceId invoice identifier stored on chain
 * @property {string} admin admin (escrow authority) Stellar address
 * @property {string} smeAddress SME Stellar address
 * @property {string} amount raw amount in stroops
 * @property {string} fundingTarget raw funding target in stroops
 * @property {string} fundedAmount raw funded amount in stroops
 * @property {string} amountDecimal amount as a fixed 7-decimal string
 * @property {string} fundingTargetDecimal funding target as a fixed 7-decimal string
 * @property {string} fundedAmountDecimal funded amount as a fixed 7-decimal string
 * @property {number} yieldBps yield in basis points (0..10000)
 * @property {number} maturity maturity as unix seconds
 * @property {string} maturityIso maturity as an ISO-8601 date-time
 * @property {'open'|'funded'|'settled'|'withdrawn'|'cancelled'|'unknown'} status human-readable status
 * @property {number} statusCode raw contract status code
 */

module.exports = {
  DECIMALS,
  MAX_YIELD_BPS,
  STATUSES,
  STATUS_BY_CODE,
  EscrowDecodeError,
  decodeEscrow,
  toDecimalString,
};
