'use strict';

const request = require('supertest');
const { Address, Keypair, StrKey, xdr } = require('@stellar/stellar-sdk');
const app = require('../src/app');
const reader = require('../src/stellar/contract-reader');
const escrowRouter = require('../src/routes/escrow');
const config = require('../src/config');

const investor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const url = '/api/escrow/investors/' + investor;
const methods = [
  'get_contribution', 'get_claimable_payout', 'is_investor_claimed',
  'get_investor_yield_bps', 'get_investor_claim_not_before',
  'is_allowlist_active', 'is_investor_allowlisted',
];
const answers = {
  get_contribution: '1000000000',
  get_claimable_payout: '1050000000',
  is_investor_claimed: false,
  get_investor_yield_bps: '800',
  get_investor_claim_not_before: '0',
  is_allowlist_active: true,
  is_investor_allowlisted: false,
};
let simulate;
let ledger;

beforeEach(() => {
  escrowRouter.clearPositionCache();
  simulate = jest.spyOn(reader, 'simulateRead').mockImplementation(async (method) => answers[method]);
  ledger = jest.spyOn(reader, 'latestLedger').mockResolvedValue(5274165);
});
afterEach(() => {
  simulate.mockRestore();
  ledger.mockRestore();
});

test('returns a fully decoded typed position and encodes exact address arg', async () => {
  const res = await request(app).get(url);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    investor, contractId: config.contractId,
    contribution: '1000000000', contributionDecimal: '100',
    claimablePayout: '1050000000', claimablePayoutDecimal: '105',
    claimed: false, effectiveYieldBps: 800,
    claimNotBefore: 0, claimNotBeforeIso: null,
    allowlist: { active: true, allowlisted: false, eligible: false },
    latestLedger: 5274165,
  });
  expect(simulate.mock.calls.map(([method]) => method)).toEqual(methods);
  for (const [method, args, options] of simulate.mock.calls) {
    expect(options).toEqual({ timeoutMs: 5000 });
    if (method === 'is_allowlist_active') {
      expect(args).toEqual([]);
    } else {
      expect(args).toHaveLength(1);
      expect(args[0]).toBeInstanceOf(xdr.ScVal);
      expect(Address.fromScVal(args[0]).toString()).toBe(investor);
    }
  }
  expect(ledger).toHaveBeenCalledTimes(1);
});

test('allowlist inactive makes any investor eligible; date becomes ISO', async () => {
  simulate.mockImplementation(async (method) => {
    if (method === 'is_allowlist_active') { return false; }
    if (method === 'get_investor_claim_not_before') { return '1700000000'; }
    return answers[method];
  });
  const res = await request(app).get(url);
  expect(res.body.allowlist).toEqual({ active: false, allowlisted: false, eligible: true });
  expect(res.body.claimNotBeforeIso).toBe(new Date(1700000000 * 1000).toISOString());
});

test.each(['invalid', StrKey.encodeMed25519PublicKey(Buffer.concat([Buffer.alloc(32, 3), Buffer.alloc(8)]))])(
  'rejects invalid or muxed address: %s', async (address) => {
    const res = await request(app).get('/api/escrow/investors/' + address);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ADDRESS');
    expect(simulate).not.toHaveBeenCalled();
  }
);

test.each(methods)('fails atomically when %s simulation fails', async (failureMethod) => {
  simulate.mockImplementation(async (method) => {
    if (method === failureMethod) { throw new Error('private upstream detail'); }
    return answers[method];
  });
  const res = await request(app).get(url);
  expect(res.status).toBe(502);
  expect(res.body).toEqual({ code: 'ESCROW_READ_FAILED', method: failureMethod });
  expect(JSON.stringify(res.body)).not.toContain('private upstream detail');
});

test('returns 502 for latest-ledger lookup errors', async () => {
  ledger.mockRejectedValue(new Error('private RPC error'));
  const res = await request(app).get(url);
  expect(res.status).toBe(502);
  expect(res.body).toEqual({ code: 'ESCROW_READ_FAILED', method: 'latestLedger' });
});

test('caches repeated requests for five seconds without re-simulating', async () => {
  expect((await request(app).get(url)).status).toBe(200);
  expect((await request(app).get(url)).status).toBe(200);
  expect(simulate).toHaveBeenCalledTimes(7);
  expect(ledger).toHaveBeenCalledTimes(1);
});

test('GET /openapi.json includes endpoint and InvestorPosition schema', async () => {
  const res = await request(app).get('/openapi.json');
  expect(res.status).toBe(200);
  const endpoint = res.body.paths['/api/escrow/investors/{address}'].get;
  expect(endpoint.parameters[0].required).toBe(true);
  for (const status of ['200', '400', '502']) { expect(endpoint.responses[status]).toBeDefined(); }
  expect(endpoint.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/InvestorPosition');
  expect(res.body.components.schemas.InvestorPosition.properties.allowlist.properties.eligible.type).toBe('boolean');
});

test('simulation reader enforces its per-read timeout', async () => {
  // Restore the real reader: the suite-wide mock would otherwise bypass the timeout.
  simulate.mockRestore();
  const { rpc } = require('@stellar/stellar-sdk');
  const pending = jest.spyOn(rpc.Server.prototype, 'simulateTransaction')
    .mockImplementation(() => new Promise(() => {}));
  try {
    await expect(reader.simulateRead('get_contribution', [new Address(investor).toScVal()], { timeoutMs: 10 }))
      .rejects.toThrow('RPC timeout');
  } finally {
    pending.mockRestore();
  }
});
