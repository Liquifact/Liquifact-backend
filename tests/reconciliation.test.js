'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { reconcileInvoice, toStroops } = require('../src/services/reconciliation');
const { DEPLOY_SNAPSHOT } = require('../src/routes/escrow');
const config = require('../src/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal invoice that is in_sync with DEPLOY_SNAPSHOT. */
function syncedInvoice() {
  return {
    id: 'INV_0001',
    smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
    amount: 100,        // 100 XLM = 1 000 000 000 stroops
    fundedAmount: 0,
    yieldBps: 800,
    dueDate: '2027-01-17',  // 2027-01-17 maps to unix 1800172800; DEPLOY_SNAPSHOT maturity 1800132005 is ~11 h diff (< 1 day)
    status: 'open',
    onChain: true,
    _resolvedContractId: config.contractId,
  };
}

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('reconcileInvoice — pure function', () => {

  test('in_sync: seed INV_0001 vs DEPLOY_SNAPSHOT', () => {
    // Acceptance criterion: proves unit conversion (100 XLM ↔ "1000000000" stroops).
    const result = reconcileInvoice(syncedInvoice(), DEPLOY_SNAPSHOT);
    expect(result.status).toBe('in_sync');
    expect(result.mismatches).toHaveLength(0);
  });

  test('amount drift: off-chain 200 XLM ≠ on-chain 1 000 000 000 stroops', () => {
    const inv = { ...syncedInvoice(), amount: 200 };
    const result = reconcileInvoice(inv, DEPLOY_SNAPSHOT);
    expect(result.status).toBe('drift');
    const m = result.mismatches.find((x) => x.field === 'amount');
    expect(m).toBeDefined();
    expect(m.severity).toBe('critical');
    expect(m.offChain).toBe(toStroops(200).toString());
    expect(m.onChain).toBe('1000000000');
  });

  test('fundedAmount drift: off-chain fund call not reflected on-chain', () => {
    // Exact scenario from the issue: POST /fund increments off-chain fundedAmount
    // but on-chain funded_amount stays 0.
    const inv = { ...syncedInvoice(), fundedAmount: 10 }; // 10 XLM funded off-chain
    const result = reconcileInvoice(inv, DEPLOY_SNAPSHOT);
    expect(result.status).toBe('drift');
    const m = result.mismatches.find((x) => x.field === 'fundedAmount');
    expect(m).toBeDefined();
    expect(m.severity).toBe('critical');
    expect(m.offChain).toBe(toStroops(10).toString()); // 100000000
    expect(m.onChain).toBe('0');
  });

  test('status 3 (withdrawn) is compatible with off-chain "funded"', () => {
    const inv = { ...syncedInvoice(), status: 'funded' };
    const escrow = { ...DEPLOY_SNAPSHOT, status: 3 };
    const result = reconcileInvoice(inv, escrow);
    // status 3 maps to compatible with "funded" — should NOT produce a mismatch
    const statusMismatch = result.mismatches.find((x) => x.field === 'status');
    expect(statusMismatch).toBeUndefined();
  });

  test('status mismatch: off-chain "open" vs on-chain 1 (funded)', () => {
    const inv = { ...syncedInvoice(), status: 'open' };
    const escrow = { ...DEPLOY_SNAPSHOT, status: 1 };
    const result = reconcileInvoice(inv, escrow);
    expect(result.status).toBe('drift');
    const m = result.mismatches.find((x) => x.field === 'status');
    expect(m).toBeDefined();
    expect(m.severity).toBe('critical');
    expect(m.offChain).toBe('open');
    expect(m.onChain).toBe(1);
  });

  test('smeAddress mismatch is critical', () => {
    const inv = { ...syncedInvoice(), smeAddress: 'GDIFFERENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' };
    const result = reconcileInvoice(inv, DEPLOY_SNAPSHOT);
    expect(result.status).toBe('drift');
    const m = result.mismatches.find((x) => x.field === 'smeAddress');
    expect(m).toBeDefined();
    expect(m.severity).toBe('critical');
  });

  test('maturity within ±1 day tolerance: no mismatch', () => {
    // DEPLOY_SNAPSHOT.maturity = 1800132005 → ~2027-01-15T22:40:05Z
    // dueDate '2027-01-16' → within 24 h
    const inv = { ...syncedInvoice(), dueDate: '2027-01-16' };
    const result = reconcileInvoice(inv, DEPLOY_SNAPSHOT);
    const m = result.mismatches.find((x) => x.field === 'dueDate');
    expect(m).toBeUndefined();
  });

  test('maturity outside ±1 day tolerance: warning mismatch', () => {
    // dueDate '2027-02-01' is clearly > 1 day from maturity
    const inv = { ...syncedInvoice(), dueDate: '2027-02-01' };
    const result = reconcileInvoice(inv, DEPLOY_SNAPSHOT);
    expect(result.status).toBe('drift');
    const m = result.mismatches.find((x) => x.field === 'dueDate');
    expect(m).toBeDefined();
    expect(m.severity).toBe('warning');
  });

  test('invoice_id mismatch is critical', () => {
    const inv = { ...syncedInvoice(), id: 'INV_9999' };
    const result = reconcileInvoice(inv, DEPLOY_SNAPSHOT);
    expect(result.status).toBe('drift');
    const m = result.mismatches.find((x) => x.field === 'invoice_id');
    expect(m).toBeDefined();
    expect(m.severity).toBe('critical');
    expect(m.offChain).toBe('INV_9999');
    expect(m.onChain).toBe('INV_0001');
  });

  test('missing_on_chain when escrow is null', () => {
    const result = reconcileInvoice(syncedInvoice(), null);
    expect(result.status).toBe('missing_on_chain');
    expect(result.mismatches).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------
// HTTP integration tests (RPC mocked via jest.mock)
// ---------------------------------------------------------------------------

// Mock readEscrowOnChain at module level so it is intercepted before any
// require() in the reconciliation route resolves the real Soroban SDK.
// The mock preserves the actual router (so app.use('/api/escrow', ...) still
// receives a function) and the DEPLOY_SNAPSHOT constant, replacing only
// readEscrowOnChain with a jest.fn().
jest.mock('../src/routes/escrow', () => {
  const actual = jest.requireActual('../src/routes/escrow');
  // actual is the Express router function with DEPLOY_SNAPSHOT and
  // readEscrowOnChain attached as own properties.
  actual.readEscrowOnChain = jest.fn();
  return actual;
});

// Import the mocked module so tests can configure return values.
const escrowRoute = require('../src/routes/escrow');

describe('GET /api/reconciliation', () => {

  beforeEach(() => {
    store.reset();
    // Default: return the deploy snapshot (in-sync).
    escrowRoute.readEscrowOnChain.mockResolvedValue({ ...DEPLOY_SNAPSHOT });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('fund INV_0001 off-chain then GET /api/reconciliation/INV_0001 reports fundedAmount drift', async () => {
    // Fund off-chain only.
    await request(app).post('/api/invoices/INV_0001/fund').send({ amount: 10, investor: 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC' });

    // RPC still returns funded_amount: "0" (deploy snapshot).
    escrowRoute.readEscrowOnChain.mockResolvedValue({ ...DEPLOY_SNAPSHOT });

    const res = await request(app).get('/api/reconciliation/INV_0001');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('drift');
    const m = res.body.mismatches.find((x) => x.field === 'fundedAmount');
    expect(m).toBeDefined();
    expect(m.severity).toBe('critical');
    expect(m.onChain).toBe('0');
  });

  test('RPC failure → invoice reported as error, overall endpoint still 200', async () => {
    escrowRoute.readEscrowOnChain.mockRejectedValue(new Error('simulated RPC timeout'));

    const res = await request(app).get('/api/reconciliation');
    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.results.length).toBeGreaterThan(0);
    const errResult = res.body.results.find((r) => r.status === 'error');
    expect(errResult).toBeDefined();
    expect(errResult.code).toBe('RPC_ERROR');
    expect(errResult.detail).toMatch(/simulated RPC timeout/);
  });

  test('seed INV_0001 vs DEPLOY_SNAPSHOT is in_sync (proves unit conversion)', async () => {
    escrowRoute.readEscrowOnChain.mockResolvedValue({ ...DEPLOY_SNAPSHOT });

    const res = await request(app).get('/api/reconciliation/INV_0001');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_sync');
    expect(res.body.mismatches).toHaveLength(0);
  });

  test('GET /api/reconciliation/INV_0002 → 409 NOT_ON_CHAIN (onChain: false)', async () => {
    const res = await request(app).get('/api/reconciliation/INV_0002');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_ON_CHAIN');
  });

  test('GET /api/reconciliation/UNKNOWN → 404', async () => {
    const res = await request(app).get('/api/reconciliation/UNKNOWN');
    expect(res.status).toBe(404);
  });

  test('GET /api/reconciliation returns summary with expected shape', async () => {
    escrowRoute.readEscrowOnChain.mockResolvedValue({ ...DEPLOY_SNAPSHOT });

    const res = await request(app).get('/api/reconciliation');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('checkedAt');
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('results');
    const s = res.body.summary;
    expect(typeof s.inSync).toBe('number');
    expect(typeof s.drift).toBe('number');
    expect(typeof s.missing).toBe('number');
    expect(typeof s.error).toBe('number');
    // Only INV_0001 is onChain: true in seed data.
    expect(res.body.results).toHaveLength(1);
  });

});

// ---------------------------------------------------------------------------
// OpenAPI schema assertions
// ---------------------------------------------------------------------------

describe('GET /openapi.json — reconciliation paths and schemas', () => {

  test('new reconciliation paths are present', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/api/reconciliation');
    expect(paths).toContain('/api/reconciliation/{invoiceId}');
  });

  test('/api/reconciliation has 200 response with ReconciliationReport schema', async () => {
    const res = await request(app).get('/openapi.json');
    const op = res.body.paths['/api/reconciliation'].get;
    expect(op).toBeDefined();
    const schema = op.responses['200'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('checkedAt');
    expect(schema.properties).toHaveProperty('summary');
    expect(schema.properties).toHaveProperty('results');
  });

  test('/api/reconciliation/{invoiceId} has 200, 404, and 409 responses', async () => {
    const res = await request(app).get('/openapi.json');
    const op = res.body.paths['/api/reconciliation/{invoiceId}'].get;
    expect(op).toBeDefined();
    expect(op.responses).toHaveProperty('200');
    expect(op.responses).toHaveProperty('404');
    expect(op.responses).toHaveProperty('409');
  });

  test('ReconciliationResult schema includes mismatches array with severity enum', async () => {
    const res = await request(app).get('/openapi.json');
    const op = res.body.paths['/api/reconciliation/{invoiceId}'].get;
    const schema = op.responses['200'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('mismatches');
    const mismatchItem = schema.properties.mismatches.items;
    expect(mismatchItem.properties.severity.enum).toEqual(expect.arrayContaining(['critical', 'warning']));
  });

  test('Reconciliation tag is present', async () => {
    const res = await request(app).get('/openapi.json');
    const tagNames = res.body.tags.map((t) => t.name);
    expect(tagNames).toContain('Reconciliation');
  });

});
