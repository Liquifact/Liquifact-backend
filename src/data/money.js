'use strict';

const { parseDecimal, rescale, compareDecimals, decimalToString } = require('../utils/decimal');

/**
 * Adds two decimal money values without floating-point arithmetic.
 *
 * @param {string|number} left left operand
 * @param {string|number} right right operand
 * @returns {string} sum as a decimal string
 */
function addMoney(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const sum = rescale(a, scale) + rescale(b, scale);
  return decimalToString(sum, scale);
}

/**
 * Subtracts right from left using decimal arithmetic.
 *
 * @param {string|number} left left operand
 * @param {string|number} right right operand
 * @returns {string} difference as a decimal string
 */
function subMoney(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const diff = rescale(a, scale) - rescale(b, scale);
  return decimalToString(diff, scale);
}

/**
 * Converts a SQL numeric / decimal string to a JS number for the public API.
 * Uses decimal parsing (never `parseFloat`) so precision matches stored scale.
 *
 * @param {string|number} value money value
 * @returns {number} API number
 */
function moneyToNumber(value) {
  if (typeof value === 'number') {
    return value;
  }
  const parsed = parseDecimal(String(value));
  return Number(decimalToString(parsed.units, parsed.scale));
}

module.exports = {
  addMoney,
  subMoney,
  compareMoney: compareDecimals,
  moneyToNumber,
};
