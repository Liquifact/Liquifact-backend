'use strict';

// Decimal inputs stay integers plus a scale. Numbers are read at their existing
// precision; converting here cannot recover precision lost before storage.
function parseDecimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError('Expected a finite non-negative decimal');
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('Expected a decimal string or number');
  }
  const text = String(value);
  const pattern = typeof value === 'number'
    ? /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i
    : /^(\d+)(?:\.(\d+))?$/;
  const match = text.length <= 128 && pattern.exec(text);
  if (!match) {
    throw new TypeError('Expected a non-negative decimal of at most 128 characters');
  }
  let units = BigInt(match[1] + (match[2] || ''));
  let scale = (match[2] || '').length - Number(match[3] || 0);
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units, scale };
}

function rescale(value, scale) {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function compareDecimals(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function decimalToString(units, scale) {
  const digits = units.toString().padStart(scale + 1, '0');
  if (!scale) {
    return digits;
  }
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return digits.slice(0, -scale) + (fraction ? '.' + fraction : '');
}

module.exports = { parseDecimal, rescale, compareDecimals, decimalToString };
