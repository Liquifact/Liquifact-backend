'use strict';

/**
 * @fileoverview Validation-boundary tests for `jobs/contractListRefresh`
 * (issue #1387).
 *
 * The refresh job reads a u32 SCHEMA_VERSION over RPC, compares it to the
 * registry, and raises an operator alert on a mismatch. Bad data crossing that
 * boundary — an unusable contractId override, a corrupt/overflowed version, or
 * an unexpected comparison status — must fail deterministically and must never
 * be turned into a false mismatch alert.
 */

process.env.NODE_ENV = 'test';

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
}));

// The shared test setup stubs `src/metrics` without the wasm-mismatch counter,
// and that setup mock wins over a local `jest.mock`. Unmock it so the real
// counter (and its `inc`) is available to spy on.
jest.unmock('../src/metrics');

const { getOnChainSchemaVersion, compareVersions } = require('../src/config/escrowVersions');
const logger = require('../src/logger');
const metrics = require('../src/metrics');
const {
  runContractListRefresh,
  resetVersionMismatchAlertState,
  REFRESH_ERRORS,
  MAX_U32,
} = require('../src/jobs/contractListRefresh');

describe('contractListRefresh validation boundaries (issue #1387)', () => {
  let incSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    resetVersionMismatchAlertState();
    incSpy = jest
      .spyOn(metrics.contractWasmVersionMismatchAlertsTotal, 'inc')
      .mockImplementation(() => {});
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    incSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  describe('contractId override', () => {
    test.each([
      ['a number', 42],
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
      ['an object', {}],
      ['an array', []],
      ['a boolean', true],
    ])('rejects %s without calling the RPC or alerting', async (_label, value) => {
      await expect(runContractListRefresh(value)).rejects.toMatchObject({
        code: REFRESH_ERRORS.INVALID_CONTRACT_ID,
      });

      expect(getOnChainSchemaVersion).not.toHaveBeenCalled();
      expect(compareVersions).not.toHaveBeenCalled();
      expect(incSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('trims a valid override and passes it to the RPC read', async () => {
      getOnChainSchemaVersion.mockResolvedValue(3);
      compareVersions.mockReturnValue({ status: 'current', knownVersion: '1.2.0' });

      const res = await runContractListRefresh('  contract-a  ');

      expect(getOnChainSchemaVersion).toHaveBeenCalledWith('contract-a');
      expect(res).toEqual({ onChainVersion: 3, knownVersion: '1.2.0', status: 'current' });
    });

    test('allows an absent override and falls back to the env contract id', async () => {
      process.env.ESCROW_CONTRACT_ID = 'contract-from-env';
      getOnChainSchemaVersion.mockResolvedValue(4);
      compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

      await runContractListRefresh();

      expect(getOnChainSchemaVersion).toHaveBeenCalledWith(undefined);
      expect(errorSpy.mock.calls[0][0]).toMatchObject({ contractId: 'contract-from-env' });
    });
  });

  describe('on-chain SCHEMA_VERSION', () => {
    test.each([
      ['NaN', NaN],
      ['a float', 1.5],
      ['a negative', -1],
      ['a u32 overflow', MAX_U32 + 1],
      ['a numeric string', '3'],
      ['null', null],
      ['undefined', undefined],
      ['Infinity', Infinity],
    ])('rejects %s without comparing or alerting', async (_label, value) => {
      getOnChainSchemaVersion.mockResolvedValue(value);

      await expect(runContractListRefresh('contract-a')).rejects.toMatchObject({
        code: REFRESH_ERRORS.INVALID_ON_CHAIN_VERSION,
      });

      expect(compareVersions).not.toHaveBeenCalled();
      expect(incSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('accepts the lower boundary (0) and calls compareVersions', async () => {
      getOnChainSchemaVersion.mockResolvedValue(0);
      compareVersions.mockReturnValue({ status: 'unknown', knownVersion: null });

      await runContractListRefresh('contract-a');

      expect(compareVersions).toHaveBeenCalledWith(0);
    });

    test('accepts the upper boundary (MAX_U32) and calls compareVersions', async () => {
      getOnChainSchemaVersion.mockResolvedValue(MAX_U32);
      compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

      await runContractListRefresh('contract-a');

      expect(compareVersions).toHaveBeenCalledWith(MAX_U32);
    });
  });

  describe('comparison status', () => {
    test('rejects an unexpected status instead of silently skipping the alert', async () => {
      getOnChainSchemaVersion.mockResolvedValue(4);
      compareVersions.mockReturnValue({ status: 'sideways', knownVersion: '1.2.0' });

      await expect(runContractListRefresh('contract-a')).rejects.toMatchObject({
        code: REFRESH_ERRORS.INVALID_STATUS,
      });

      expect(incSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('rejects a non-object comparison envelope', async () => {
      getOnChainSchemaVersion.mockResolvedValue(4);
      compareVersions.mockReturnValue(undefined);

      await expect(runContractListRefresh('contract-a')).rejects.toMatchObject({
        code: REFRESH_ERRORS.INVALID_STATUS,
      });
      expect(incSpy).not.toHaveBeenCalled();
    });
  });

  describe('regression — valid inputs still alert', () => {
    test('ahead mismatch still raises exactly one alert', async () => {
      getOnChainSchemaVersion.mockResolvedValue(4);
      compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

      await runContractListRefresh('contract-a');

      expect(incSpy).toHaveBeenCalledTimes(1);
      expect(incSpy).toHaveBeenCalledWith({ status: 'ahead' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    test('de-dupes a persistent valid mismatch across runs', async () => {
      getOnChainSchemaVersion.mockResolvedValue(4);
      compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

      await runContractListRefresh('contract-a');
      await runContractListRefresh('contract-a');

      expect(incSpy).toHaveBeenCalledTimes(1);
    });
  });
});
