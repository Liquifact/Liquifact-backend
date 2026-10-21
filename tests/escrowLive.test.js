'use strict';

/**
 * Route-level tests for GET /api/escrow and GET /api/escrow/live.
 *
 * The Soroban RPC simulation is mocked with a real `xdr.ScVal` map built via
 * `nativeToScVal` (i128/i64/u32), so no network access happens. On `main` the
 * live path returned `yield_bps`/`maturity` as strings; the decoder must
 * return numbers for both paths.
 */

const request = require('supertest');
const { nativeToScVal, xdr, rpc } = require('@stellar/stellar-sdk');
const app = require('../src/app');

const ADDRESS = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';

/**
 * Builds the `get_escrow` return value as a real `xdr.ScVal` map.
 *
 * @param {object} [overrides] raw values to override (BigInt-friendly)
 * @returns {xdr.ScVal} scvMap value
 */
function escrowScVal(overrides = {}) {
  const raw = {
    invoice_id: 'INV_0001',
    admin: ADDRESS,
    sme_address: ADDRESS,
    amount: '1000000000',
    funding_target: '1000000000',
    funded_amount: '0',
    yield_bps: 800,
    maturity: 1800132005,
    status: 1,
    ...overrides,
  };
  const entry = (key, val) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('invoice_id', nativeToScVal(raw.invoice_id)),
    entry('admin', nativeToScVal(raw.admin)),
    entry('sme_address', nativeToScVal(raw.sme_address)),
    entry('amount', nativeToScVal(raw.amount, { type: 'i128' })),
    entry('funding_target', nativeToScVal(raw.funding_target, { type: 'i128' })),
    entry('funded_amount', nativeToScVal(raw.funded_amount, { type: 'i128' })),
    entry('yield_bps', nativeToScVal(raw.yield_bps, { type: 'i64' })),
    entry('maturity', nativeToScVal(raw.maturity, { type: 'i64' })),
    entry('status', nativeToScVal(raw.status, { type: 'u32' })),
  ]);
}

/** Mocked simulation responses (set per test). */
const mockSim = { retval: null, latestLedger: 987654, fail: false };

let simSpy;

beforeAll(() => {
  simSpy = jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockImplementation(async () => {
    if (mockSim.fail) {
      throw new Error('RPC unavailable');
    }
    return { result: { retval: mockSim.retval }, latestLedger: mockSim.latestLedger };
  });
});

afterAll(() => {
  simSpy.mockRestore();
});

beforeEach(() => {
  mockSim.fail = false;
  mockSim.latestLedger = 987654;
  mockSim.retval = escrowScVal();
});

describe('GET /api/escrow/live — live read', () => {
  test('decodes i128/i64 values into numbers, not strings', async () => {
    const res = await request(app).get('/api/escrow/live');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('soroban-rpc');
    expect(res.body.latestLedger).toBe(987654);
    // On `main` these were strings ("800", "1800132005").
    expect(typeof res.body.escrow.yieldBps).toBe('number');
    expect(res.body.escrow.yieldBps).toBe(800);
    expect(typeof res.body.escrow.maturity).toBe('number');
    expect(res.body.escrow.maturity).toBe(1800132005);
    expect(res.body.escrow.status).toBe('funded');
    expect(res.body.escrow.statusCode).toBe(1);
    expect(res.body.escrow.fundedAmountDecimal).toBe('0.0000000');
    expect(res.body).not.toHaveProperty('warning');
  });

  test('live and snapshot escrow payloads share identical keys and types', async () => {
    // Same raw values as the deploy snapshot, so full deep equality holds.
    mockSim.retval = escrowScVal({ status: 0 });
    const live = (await request(app).get('/api/escrow/live')).body.escrow;
    const snapshot = (await request(app).get('/api/escrow')).body.snapshot;
    expect(Object.keys(live)).toEqual(Object.keys(snapshot));
    for (const key of Object.keys(live)) {
      expect(typeof live[key]).toBe(typeof snapshot[key]);
    }
    expect(live).toEqual(snapshot);
  });

  test('unknown status codes decode without throwing', async () => {
    mockSim.retval = escrowScVal({ status: 9 });
    const res = await request(app).get('/api/escrow/live');
    expect(res.status).toBe(200);
    expect(res.body.escrow.status).toBe('unknown');
    expect(res.body.escrow.statusCode).toBe(9);
  });
});

describe('GET /api/escrow/live — fallback', () => {
  test('falls back to the snapshot with a warning when the RPC fails', async () => {
    mockSim.fail = true;
    const res = await request(app).get('/api/escrow/live');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('snapshot');
    expect(res.body.warning).toEqual({ code: 'LIVE_READ_FAILED' });
    expect(typeof res.body.snapshotCapturedAt).toBe('string');
    expect(new Date(res.body.snapshotCapturedAt).toISOString()).toBe(res.body.snapshotCapturedAt);
    expect(res.body.escrow).toEqual((await request(app).get('/api/escrow')).body.snapshot);
    expect(res.body).not.toHaveProperty('latestLedger');
  });

  test('treats a malformed contract response as a read failure', async () => {
    mockSim.retval = escrowScVal({ yield_bps: 99999 });
    const res = await request(app).get('/api/escrow/live');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('snapshot');
    expect(res.body.warning).toEqual({ code: 'LIVE_READ_FAILED' });
  });
});

describe('GET /api/escrow/live?strict=true', () => {
  test('returns 200 with live data when the RPC succeeds', async () => {
    const res = await request(app).get('/api/escrow/live?strict=true');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('soroban-rpc');
    expect(res.body.escrow.yieldBps).toBe(800);
  });

  test('returns 503 ESCROW_LIVE_UNAVAILABLE instead of the snapshot when the RPC fails', async () => {
    mockSim.fail = true;
    const res = await request(app).get('/api/escrow/live?strict=true');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ESCROW_LIVE_UNAVAILABLE');
    expect(res.body).not.toHaveProperty('escrow');
  });

  test('returns 503 for a malformed contract response', async () => {
    mockSim.retval = escrowScVal({ amount: '-5' });
    const res = await request(app).get('/api/escrow/live?strict=true');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ESCROW_LIVE_UNAVAILABLE');
  });

  test('strict=false keeps the snapshot fallback', async () => {
    mockSim.fail = true;
    const res = await request(app).get('/api/escrow/live?strict=false');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('snapshot');
  });
});

describe('GET /api/escrow — snapshot decoding', () => {
  test('returns the deploy snapshot decoded as EscrowState', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.snapshot.invoiceId).toBe('INV_0001');
    expect(res.body.snapshot.status).toBe('open');
    expect(res.body.snapshot.yieldBps).toBe(800);
    expect(typeof res.body.snapshot.maturity).toBe('number');
    expect(res.body.snapshot.amountDecimal).toBe('100.0000000');
    expect(typeof res.body.snapshotCapturedAt).toBe('string');
  });

  test('DEPLOY_SNAPSHOT export stays available in raw on-chain form', () => {
    const { DEPLOY_SNAPSHOT } = require('../src/routes/escrow');
    expect(DEPLOY_SNAPSHOT.invoice_id).toBe('INV_0001');
    expect(DEPLOY_SNAPSHOT.yield_bps).toBe(800);
    expect(typeof DEPLOY_SNAPSHOT.capturedAt).toBe('string');
  });
});

describe('OpenAPI — escrow schemas', () => {
  test('documents EscrowState and EscrowLiveResponse and the live route', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    expect(spec.components.schemas.EscrowState).toBeDefined();
    expect(spec.components.schemas.EscrowLiveResponse).toBeDefined();

    const live = spec.paths['/api/escrow/live'].get;
    expect(live.parameters.map((p) => p.name)).toContain('strict');
    expect(live.responses['200']).toBeDefined();
    expect(live.responses['503'].content['application/json'].schema.properties.code.enum).toContain(
      'ESCROW_LIVE_UNAVAILABLE',
    );

    const meta = spec.paths['/api/escrow'].get;
    const snapshotSchema = meta.responses['200'].content['application/json'].schema.properties.snapshot;
    expect(snapshotSchema.$ref).toBe('#/components/schemas/EscrowState');
  });
});
