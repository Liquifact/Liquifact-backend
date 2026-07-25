'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const logger = require('../src/logger');
const {
  computeApyPercent,
  computeFundedPercent,
  computeDaysToMaturity,
  computeEscrowDerivedFields,
  validateLedgerCloseTimeUnit,
  validateMaturityDateBounds,
  resolveReferenceTime,
} = require('../src/services/escrowDerived');

describe('computeApyPercent', () => {
  it('returns the value unchanged for a round rate', () => {
    expect(computeApyPercent(8)).toBe(8);
    expect(computeApyPercent(0)).toBe(0);
    expect(computeApyPercent(100)).toBe(100);
  });

  it('rounds to 2 decimal places', () => {
    expect(computeApyPercent(8.5)).toBe(8.5);
    expect(computeApyPercent(8.123)).toBe(8.12);
    expect(computeApyPercent(8.126)).toBe(8.13);
    expect(computeApyPercent(8.125)).toBe(8.13);
  });

  it('handles IEEE 754 drift without leaking extra decimals', () => {
    const result = computeApyPercent(0.1 + 0.2);
    expect(result).toBe(0.3);
  });

  it('returns null for null', () => {
    expect(computeApyPercent(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(computeApyPercent(undefined)).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(computeApyPercent('8.5')).toBeNull();
    expect(computeApyPercent('')).toBeNull();
  });

  it('returns null for objects and arrays', () => {
    expect(computeApyPercent({})).toBeNull();
    expect(computeApyPercent([])).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(computeApyPercent(Infinity)).toBeNull();
    expect(computeApyPercent(-Infinity)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(computeApyPercent(NaN)).toBeNull();
  });

  it('returns null for negative rates', () => {
    expect(computeApyPercent(-1)).toBeNull();
    expect(computeApyPercent(-0.001)).toBeNull();
  });
});

describe('computeFundedPercent', () => {
  it('computes 50% correctly', () => {
    expect(computeFundedPercent(500, 1000)).toBe(50);
  });

  it('computes 75% correctly', () => {
    expect(computeFundedPercent(750, 1000)).toBe(75);
  });

  it('computes 100% (fully funded)', () => {
    expect(computeFundedPercent(1000, 1000)).toBe(100);
  });

  it('computes 0% (nothing funded)', () => {
    expect(computeFundedPercent(0, 1000)).toBe(0);
  });

  it('rounds repeating decimals to 2 dp', () => {
    expect(computeFundedPercent(1, 3)).toBe(33.33);
    expect(computeFundedPercent(2, 3)).toBe(66.67);
  });

  it('allows over-funded values (> 100%)', () => {
    expect(computeFundedPercent(1500, 1000)).toBe(150);
  });

  it('returns null when totalAmount is zero', () => {
    expect(computeFundedPercent(0, 0)).toBeNull();
    expect(computeFundedPercent(100, 0)).toBeNull();
  });

  it('returns null when totalAmount is negative', () => {
    expect(computeFundedPercent(100, -500)).toBeNull();
  });

  it('returns null for non-numeric fundedAmount', () => {
    expect(computeFundedPercent(null, 1000)).toBeNull();
    expect(computeFundedPercent(undefined, 1000)).toBeNull();
    expect(computeFundedPercent('500', 1000)).toBeNull();
  });

  it('returns null for non-numeric totalAmount', () => {
    expect(computeFundedPercent(500, null)).toBeNull();
    expect(computeFundedPercent(500, undefined)).toBeNull();
    expect(computeFundedPercent(500, '1000')).toBeNull();
  });

  it('returns null when fundedAmount is Infinity', () => {
    expect(computeFundedPercent(Infinity, 1000)).toBeNull();
  });

  it('returns null when totalAmount is Infinity', () => {
    expect(computeFundedPercent(500, Infinity)).toBeNull();
  });

  it('returns null for NaN inputs', () => {
    expect(computeFundedPercent(NaN, 1000)).toBeNull();
    expect(computeFundedPercent(500, NaN)).toBeNull();
  });
});

describe('validateLedgerCloseTimeUnit', () => {
  it('accepts valid epoch seconds (number)', () => {
    const epochSeconds = 1_700_000_000;
    expect(validateLedgerCloseTimeUnit(epochSeconds)).toBe(epochSeconds);
  });

  it('accepts a Date object', () => {
    const date = new Date('2026-04-27T00:00:00.000Z');
    expect(validateLedgerCloseTimeUnit(date)).toBe(date);
  });

  it('rejects milliseconds (detected by magnitude)', () => {
    const epochMs = 1_700_000_000_000;
    expect(validateLedgerCloseTimeUnit(epochMs)).toBeNull();
  });

  it('rejects values above EPOCH_SECONDS_THRESHOLD (100 billion)', () => {
    expect(validateLedgerCloseTimeUnit(100_000_000_001)).toBeNull();
    expect(validateLedgerCloseTimeUnit(999_999_999_999)).toBeNull();
  });

  it('accepts values below threshold', () => {
    expect(validateLedgerCloseTimeUnit(99_999_999_999)).toBe(99_999_999_999);
  });

  it('returns null for null', () => {
    expect(validateLedgerCloseTimeUnit(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(validateLedgerCloseTimeUnit(undefined)).toBeNull();
  });

  it('returns null for zero', () => {
    expect(validateLedgerCloseTimeUnit(0)).toBeNull();
  });

  it('returns null for negative numbers', () => {
    expect(validateLedgerCloseTimeUnit(-1)).toBeNull();
    expect(validateLedgerCloseTimeUnit(-1_000_000)).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(validateLedgerCloseTimeUnit('not-a-number')).toBeNull();
    expect(validateLedgerCloseTimeUnit('abc')).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(validateLedgerCloseTimeUnit(Infinity)).toBeNull();
    expect(validateLedgerCloseTimeUnit(-Infinity)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(validateLedgerCloseTimeUnit(NaN)).toBeNull();
  });

  it('handles edge case: exactly at threshold', () => {
    expect(validateLedgerCloseTimeUnit(100_000_000_000)).toBeNull();
  });

  it('logs warning when rejecting milliseconds', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    validateLedgerCloseTimeUnit(1_700_000_000_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'ledger_close_time_unit_mismatch',
        ledgerCloseTime: 1_700_000_000_000,
      }),
      expect.stringContaining('unit mismatch suspected')
    );
    warnSpy.mockRestore();
  });

  it('logs warning for non-numeric input', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    validateLedgerCloseTimeUnit('bad');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'invalid_ledger_close_time',
        ledgerCloseTime: null,
        valueType: 'string',
      }),
      expect.stringContaining('non-numeric or negative')
    );
    warnSpy.mockRestore();
  });
});

describe('validateMaturityDateBounds', () => {
  const NOW = new Date('2026-04-27T12:00:00.000Z');

  it('accepts maturity 30 days in future', () => {
    const future = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(future, NOW)).toBe(true);
  });

  it('accepts maturity 1 year in future', () => {
    const future = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(future, NOW)).toBe(true);
  });

  it('accepts maturity 10 years in future', () => {
    const future = new Date(NOW.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(future, NOW)).toBe(true);
  });

  it('accepts maturity at max bound (50 years future)', () => {
    const future = new Date(NOW.getTime() + 50 * 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(future, NOW)).toBe(true);
  });

  it('rejects maturity beyond max bound (> 50 years future)', () => {
    const tooFar = new Date(NOW.getTime() + 51 * 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(tooFar, NOW)).toBe(false);
  });

  it('rejects maturity 100 years in future', () => {
    const wayTooFar = new Date(NOW.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(wayTooFar, NOW)).toBe(false);
  });

  it('accepts maturity today (0 days)', () => {
    expect(validateMaturityDateBounds(new Date(NOW.getTime()), NOW)).toBe(true);
  });

  it('accepts maturity 1 day ago (overdue but within grace)', () => {
    const yesterday = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(yesterday, NOW)).toBe(true);
  });

  it('accepts maturity 100 days ago (within 365-day grace)', () => {
    const longAgo = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(longAgo, NOW)).toBe(true);
  });

  it('accepts maturity at grace boundary (365 days ago)', () => {
    const boundary = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(boundary, NOW)).toBe(true);
  });

  it('rejects maturity beyond grace (> 365 days ago)', () => {
    const tooStale = new Date(NOW.getTime() - 366 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(tooStale, NOW)).toBe(false);
  });

  it('rejects maturity 5 years in the past', () => {
    const ancient = new Date(NOW.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    expect(validateMaturityDateBounds(ancient, NOW)).toBe(false);
  });

  it('logs warning when rejecting too-far-future', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const tooFar = new Date(NOW.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
    validateMaturityDateBounds(tooFar, NOW);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'maturity_date_too_far_future',
      }),
      expect.stringContaining('absurd value flagged')
    );
    warnSpy.mockRestore();
  });

  it('logs warning when rejecting too-stale-past', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const tooStale = new Date(NOW.getTime() - 500 * 24 * 60 * 60 * 1000);
    validateMaturityDateBounds(tooStale, NOW);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'maturity_date_too_far_past',
      }),
      expect.stringContaining('stale or malformed')
    );
    warnSpy.mockRestore();
  });
});

describe('computeDaysToMaturity', () => {
  const NOW = new Date('2026-04-27T12:00:00.000Z');

  it('returns 30 for exactly 30 days in future', () => {
    const future = new Date('2026-05-27T12:00:00.000Z');
    expect(computeDaysToMaturity(future, { now: NOW })).toBe(30);
  });

  it('returns 0 when maturity is later the same day', () => {
    const laterToday = new Date('2026-04-27T23:59:00.000Z');
    expect(computeDaysToMaturity(laterToday, { now: NOW })).toBe(0);
  });

  it('returns 0 when maturity equals now exactly', () => {
    expect(computeDaysToMaturity(new Date(NOW.getTime()), { now: NOW })).toBe(0);
  });

  it('returns negative days when maturity is in the past (overdue)', () => {
    const past = new Date('2026-03-27T12:00:00.000Z');
    expect(computeDaysToMaturity(past, { now: NOW })).toBe(-31);
  });

  it('floors fractional days', () => {
    const oneAndHalf = new Date(NOW.getTime() + 1.5 * 24 * 60 * 60 * 1000);
    expect(computeDaysToMaturity(oneAndHalf, { now: NOW })).toBe(1);
  });

  it('accepts an ISO date string', () => {
    expect(computeDaysToMaturity('2026-05-27T12:00:00.000Z', { now: NOW })).toBe(30);
  });

  it('accepts a Unix timestamp in milliseconds', () => {
    const ms = new Date('2026-05-27T12:00:00.000Z').getTime();
    expect(computeDaysToMaturity(ms, { now: NOW })).toBe(30);
  });

  it('accepts a date-only string', () => {
    const result = computeDaysToMaturity('2026-05-27', { now: NOW });
    expect(typeof result).toBe('number');
  });

  it('returns null for null', () => {
    expect(computeDaysToMaturity(null, { now: NOW })).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(computeDaysToMaturity(undefined, { now: NOW })).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(computeDaysToMaturity('not-a-date', { now: NOW })).toBeNull();
    expect(computeDaysToMaturity('', { now: NOW })).toBeNull();
  });

  it('returns null when maturity exceeds bounds (too far future)', () => {
    const tooFar = new Date(NOW.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
    expect(computeDaysToMaturity(tooFar, { now: NOW })).toBeNull();
  });

  it('returns null when maturity is too stale (too far past)', () => {
    const tooStale = new Date(NOW.getTime() - 500 * 24 * 60 * 60 * 1000);
    expect(computeDaysToMaturity(tooStale, { now: NOW })).toBeNull();
  });

  it('defaults now to current system time when omitted', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const result = computeDaysToMaturity(future);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(4);
  });
});

describe('computeEscrowDerivedFields', () => {
  const NOW = new Date('2026-04-27T12:00:00.000Z');

  it('computes all three fields from a complete state', () => {
    const state = {
      fundedAmount: 750,
      totalAmount: 1000,
      annualRatePercent: 8.5,
      maturityDate: '2026-05-27T12:00:00.000Z',
    };
    expect(computeEscrowDerivedFields(state, { now: NOW })).toEqual({
      apyPercent: 8.5,
      fundedPercent: 75,
      daysToMaturity: 30,
    });
  });

  it('returns all nulls when state is empty', () => {
    expect(computeEscrowDerivedFields({})).toEqual({
      apyPercent: null,
      fundedPercent: null,
      daysToMaturity: null,
    });
  });

  it('uses maturityTimestamp as alias when maturityDate is absent', () => {
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 10,
      maturityTimestamp: '2026-05-27T12:00:00.000Z',
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.daysToMaturity).toBe(30);
  });

  it('prefers maturityDate over maturityTimestamp when both present', () => {
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 10,
      maturityDate: '2026-05-27T12:00:00.000Z',
      maturityTimestamp: '2026-06-27T12:00:00.000Z',
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.daysToMaturity).toBe(30);
  });

  it('returns null for each field independently when its input is invalid', () => {
    const state = {
      fundedAmount: 'bad',
      totalAmount: 1000,
      annualRatePercent: null,
      maturityDate: 'invalid',
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.apyPercent).toBeNull();
    expect(result.fundedPercent).toBeNull();
    expect(result.daysToMaturity).toBeNull();
  });

  it('computes valid fields even when others are null', () => {
    const state = {
      fundedAmount: 200,
      totalAmount: 400,
      annualRatePercent: 5,
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.apyPercent).toBe(5);
    expect(result.fundedPercent).toBe(50);
    expect(result.daysToMaturity).toBeNull();
  });

  it('defaults now to current time when opts are omitted', () => {
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5 };
    const result = computeEscrowDerivedFields(state);
    expect(result.apyPercent).toBe(5);
    expect(result.fundedPercent).toBe(0);
    expect(result.daysToMaturity).toBeNull();
  });

  it('returns an object with exactly the three derived keys', () => {
    const result = computeEscrowDerivedFields({});
    expect(Object.keys(result).sort()).toEqual(
      ['apyPercent', 'daysToMaturity', 'fundedPercent']
    );
  });
});

describe('resolveReferenceTime', () => {
  it('prefers ledgerCloseTime (epoch seconds) over opts.now', () => {
    const ledger = new Date('2026-04-27T00:00:00.000Z');
    const later = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({
      ledgerCloseTime: ledger.getTime() / 1000,
      now: later,
    });
    expect(result.getTime()).toBe(ledger.getTime());
  });

  it('prefers ledgerCloseTime as Date over opts.now', () => {
    const ledger = new Date('2026-04-27T00:00:00.000Z');
    const later = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ ledgerCloseTime: ledger, now: later });
    expect(result.getTime()).toBe(ledger.getTime());
  });

  it('rejects ledgerCloseTime in milliseconds; falls back to opts.now', () => {
    const nowDate = new Date('2026-04-27T00:00:00.000Z');
    const ledgerMs = nowDate.getTime();
    const result = resolveReferenceTime({
      ledgerCloseTime: ledgerMs,
      now: nowDate,
    });
    expect(result.getTime()).toBe(nowDate.getTime());
  });

  it('falls back to opts.now when ledgerCloseTime is absent', () => {
    const now = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ now });
    expect(result.getTime()).toBe(now.getTime());
  });

  it('falls back to opts.now when ledgerCloseTime is null', () => {
    const now = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ ledgerCloseTime: null, now });
    expect(result.getTime()).toBe(now.getTime());
  });

  it('falls back to opts.now when ledgerCloseTime is 0', () => {
    const now = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ ledgerCloseTime: 0, now });
    expect(result.getTime()).toBe(now.getTime());
  });

  it('falls back to wall clock when both ledgerCloseTime and now are absent', () => {
    const before = Date.now();
    const result = resolveReferenceTime({});
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('computeDaysToMaturity — ledger time', () => {
  const MATURITY = new Date('2026-05-27T12:00:00.000Z');

  it('uses ledgerCloseTime (epoch seconds) when provided', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result).toBe(30);
  });

  it('uses ledgerCloseTime (Date) when provided', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, { ledgerCloseTime: ledger });
    expect(result).toBe(30);
  });

  it('rejects ledgerCloseTime in milliseconds; falls back to opts.now', () => {
    const ledgerMs = new Date('2026-04-27T12:00:00.000Z').getTime();
    const nowDate = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledgerMs,
      now: nowDate,
    });
    expect(result).toBe(30);
  });

  it('ledger time (when valid) overrides opts.now', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const closer = new Date('2026-05-26T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledger.getTime() / 1000,
      now: closer,
    });
    expect(result).toBe(30);
  });

  it('falls back to opts.now when ledgerCloseTime missing', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, { now });
    expect(result).toBe(30);
  });

  it('accepts legacy bare Date as second argument (backwards compat)', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, now);
    expect(result).toBe(30);
  });

  it('marks invoice overdue when ledger time is past maturity', () => {
    const ledger = new Date('2026-06-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result).toBe(-31);
  });

  it('returns 0 when ledger time equals maturity exactly', () => {
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: MATURITY.getTime() / 1000,
    });
    expect(result).toBe(0);
  });

  it('returns null when maturity date is too far in future (absurd)', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const tooFar = new Date(ledger.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
    const result = computeDaysToMaturity(tooFar, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result).toBeNull();
  });

  it('returns null when maturity date is too far in past (stale)', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const tooStale = new Date(ledger.getTime() - 500 * 24 * 60 * 60 * 1000);
    const result = computeDaysToMaturity(tooStale, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result).toBeNull();
  });
});

describe('computeEscrowDerivedFields — ledger time', () => {
  const MATURITY_ISO = '2026-05-27T12:00:00.000Z';

  it('uses ledgerCloseTime (epoch seconds) for daysToMaturity', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 8.5,
      maturityDate: MATURITY_ISO,
    };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result.daysToMaturity).toBe(30);
    expect(result.apyPercent).toBe(8.5);
    expect(result.fundedPercent).toBe(50);
  });

  it('rejects milliseconds in ledgerCloseTime; falls back to wall clock', () => {
    const ledgerMs = new Date('2026-04-27T12:00:00.000Z').getTime();
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 8.5,
      maturityDate: MATURITY_ISO,
    };
    expect(() =>
      computeEscrowDerivedFields(state, { ledgerCloseTime: ledgerMs })
    ).not.toThrow();
    const result = computeEscrowDerivedFields(state, { ledgerCloseTime: ledgerMs });
    expect(result.apyPercent).toBe(8.5);
    expect(result.fundedPercent).toBe(50);
  });

  it('ledgerCloseTime beats opts.now', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const later = new Date('2026-05-26T12:00:00.000Z');
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
      now: later,
    });
    expect(result.daysToMaturity).toBe(30);
  });

  it('falls back to opts.now when ledgerCloseTime absent', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    const result = computeEscrowDerivedFields(state, { now });
    expect(result.daysToMaturity).toBe(30);
  });

  it('marks overdue when ledger is past maturity', () => {
    const ledger = new Date('2026-06-27T12:00:00.000Z');
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result.daysToMaturity).toBe(-31);
  });

  it('null ledgerCloseTime triggers fallback without throwing', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    expect(() =>
      computeEscrowDerivedFields(state, { ledgerCloseTime: null, now })
    ).not.toThrow();
    const result = computeEscrowDerivedFields(state, { ledgerCloseTime: null, now });
    expect(result.daysToMaturity).toBe(30);
  });

  it('returns null daysToMaturity when maturity is absurdly far future', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const state = {
      fundedAmount: 0,
      totalAmount: 100,
      annualRatePercent: 5,
      maturityDate: new Date(ledger.getTime() + 100 * 365 * 24 * 60 * 60 * 1000),
    };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result.daysToMaturity).toBeNull();
    expect(result.apyPercent).toBe(5);
    expect(result.fundedPercent).toBe(0);
  });
});
