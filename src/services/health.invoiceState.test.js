/**
 * @file Tests for the invoice-state readiness sub-check
 * ({@link module:services/health.checkInvoiceStateHealth}).
 *
 * Deliberately isolated from `health.test.js`: that file's own
 * `beforeEach` crashes (`Cannot read properties of undefined (reading
 * 'get')` on `escrowIndexerLastCursorAdvanceTimestampSeconds.get`) for a
 * pre-existing, unrelated reason — the global `../metrics` mock registered
 * in `tests/mocks/setup.js` (`setupFilesAfterEnv`) only provides
 * `footprintCache*`/KYC-webhook counters, and this repo's Jest config has
 * `"transform": {}` (no babel-jest), so `jest.mock()` calls are not
 * hoisted; `health.test.js`'s own, more complete local
 * `jest.mock('../metrics', ...)` factory does not take precedence over the
 * one already registered by the global setup file. Confirmed pre-existing
 * on unmodified `main` (via `git stash`) and independently corroborated by
 * this repo's own CI job logs, which show the `Test` job exiting non-zero
 * even on `main`'s own recent "green" runs — this repo's CI does not fail
 * the workflow on test failures.
 *
 * `checkInvoiceStateHealth` never touches `../metrics` at all (only
 * `../config` and `../db/knex`), so a standalone file avoids that crash
 * entirely — confirmed empirically before writing these tests.
 */

jest.mock('../config', () => ({
  get: jest.fn(() => ({ INVOICE_STATE_ENABLED: 'true' })),
}));

const { checkInvoiceStateHealth } = require('./health');
const cfg = require('../config');
const db = require('../db/knex');

describe('checkInvoiceStateHealth', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.INVOICE_STATE_HEALTH_TIMEOUT_MS;
    cfg.get.mockReturnValue({ INVOICE_STATE_ENABLED: 'true' });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('returns disabled when INVOICE_STATE_ENABLED is not "true"', async () => {
    cfg.get.mockReturnValue({ INVOICE_STATE_ENABLED: 'false' });

    const result = await checkInvoiceStateHealth();

    expect(result).toEqual({ status: 'disabled' });
  });

  it('returns disabled when INVOICE_STATE_ENABLED is unset', async () => {
    cfg.get.mockReturnValue({});

    const result = await checkInvoiceStateHealth();

    expect(result).toEqual({ status: 'disabled' });
  });

  it('does not touch the database when disabled (fast, non-blocking)', async () => {
    cfg.get.mockReturnValue({ INVOICE_STATE_ENABLED: 'false' });

    await checkInvoiceStateHealth();

    expect(db).not.toHaveBeenCalled();
  });

  it('returns healthy with a latency when enabled and the invoices table is reachable', async () => {
    const result = await checkInvoiceStateHealth();

    expect(result.status).toBe('healthy');
    expect(result.latency).toBeGreaterThanOrEqual(0);
    expect(db).toHaveBeenCalledWith('invoices');
  });

  it('returns unhealthy when the invoices table query rejects', async () => {
    db.limit.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));

    const result = await checkInvoiceStateHealth();

    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('returns unhealthy on a bounded timeout when the query hangs', async () => {
    process.env.INVOICE_STATE_HEALTH_TIMEOUT_MS = '10';
    db.limit.mockImplementationOnce(() => new Promise(() => {}));

    const result = await checkInvoiceStateHealth();

    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('INVOICE_STATE_PROBE_TIMEOUT');
    // Bounded: the probe must resolve near the configured timeout, not hang
    // indefinitely or wait for some unrelated default.
    expect(result.latency).toBeLessThan(500);
  });

  it('falls back to the default 2000ms timeout when the env var is unset or invalid', async () => {
    process.env.INVOICE_STATE_HEALTH_TIMEOUT_MS = 'not-a-number';
    // A fast-resolving query should still complete well under the 2000ms default.
    const result = await checkInvoiceStateHealth();

    expect(result.status).toBe('healthy');
  });

  it('returns unhealthy when the state machine definitions are empty', async () => {
    jest.resetModules();
    jest.doMock('./invoiceStateMachine', () => ({
      INVOICE_STATES: {},
      VALID_TRANSITIONS: {},
    }));
    jest.doMock('../config', () => ({
      get: jest.fn(() => ({ INVOICE_STATE_ENABLED: 'true' })),
    }));

    const { checkInvoiceStateHealth: freshCheck } = require('./health');
    const result = await freshCheck();

    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('Invoice state machine definitions are empty');

    jest.dontMock('./invoiceStateMachine');
    jest.dontMock('../config');
  });
});
