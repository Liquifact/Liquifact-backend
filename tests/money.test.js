'use strict';

const { parseAmount, formatAmount, mulBps } = require('../src/lib/money');

describe('money amount conversion', () => {
  test.each([
    ['0.0000001', 1n],
    ['922337203685.4775807', 9223372036854775807n],
  ])('parses and formats %s exactly', (value, expected) => {
    expect(parseAmount(value)).toBe(expected);
    expect(formatAmount(expected)).toBe(value);
  });

  test.each(['0.00000001', '1e5', '-1', '0', 'abc'])('rejects invalid amount %s', (value) => {
    expect(() => parseAmount(value)).toThrow();
  });

  test('rejects non-safe integer numbers', () => {
    expect(() => parseAmount(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  test.each([
    [1n, 1, 0n],
    [9999n, 1, 0n],
    [10000n, 1, 1n],
    [1234567891n, 650, 80246912n],
    [9223372036854775807n, 10000, 9223372036854775807n],
  ])('multiplies %s by %s bps with contract floor semantics', (amount, bps, expected) => {
    expect(mulBps(amount, bps)).toBe(expected);
  });
});