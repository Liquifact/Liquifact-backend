'use strict';

/**
 * Issue #436 — contract-existence preflight for custodial escrow funding.
 *
 * Isolated test file. Side-effects intentionally scoped:
 *   - this file is meant to RUN cleanly today, independent of all
 *     pre-existing test-suite load blockers (`src/cache/redis.js` missing
 *     `redis` package — PR #472 §14.2; the duplicate-`prom-client` entries
 *     in package.json; the still-undefined-counter exports).
 *   - we use `jest.doMock` for `@stellar/stellar-sdk` AND
 *     `@stellar/stellar-sdk/rpc` so that the `Address`/`xdr` pieces used
 *     by `_preflightContractExists` are present in a hermetic form, and
 *     `Server` returns a controlled fake instance.
 *   - we never go through `submitFundEscrow`'s full path; the integration
 *     tests against the full flow live in `tests/escrowSubmit.stub.test.js`
 *     (per the issue's instruction).
 */

// ---- SDK mock: Address + xdr + nativeToScVal ----
jest.doMock('@stellar/stellar-sdk', () => {
  const fakeScVal = { _tag: 'ScVal', toXDR: () => '00' };

  function Address(str) {
    if (typeof str !== 'string') {
      throw new TypeError('Address string required');
    }
    this.toScVal = () => fakeScVal;
    if (!str.startsWith('C')) {
      // G-account / unprefixed string — downstream XDR round-trip must throw.
      this.toScAddress = () => {
        throw new Error('fake-SDK: not a contract address');
      };
    } else {
      this.toScAddress = () => ({
        contractId: () => 'mock-contract-hash-bytes',
      });
    }
  }
  Address.fromString = (s) => new Address(s);

  const xdr = {
    LedgerKeyContractCode: function (o) {
      return { _kind: 'LedgerKeyContractCode', ...o };
    },
    LedgerKey: {
      contractCode: (lkc) => ({ _kind: 'LedgerKey.contractCode', lkc }),
    },
  };

  return {
    Address,
    nativeToScVal: jest.fn(() => fakeScVal),
    xdr,
    // The other exports are never reached for preflight tests, but
    // stubbing them keeps `require` quiet if other tests in the same file
    // accidentally touch them.
    Contract: function () {
      this.call = () => ({ toXDR: () => '00' });
    },
    TransactionBuilder: function () {
      this.addOperation = () => this;
      this.addMemo = () => this;
      this.setTimeout = () => this;
      this.build = () => ({ toXDR: () => '00', sign: () => ({}) });
    },
    BASE_FEE: 100,
    Keypair: { fromSecret: () => ({ sign: () => {}, publicKey: () => 'mock' }) },
  };
});

// ---- SDK RPC mock: a single shared fake server instance ----
const sharedServer = {
  getLedgerEntry: jest.fn(),
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  prepareTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
  getContractData: jest.fn(),
};
jest.doMock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn().mockImplementation(() => sharedServer),
}));

// Now safe to require the module under test (it picks up the doMocks above).
const { _preflightContractExists, EscrowSubmitError } = require('../src/services/escrowSubmit');

describe('escrowSubmit._preflightContractExists (issue #436) — isolated', () => {
  const VALID_C = 'C' + 'A'.repeat(55);

  beforeEach(() => {
    jest.restoreAllMocks();
    // Re-prime the shared server mock after restoreAllMocks.
    sharedServer.getLedgerEntry.mockReset();
    sharedServer.getAccount.mockReset();
    sharedServer.simulateTransaction.mockReset();
    sharedServer.prepareTransaction.mockReset();
    sharedServer.sendTransaction.mockReset();
    sharedServer.getTransaction.mockReset();
    sharedServer.getContractData.mockReset();
  });

  it('resolves when getLedgerEntry returns a non-empty val', async () => {
    sharedServer.getLedgerEntry.mockResolvedValueOnce({ val: Buffer.from('wasm') });
    await expect(_preflightContractExists(sharedServer, VALID_C)).resolves.toBeUndefined();
    expect(sharedServer.getLedgerEntry).toHaveBeenCalledTimes(1);
  });

  it('throws CONTRACT_NOT_FOUND when val is empty', async () => {
    sharedServer.getLedgerEntry.mockResolvedValueOnce({ val: Buffer.alloc(0) });
    await expect(_preflightContractExists(sharedServer, VALID_C)).rejects.toMatchObject({
      name: 'EscrowSubmitError',
      code: 'CONTRACT_NOT_FOUND',
      status: 404,
      message: 'Escrow contract not found on the network.',
    });
  });

  it('throws CONTRACT_NOT_FOUND when val is missing entirely', async () => {
    sharedServer.getLedgerEntry.mockResolvedValueOnce({ latestLedger: 1 });
    await expect(_preflightContractExists(sharedServer, VALID_C)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_FOUND',
      status: 404,
    });
  });

  it('throws CONTRACT_NOT_FOUND if response itself is null/undefined', async () => {
    sharedServer.getLedgerEntry.mockResolvedValueOnce(null);
    await expect(_preflightContractExists(sharedServer, VALID_C)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_FOUND',
      status: 404,
    });
  });

  it('throws PREFLIGHT_RPC_ERROR and NEVER surfaces RPC text', async () => {
    const SECRET_LEAK = 'AKIASUPERSECRET and https://internal.example.com';
    sharedServer.getLedgerEntry.mockRejectedValueOnce(
      Object.assign(new Error(SECRET_LEAK), { code: 'ETIMEDOUT' }),
    );
    const caught = await _preflightContractExists(sharedServer, VALID_C).then(
      () => null,
      (err) => err,
    );
    expect(caught).toBeInstanceOf(EscrowSubmitError);
    expect(caught.code).toBe('PREFLIGHT_RPC_ERROR');
    expect(caught.status).toBe(503);
    expect(String(caught.message)).toBe('Escrow contract preflight failed; please retry.');
    expect(String(caught.message)).not.toContain('AKIASUPERSECRET');
    expect(String(caught.message)).not.toContain('internal.example.com');
    expect(JSON.stringify(caught)).not.toContain('AKIASUPERSECRET');
  });

  it('throws INVALID_CONTRACT_ADDRESS for unparseable strings', async () => {
    await expect(
      _preflightContractExists(sharedServer, 'not-a-stellar-address-at-all'),
    ).rejects.toMatchObject({
      name: 'EscrowSubmitError',
      code: 'INVALID_CONTRACT_ADDRESS',
      status: 400,
      message: 'Invalid escrow contract address.',
    });
    expect(sharedServer.getLedgerEntry).not.toHaveBeenCalled();
  });

  it('throws INVALID_CONTRACT_ADDRESS for a G-account address (not a contract)', async () => {
    await expect(
      _preflightContractExists(sharedServer, 'G' + 'A'.repeat(55)),
    ).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ADDRESS',
      status: 400,
    });
    expect(sharedServer.getLedgerEntry).not.toHaveBeenCalled();
  });

  it('preserves legacy single-arg shape on EscrowSubmitError (backward-compat)', async () => {
    const e = new EscrowSubmitError('some legacy error');
    expect(String(e.message)).toBe('some legacy error');
    expect(e.name).toBe('EscrowSubmitError');
    // No .code / .status when constructed with a single argument.
    expect(e.code).toBeUndefined();
    expect(e.status).toBeUndefined();
  });

  it('accepts code + status on EscrowSubmitError', async () => {
    const e = new EscrowSubmitError('x', 'CONTRACT_NOT_FOUND', 404);
    expect(e.code).toBe('CONTRACT_NOT_FOUND');
    expect(e.status).toBe(404);
  });
});
