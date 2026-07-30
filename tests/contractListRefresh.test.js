'use strict';

/**
 * Tests for the on-chain wasm version-mismatch alert in contractListRefresh
 * (issue #457).
 *
 * Covers:
 *  - version match → no alert
 *  - ahead mismatch → metric + error-severity alert with safe payload
 *  - unknown mismatch → alert
 *  - repeated/persistent mismatch → de-duped (no spam)
 *  - new version pair → re-alerts
 *  - recovery to current then mismatch again → re-alerts
 *  - per-contract de-dupe independence
 *  - RPC read failure → propagates, no alert
 *  - alert payload never leaks secrets
 */

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
}));

jest.mock('../src/metrics', () => ({
  contractWasmVersionMismatchAlertsTotal: { inc: jest.fn() },
}));

const { getOnChainSchemaVersion, compareVersions } = require('../src/config/escrowVersions');
const logger = require('../src/logger');
const metrics = require('../src/metrics');
const {
  raiseVersionMismatchAlert,
  runContractListRefresh,
  resetVersionMismatchAlertState,
} = require('../src/jobs/contractListRefresh');

describe('contractListRefresh version-mismatch alert (issue #457)', () => {
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
    delete process.env.SOROBAN_RPC_URL;
  });

  it('does not alert when versions match (status current)', async () => {
    getOnChainSchemaVersion.mockResolvedValue(3);
    compareVersions.mockReturnValue({ status: 'current', knownVersion: '1.2.0' });

    const res = await runContractListRefresh('contract-a');

    expect(res).toEqual({ onChainVersion: 3, knownVersion: '1.2.0', status: 'current' });
    expect(incSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('raises a metric + error-severity alert on an "ahead" mismatch', async () => {
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

    await runContractListRefresh('contract-a');

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledWith({ status: 'ahead' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = errorSpy.mock.calls[0];
    expect(payload).toMatchObject({
      alert: 'contract_wasm_version_mismatch',
      contractId: 'contract-a',
      expectedVersion: '1.2.0',
      observedVersion: 4,
      status: 'ahead',
    });
    expect(message).toMatch(/mismatch/i);
  });

  it('returns false and suppresses metric/log output for an identical direct alert', () => {
    const mismatch = {
      contractId: 'contract-a',
      observedVersion: 4,
      expectedVersion: '1.2.0',
      status: 'ahead',
    };

    const firstRaised = raiseVersionMismatchAlert(mismatch);
    const secondRaised = raiseVersionMismatchAlert(mismatch);

    expect(firstRaised).toBe(true);
    expect(secondRaised).toBe(false);
    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('returns true again when the direct alert signature changes for the same contract', () => {
    const firstRaised = raiseVersionMismatchAlert({
      contractId: 'contract-a',
      observedVersion: 4,
      expectedVersion: '1.2.0',
      status: 'ahead',
    });

    const changedObservedRaised = raiseVersionMismatchAlert({
      contractId: 'contract-a',
      observedVersion: 5,
      expectedVersion: '1.2.0',
      status: 'ahead',
    });

    const changedExpectedRaised = raiseVersionMismatchAlert({
      contractId: 'contract-a',
      observedVersion: 5,
      expectedVersion: '1.3.0',
      status: 'ahead',
    });

    expect(firstRaised).toBe(true);
    expect(changedObservedRaised).toBe(true);
    expect(changedExpectedRaised).toBe(true);
    expect(incSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it('re-alerts after resetVersionMismatchAlertState clears a direct alert signature', () => {
    const mismatch = {
      contractId: 'contract-a',
      observedVersion: 4,
      expectedVersion: '1.2.0',
      status: 'ahead',
    };

    expect(raiseVersionMismatchAlert(mismatch)).toBe(true);
    expect(raiseVersionMismatchAlert(mismatch)).toBe(false);

    resetVersionMismatchAlertState();

    expect(raiseVersionMismatchAlert(mismatch)).toBe(true);
    expect(incSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('raises an alert on an "unknown" version mismatch', async () => {
    getOnChainSchemaVersion.mockResolvedValue(99);
    compareVersions.mockReturnValue({ status: 'unknown', knownVersion: null });

    await runContractListRefresh('contract-a');

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledWith({ status: 'unknown' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatchObject({
      expectedVersion: null,
      observedVersion: 99,
      status: 'unknown',
    });
  });

  it('de-dupes a persistent mismatch across repeated runs', async () => {
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

    await runContractListRefresh('contract-a');
    await runContractListRefresh('contract-a');
    await runContractListRefresh('contract-a');

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('re-alerts when the observed version pair changes', async () => {
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

    getOnChainSchemaVersion.mockResolvedValue(4);
    await runContractListRefresh('contract-a');

    getOnChainSchemaVersion.mockResolvedValue(5);
    await runContractListRefresh('contract-a');

    expect(incSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('re-alerts after recovering to current and mismatching again', async () => {
    // Mismatch → alert 1
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });
    await runContractListRefresh('contract-a');

    // Recovered → clears de-dupe state, no alert
    getOnChainSchemaVersion.mockResolvedValue(3);
    compareVersions.mockReturnValue({ status: 'current', knownVersion: '1.2.0' });
    await runContractListRefresh('contract-a');

    // Same mismatch returns → alert 2 (state was cleared on recovery)
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });
    await runContractListRefresh('contract-a');

    expect(incSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('de-dupes per contract independently', async () => {
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

    await runContractListRefresh('contract-a');
    await runContractListRefresh('contract-b');
    // repeat for a — should stay de-duped
    await runContractListRefresh('contract-a');

    expect(incSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('does not raise a mismatch alert on a read (RPC) failure', async () => {
    const err = new Error('RPC read failed: boom');
    err.code = 'RPC_ERROR';
    getOnChainSchemaVersion.mockRejectedValue(err);

    await expect(runContractListRefresh('contract-a')).rejects.toThrow('RPC read failed');

    expect(compareVersions).not.toHaveBeenCalled();
    expect(incSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not leak secrets (e.g. RPC URL credentials) in the alert payload', async () => {
    process.env.SOROBAN_RPC_URL = 'https://user:supersecret-token@rpc.example.com';
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

    await runContractListRefresh('contract-a');

    const [payload] = errorSpy.mock.calls[0];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('supersecret-token');
    expect(serialized).not.toContain('user:');
    // Only the expected safe keys are present.
    expect(Object.keys(payload).sort()).toEqual(
      ['alert', 'contractId', 'expectedVersion', 'observedVersion', 'status'].sort()
    );
  });

  it('falls back to ESCROW_CONTRACT_ID when no contractId argument is given', async () => {
    process.env.ESCROW_CONTRACT_ID = 'contract-from-env';
    getOnChainSchemaVersion.mockResolvedValue(4);
    compareVersions.mockReturnValue({ status: 'ahead', knownVersion: '1.2.0' });

    await runContractListRefresh();

    expect(errorSpy.mock.calls[0][0]).toMatchObject({ contractId: 'contract-from-env' });
  });
});
