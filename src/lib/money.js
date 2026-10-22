'use strict';

const MAX_INVOICE_AMOUNT = (1n << 63n) - 1n;

function validateDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError('decimals must be an integer between 0 and 18');
  }
}

function parseAmount(input, { decimals = 7 } = {}) {
  validateDecimals(decimals);
  let value = input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input))) {
      throw new TypeError('amount must be a finite number and safe integer');
    }
    value = input.toFixed(decimals);
    if (Number(value) !== input) {
      throw new TypeError(`amount has more than ${decimals} fractional digits`);
    }
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError('amount must be a non-negative decimal string or number');
  }

  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new TypeError(`amount has more than ${decimals} fractional digits`);
  }
  const scale = 10n ** BigInt(decimals);
  const minor = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (minor <= 0n) {
    throw new RangeError('amount must be greater than zero');
  }
  if (minor > MAX_INVOICE_AMOUNT) {
    throw new RangeError('amount exceeds MAX_INVOICE_AMOUNT');
  }
  return minor;
}

function formatAmount(amountMinor, decimals = 7) {
  validateDecimals(decimals);
  if (typeof amountMinor !== 'bigint') {
    throw new TypeError('amount must be a bigint');
  }
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  if (decimals === 0) {
    return `${negative ? '-' : ''}${whole}`;
  }
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function assertMinor(value) {
  if (typeof value !== 'bigint') {
    throw new TypeError('amount must be a bigint');
  }
}

function add(left, right) {
  assertMinor(left);
  assertMinor(right);
  return left + right;
}

function sub(left, right) {
  assertMinor(left);
  assertMinor(right);
  return left - right;
}

function cmp(left, right) {
  assertMinor(left);
  assertMinor(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function mulBps(amountMinor, bps) {
  assertMinor(amountMinor);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new RangeError('bps must be an integer between 0 and 10000');
  }
  return (amountMinor * BigInt(bps)) / 10000n;
}

module.exports = {
  MAX_INVOICE_AMOUNT,
  parseAmount,
  formatAmount,
  toStroops: parseAmount,
  fromStroops: formatAmount,
  add,
  sub,
  cmp,
  mulBps,
};