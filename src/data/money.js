'use strict';

const { RepoError } = require('./repository');

const SCALE = 7;
const FACTOR = 10n ** BigInt(SCALE);

/**
 * Converts a number or decimal string to integer minor units (1e-7).
 *
 * @param {number|string} value positive decimal
 * @returns {bigint} minor units
 */
function toUnits(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(SCALE) : value;
  if (typeof text !== 'string' || !/^\d+(\.\d{1,7})?$/.test(text)) {
    throw new RepoError('INVALID_AMOUNT', 'amount must be a positive number', 400);
  }
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
}

/**
 * @param {bigint} units minor units
 * @returns {string} canonical decimal string without trailing zeros
 */
function fromUnits(units) {
  const whole = units / FACTOR;
  const frac = (units % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

module.exports = { toUnits, fromUnits };
