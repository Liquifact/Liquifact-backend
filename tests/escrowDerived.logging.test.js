'use strict';

const logger = require('../src/logger');
const {
  computeDaysToMaturity,
  resolveReferenceTime,
  validateLedgerCloseTimeUnit,
  validateMaturityDateBounds,
} = require('../src/services/escrowDerived');

describe('escrowDerived structured warning logs', () => {
  const NOW = new Date('2026-04-27T12:00:00.000Z');

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('logs milliseconds-as-seconds rejection through the structured logger', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();

    expect(validateLedgerCloseTimeUnit(1_700_000_000_000)).toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'ledger_close_time_unit_mismatch',
        ledgerCloseTime: 1_700_000_000_000,
        threshold: 100_000_000_000,
      }),
      expect.stringContaining('unit mismatch suspected')
    );
  });

  it('does not log raw non-numeric caller input', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const rawValue = 'bad value with user supplied trailing payload';

    expect(validateLedgerCloseTimeUnit(rawValue)).toBeNull();

    const [fields, message] = warnSpy.mock.calls[0];
    expect(fields).toMatchObject({
      component: 'escrowDerived',
      reason: 'invalid_ledger_close_time',
      ledgerCloseTime: null,
      valueType: 'string',
    });
    expect(JSON.stringify(fields)).not.toContain(rawValue);
    expect(message).not.toContain(rawValue);
  });

  it('logs absurd future maturity dates through the structured logger', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const tooFar = new Date(NOW.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);

    expect(validateMaturityDateBounds(tooFar, NOW)).toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'maturity_date_too_far_future',
        daysDiff: 36500,
        maxFutureDays: 18250,
      }),
      expect.stringContaining('absurd value flagged')
    );
  });

  it('logs stale overdue dates beyond the grace window through the structured logger', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const tooStale = new Date(NOW.getTime() - 500 * 24 * 60 * 60 * 1000);

    expect(computeDaysToMaturity(tooStale, { now: NOW })).toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'escrowDerived',
        reason: 'maturity_date_too_far_past',
        daysDiff: -500,
        maxOverdueDays: 365,
      }),
      expect.stringContaining('stale or malformed')
    );
  });

  it('does not log for valid ledger and maturity inputs', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const maturity = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

    expect(validateLedgerCloseTimeUnit(NOW.getTime() / 1000)).toBe(NOW.getTime() / 1000);
    expect(computeDaysToMaturity(maturity, { now: NOW })).toBe(30);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to opts.now when an invalid Date ledger value is supplied', () => {
    expect(resolveReferenceTime({
      ledgerCloseTime: new Date('invalid-date'),
      now: NOW,
    })).toBe(NOW);
  });

  it('falls back to server wall clock when compute options are null', () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const maturity = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);

    expect(computeDaysToMaturity(maturity, null)).toBe(2);
  });
});
