'use strict';

// Use the installed SDK's real StrKey and XDR codecs, not the global regex mocks.
jest.mock('@stellar/stellar-sdk', () => {
  // Load the real codecs separately: the SDK barrel also imports ESM-only HTTP
  // dependencies that this repository's CommonJS Jest setup cannot execute.
  const base = require('path').join(
    require('path').dirname(require.resolve('@stellar/stellar-sdk')),
    'base',
  );
  return {
    Address: jest.requireActual(require('path').join(base, 'address.js')).Address,
    StrKey: jest.requireActual(require('path').join(base, 'strkey.js')).StrKey,
    xdr: jest.requireActual(require('path').join(base, 'generated/curr_generated.js')).default,
  };
});
jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn(),
}));
jest.mock('../src/services/soroban', () => ({ callSorobanContract: jest.fn() }));
jest.mock('../src/logger', () => ({ error: jest.fn(), info: jest.fn() }));

const { Address, StrKey, xdr } = require('@stellar/stellar-sdk');
const { Server } = require('@stellar/stellar-sdk/rpc');
const { callSorobanContract } = require('../src/services/soroban');
const logger = require('../src/logger');
const {
  REGISTRY,
  compareVersions,
  getOnChainSchemaVersion,
} = require('../src/config/escrowVersions');

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
const OTHER_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const getLedgerEntries = jest.fn();
// The shared metrics fixture predates this counter; supply it only in this suite.
const metrics = require('../src/metrics');
metrics.contractWasmVersionMismatchAlertsTotal = { inc: jest.fn() };
const {
  runContractListRefresh,
  resetVersionMismatchAlertState,
} = require('../src/jobs/contractListRefresh');
const originalUrl = process.env.SOROBAN_RPC_URL;
const originalId = process.env.ESCROW_CONTRACT_ID;

const responseFor = (value = xdr.ScVal.scvU32(3), overrides = {}) => ({
  entries: [
    {
      val: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: new Address(CONTRACT_ID).toScAddress(),
          key: xdr.ScVal.scvSymbol('SCHEMA_VERSION'),
          durability: xdr.ContractDataDurability.persistent(),
          val: value,
          ...overrides,
        }),
      ),
    },
  ],
});

beforeEach(() => {
  jest.resetAllMocks();
  resetVersionMismatchAlertState();
  process.env.SOROBAN_RPC_URL = 'https://rpc.example.test';
  process.env.ESCROW_CONTRACT_ID = CONTRACT_ID;
  Server.mockImplementation(() => ({ getLedgerEntries }));
  callSorobanContract.mockImplementation((operation) => operation());
  getLedgerEntries.mockResolvedValue(responseFor());
});

afterAll(() => {
  if (originalUrl === undefined) {
    delete process.env.SOROBAN_RPC_URL;
  } else {
    process.env.SOROBAN_RPC_URL = originalUrl;
  }
  if (originalId === undefined) {
    delete process.env.ESCROW_CONTRACT_ID;
  } else {
    process.env.ESCROW_CONTRACT_ID = originalId;
  }
});

describe('schema version boundaries', () => {
  test.each([
    [0, 'unknown', null],
    [1, 'unknown', '1.0.0'],
    [2, 'unknown', '1.1.0'],
    [3, 'current', '1.2.0'],
    [4, 'ahead', '1.2.0'],
    [0xffffffff, 'ahead', '1.2.0'],
  ])('preserves comparison for u32 %s', (version, status, knownVersion) => {
    expect(compareVersions(version)).toEqual({ status, knownVersion });
  });

  test.each([
    undefined,
    null,
    true,
    false,
    '',
    '3',
    '99',
    {},
    [],
    new Number(3),
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    0x100000000,
  ])('rejects invalid version %p', (value) => {
    expect(() => compareVersions(value)).toThrow(
      expect.objectContaining({ code: 'INVALID_SCHEMA_VERSION' }),
    );
  });

  test('registry cannot be modified, deleted or extended by a consumer', () => {
    const before = { ...REGISTRY };
    expect(Object.isFrozen(REGISTRY)).toBe(true);
    expect(() => {
      REGISTRY['1.2.0'] = 99;
    }).toThrow(TypeError);
    expect(() => {
      delete REGISTRY['1.0.0'];
    }).toThrow(TypeError);
    expect(() => {
      REGISTRY['1.3.0'] = 4;
    }).toThrow(TypeError);
    expect(REGISTRY).toEqual(before);
    expect(compareVersions(3).status).toBe('current');
  });
});

describe('RPC boundaries', () => {
  test.each([null, '', false, 0, {}, 'CAAA', CONTRACT_ID.slice(0, -1) + 'A'])(
    'explicit invalid contract %p never falls back to configured contract',
    async (id) => {
      await expect(getOnChainSchemaVersion(id)).rejects.toMatchObject({
        code: 'INVALID_CONTRACT_ID',
      });
      expect(callSorobanContract).not.toHaveBeenCalled();
    },
  );

  test('omitted argument uses configured contract, but missing configuration fails locally', async () => {
    await expect(getOnChainSchemaVersion()).resolves.toBe(3);
    delete process.env.ESCROW_CONTRACT_ID;
    await expect(getOnChainSchemaVersion()).rejects.toMatchObject({ code: 'INVALID_CONTRACT_ID' });
    expect(callSorobanContract).toHaveBeenCalledTimes(1);
  });

  test.each([
    undefined,
    '',
    'not-a-url',
    'ftp://rpc.test',
    ' https://rpc.test',
    'https://user:private@rpc.test',
    'https://rpc.test/#private',
  ])('invalid RPC configuration %p fails before retries/network and is redacted', async (url) => {
    if (url === undefined) {
      delete process.env.SOROBAN_RPC_URL;
    } else {
      process.env.SOROBAN_RPC_URL = url;
    }
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({
      code: 'RPC_ERROR',
      message: 'Soroban RPC schema version read failed',
    });
    expect(callSorobanContract).not.toHaveBeenCalled();
    expect(Server).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { contractId: CONTRACT_ID, reason: 'INVALID_RPC_URL' },
      'Failed to read on-chain SCHEMA_VERSION',
    );
  });

  test.each([
    ['https://rpc.example.test', false],
    ['http://localhost:8000', true],
  ])('reads the requested persistent symbol using SDK RPC at %s', async (url, allowHttp) => {
    process.env.SOROBAN_RPC_URL = url;
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).resolves.toBe(3);
    expect(Server).toHaveBeenCalledWith(new URL(url).href, { allowHttp });
    const data = getLedgerEntries.mock.calls[0][0].contractData();
    expect(data.contract().toXDR('base64')).toBe(
      new Address(CONTRACT_ID).toScAddress().toXDR('base64'),
    );
    expect(data.key().sym().toString()).toBe('SCHEMA_VERSION');
    expect(data.durability().name).toBe('persistent');
  });

  test.each([0, 0xffffffff])('decodes u32 boundary %s with real XDR', async (value) => {
    getLedgerEntries.mockResolvedValue(responseFor(xdr.ScVal.scvU32(value)));
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).resolves.toBe(value);
  });

  test.each([
    null,
    {},
    { entries: null },
    { entries: {} },
    { entries: [] },
    { entries: [null] },
    { entries: [{}, {}] },
    { entries: [{ val: xdr.LedgerEntryData.account() }] },
  ])('rejects incomplete, duplicate or wrong ledger data %p', async (response) => {
    getLedgerEntries.mockResolvedValue(response);
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(logger.error.mock.calls[0][0].reason).toBe('INVALID_RPC_RESPONSE');
  });

  test.each([
    { contract: new Address(OTHER_ID).toScAddress() },
    { key: xdr.ScVal.scvSymbol('OTHER_KEY') },
    { durability: xdr.ContractDataDurability.temporary() },
    { val: xdr.ScVal.scvString('3') },
    { val: xdr.ScVal.scvI32(3) },
  ])('rejects wrong contract, key, durability or value type %p', async (overrides) => {
    getLedgerEntries.mockResolvedValue(responseFor(undefined, overrides));
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(logger.error.mock.calls[0][0].reason).toBe('INVALID_RPC_RESPONSE');
  });

  test('rejects an invalid numeric decoder result', async () => {
    const response = responseFor();
    jest.spyOn(response.entries[0].val.contractData().val(), 'u32').mockReturnValue(-1);
    getLedgerEntries.mockResolvedValue(response);
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(logger.error.mock.calls[0][0].reason).toBe('INVALID_RPC_RESPONSE');
  });

  test.each(['3', null, -1, NaN])('validates retry-wrapper output %p', async (value) => {
    callSorobanContract.mockResolvedValue(value);
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(logger.error.mock.calls[0][0].reason).toBe('INVALID_SCHEMA_VERSION');
  });

  test.each([new Error('https://user:private@rpc.test/?token=private'), 'private', null])(
    'never includes arbitrary upstream failure details in errors or logs',
    async (error) => {
      getLedgerEntries.mockRejectedValue(error);
      await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({
        code: 'RPC_ERROR',
        message: 'Soroban RPC schema version read failed',
      });
      expect(logger.error.mock.calls).toEqual([
        [
          { contractId: CONTRACT_ID, reason: 'UPSTREAM_FAILURE' },
          'Failed to read on-chain SCHEMA_VERSION',
        ],
      ]);
    },
  );

  test('duplicate and concurrent reads remain independent after a partial failure', async () => {
    const before = { ...REGISTRY };
    getLedgerEntries
      .mockResolvedValueOnce(responseFor())
      .mockRejectedValueOnce(new Error('transport'))
      .mockResolvedValueOnce(responseFor(xdr.ScVal.scvU32(4)));
    const results = await Promise.allSettled([
      getOnChainSchemaVersion(CONTRACT_ID),
      getOnChainSchemaVersion(CONTRACT_ID),
      getOnChainSchemaVersion(CONTRACT_ID),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 3 });
    expect(results[1].reason.code).toBe('RPC_ERROR');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 4 });
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).resolves.toBe(3);
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).resolves.toBe(3);
    expect(REGISTRY).toEqual(before);
  });
});

describe('retry and refresh state invariants', () => {
  const { withRetry } = jest.requireActual('../src/services/soroban');

  test('retries transient transport failures and decodes the successful read', async () => {
    callSorobanContract.mockImplementation((operation) =>
      withRetry(operation, {
        maxRetries: 1,
        baseDelay: 0,
        maxDelay: 0,
        maxElapsedMs: 1000,
      }),
    );
    getLedgerEntries.mockRejectedValueOnce(
      Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    );
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).resolves.toBe(3);
    expect(getLedgerEntries).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('malformed ledger data is permanent and never retried', async () => {
    callSorobanContract.mockImplementation((operation) =>
      withRetry(operation, {
        maxRetries: 3,
        baseDelay: 0,
        maxDelay: 0,
        maxElapsedMs: 1000,
      }),
    );
    getLedgerEntries.mockResolvedValue({ entries: [] });
    await expect(getOnChainSchemaVersion(CONTRACT_ID)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
  });

  test('a rejected read neither emits an alert nor clears existing deduplication state', async () => {
    getLedgerEntries.mockResolvedValue(responseFor(xdr.ScVal.scvU32(4)));
    await runContractListRefresh(CONTRACT_ID);
    expect(metrics.contractWasmVersionMismatchAlertsTotal.inc).toHaveBeenCalledTimes(1);
    getLedgerEntries.mockResolvedValueOnce({ entries: [] });
    await expect(runContractListRefresh(CONTRACT_ID)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    await runContractListRefresh(CONTRACT_ID);
    expect(metrics.contractWasmVersionMismatchAlertsTotal.inc).toHaveBeenCalledTimes(1);
    getLedgerEntries.mockResolvedValueOnce(responseFor());
    await runContractListRefresh(CONTRACT_ID);
    await runContractListRefresh(CONTRACT_ID);
    expect(metrics.contractWasmVersionMismatchAlertsTotal.inc).toHaveBeenCalledTimes(2);
  });

  test('concurrent duplicate refreshes emit exactly one validated mismatch alert', async () => {
    getLedgerEntries.mockResolvedValue(responseFor(xdr.ScVal.scvU32(4)));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runContractListRefresh(CONTRACT_ID)),
    );
    expect(
      results.every((result) => result.onChainVersion === 4 && result.status === 'ahead'),
    ).toBe(true);
    expect(metrics.contractWasmVersionMismatchAlertsTotal.inc).toHaveBeenCalledTimes(1);
  });
});
