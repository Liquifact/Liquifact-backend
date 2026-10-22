'use strict';

const { parseDecimal, rescale, decimalToString } = require('../utils/decimal');

const MINOR_SCALE = 7;

function toMinor(value) {
  const parsed = parseDecimal(value);
  if (parsed.scale > MINOR_SCALE) {
    throw new TypeError('Amount supports at most 7 decimal places');
  }
  return rescale(parsed, MINOR_SCALE);
}

function fromMinor(minor) {
  return decimalToString(minor, MINOR_SCALE);
}

function couponMinor(principalMinor, yieldBps) {
  return (BigInt(principalMinor) * BigInt(yieldBps)) / 10000n;
}

function daysBetween(asOf, maturity) {
  const start = Date.parse(`${asOf}T00:00:00.000Z`);
  const end = Date.parse(`${maturity}T00:00:00.000Z`);
  return Math.round((end - start) / 86400000);
}

function annualisedBps(yieldBps, daysToMaturity) {
  const simple = Math.floor((yieldBps * 365 + daysToMaturity / 2) / daysToMaturity);
  // Effective annualisation is a comparison metric only; never use this float for money.
  const effective = Math.floor(((((1 + yieldBps / 10000) ** (365 / daysToMaturity)) - 1) * 10000) + 0.5);
  return { simpleAnnualisedBps: simple, effectiveAnnualisedBps: effective };
}

module.exports = { MINOR_SCALE, toMinor, fromMinor, couponMinor, daysBetween, annualisedBps };
