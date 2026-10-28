'use strict';

/**
 * @fileoverview Unit tests for the strict ISO calendar-date parser.
 */

const { parseIsoDate } = require('../../src/lib/dates');

describe('parseIsoDate', () => {
  test.each([
    ['2027-02-30'],
    ['2027-13-01'],
    ['2027-00-10'],
    ['2027-1-1'],
    ['2027-01-01T00:00:00Z'],
    ['January 1, 2027'],
    ['01/01/2027'],
    [''],
    [null],
    [undefined],
    [20270101],
  ])('rejects %p', (input) => {
    expect(parseIsoDate(input)).toBeNull();
  });

  test('accepts a real leap day', () => {
    const parsed = parseIsoDate('2028-02-29');
    expect(parsed).not.toBeNull();
    expect(parsed.unixSeconds).toBe(1835395200);
  });

  test('returns start-of-day UTC as unix seconds', () => {
    const parsed = parseIsoDate('2027-01-17');
    expect(parsed.date.toISOString()).toBe('2027-01-17T00:00:00.000Z');
    expect(parsed.unixSeconds).toBe(1800144000);
  });
});
