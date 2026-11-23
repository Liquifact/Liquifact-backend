'use strict';

/**
 * @fileoverview Integration tests for GET /api/escrow/events
 *
 * Uses the real defaultStore singleton and clears it before each test.
 */

const request = require('supertest');
const { EVENT_TYPES } = require('../src/indexer/decode');

// Access the real defaultStore directly — the route uses this same singleton
const { defaultStore } = require('../src/indexer/EventStore');

// Build app once
const { createApp } = require('../src/app');

function makeEvent(overrides = {}) {
  return {
    id: overrides.id ?? '100-1',
    type: overrides.type ?? 'funded',
    ledger: overrides.ledger ?? 100,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    txHash: 'abc',
    contractId: 'CDUMMY',
    invoiceId: overrides.invoiceId ?? 'INV-1',
    data: overrides.data ?? {},
    ...overrides,
  };
}

describe('GET /api/escrow/events', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    defaultStore.clear();
  });

  // ── Basic response shape ──────────────────────────────────────────────────

  test('returns 200 with data array and nextCursor when store is empty', async () => {
    const res = await request(app).get('/api/escrow/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });

  test('returns stored events', async () => {
    defaultStore.append([makeEvent({ id: '100-1', type: 'funded' })]);
    const res = await request(app).get('/api/escrow/events');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('100-1');
    expect(res.body.data[0].type).toBe('funded');
  });

  // ── type filter ───────────────────────────────────────────────────────────

  test('filters by type', async () => {
    defaultStore.append([
      makeEvent({ id: '101-1', type: 'funded' }),
      makeEvent({ id: '102-1', type: 'settled' }),
      makeEvent({ id: '103-1', type: 'refunded' }),
    ]);
    const res = await request(app).get('/api/escrow/events?type=funded');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].type).toBe('funded');
  });

  test('returns 400 for an unknown type and lists allowed values', async () => {
    const res = await request(app).get('/api/escrow/events?type=fundng');
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain(EVENT_TYPES.join(', '));
  });

  test('returns empty array when type filter matches nothing', async () => {
    defaultStore.append([makeEvent({ id: '101-1', type: 'funded' })]);
    const res = await request(app).get('/api/escrow/events?type=settled');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  // ── investor filter ───────────────────────────────────────────────────────

  test('filters by investor address', async () => {
    const investorA = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';
    const investorB = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    defaultStore.append([
      makeEvent({ id: '200-1', type: 'funded', data: { investor: investorA } }),
      makeEvent({ id: '200-2', type: 'funded', data: { investor: investorB } }),
    ]);
    const res = await request(app).get(`/api/escrow/events?investor=${investorA}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].data.investor).toBe(investorA);
  });

  test('returns 400 for a malformed investor address', async () => {
    const res = await request(app).get('/api/escrow/events?investor=not-a-stellar-address');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INVESTOR_ADDRESS');
  });

  // ── contractId filter ────────────────────────────────────────────────────

  test('filters by originating contractId', async () => {
    defaultStore.append([
      makeEvent({ id: '250-1', contractId: 'CCONTRACT_A' }),
      makeEvent({ id: '250-2', contractId: 'CCONTRACT_B' }),
      makeEvent({ id: '250-3', contractId: 'CCONTRACT_B' }),
    ]);
    const res = await request(app).get('/api/escrow/events?contractId=CCONTRACT_B');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((e) => e.contractId === 'CCONTRACT_B')).toBe(true);
  });

  test('returns empty array when contractId matches nothing', async () => {
    defaultStore.append([makeEvent({ id: '251-1', contractId: 'CCONTRACT_A' })]);
    const res = await request(app).get('/api/escrow/events?contractId=CMISSING');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  test('combines contractId + type filter', async () => {
    defaultStore.append([
      makeEvent({ id: '252-1', type: 'funded', contractId: 'CCONTRACT_A' }),
      makeEvent({ id: '252-2', type: 'settled', contractId: 'CCONTRACT_A' }),
      makeEvent({ id: '252-3', type: 'funded', contractId: 'CCONTRACT_B' }),
    ]);
    const res = await request(app).get('/api/escrow/events?contractId=CCONTRACT_A&type=funded');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('252-1');
  });

  // ── fromLedger filter ─────────────────────────────────────────────────────

  test('filters by fromLedger', async () => {
    defaultStore.append([
      makeEvent({ id: '50-1', ledger: 50 }),
      makeEvent({ id: '100-2', ledger: 100 }),
      makeEvent({ id: '200-1', ledger: 200 }),
    ]);
    const res = await request(app).get('/api/escrow/events?fromLedger=100');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((e) => e.ledger >= 100)).toBe(true);
  });

  // ── limit ─────────────────────────────────────────────────────────────────

  test('respects limit parameter', async () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: `${200 + i}-1`, ledger: 200 + i }),
    );
    defaultStore.append(events);
    const res = await request(app).get('/api/escrow/events?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  test('returns 400 for limit=0', async () => {
    const res = await request(app).get('/api/escrow/events?limit=0');
    expect(res.status).toBe(400);
  });

  test('returns 400 for limit=201', async () => {
    const res = await request(app).get('/api/escrow/events?limit=201');
    expect(res.status).toBe(400);
  });

  test('returns 400 for non-integer limit', async () => {
    const res = await request(app).get('/api/escrow/events?limit=abc');
    expect(res.status).toBe(400);
  });

  test('accepts limit=1', async () => {
    defaultStore.append([makeEvent({ id: '1-1' })]);
    const res = await request(app).get('/api/escrow/events?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test('accepts limit=200', async () => {
    const res = await request(app).get('/api/escrow/events?limit=200');
    expect(res.status).toBe(200);
  });

  // ── fromLedger validation ─────────────────────────────────────────────────

  test('returns 400 for negative fromLedger', async () => {
    const res = await request(app).get('/api/escrow/events?fromLedger=-1');
    expect(res.status).toBe(400);
  });

  test('returns 400 for non-integer fromLedger', async () => {
    const res = await request(app).get('/api/escrow/events?fromLedger=abc');
    expect(res.status).toBe(400);
  });

  // ── cursor pagination ─────────────────────────────────────────────────────

  test('returns nextCursor when there are more results than limit', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `${300 + i}-1`, ledger: 300 + i }),
    );
    defaultStore.append(events);
    const res = await request(app).get('/api/escrow/events?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.nextCursor).not.toBeNull();
    expect(typeof res.body.nextCursor).toBe('string');
  });

  test('nextCursor is null when all results fit within the limit', async () => {
    defaultStore.append([makeEvent({ id: '400-1' }), makeEvent({ id: '400-2' })]);
    const res = await request(app).get('/api/escrow/events?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
  });

  test('paginates correctly using after parameter', async () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      makeEvent({ id: `${500 + i}-1`, ledger: 500 + i }),
    );
    defaultStore.append(events);

    const page1 = await request(app).get('/api/escrow/events?limit=3');
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(3);
    const cursor = page1.body.nextCursor;
    expect(cursor).not.toBeNull();

    const page2 = await request(app).get(`/api/escrow/events?limit=3&after=${cursor}`);
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(3);

    const page1Ids = page1.body.data.map((e) => e.id);
    const page2Ids = page2.body.data.map((e) => e.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  // ── combined filters ───────────────────────────────────────────────────────

  test('combines type + fromLedger filter', async () => {
    defaultStore.append([
      makeEvent({ id: '600-1', type: 'funded', ledger: 600 }),
      makeEvent({ id: '601-1', type: 'settled', ledger: 601 }),
      makeEvent({ id: '602-1', type: 'funded', ledger: 602 }),
      makeEvent({ id: '500-1', type: 'funded', ledger: 500 }),
    ]);
    const res = await request(app).get('/api/escrow/events?type=funded&fromLedger=600');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((e) => e.type === 'funded' && e.ledger >= 600)).toBe(true);
  });

  test('combines valid type + investor filters', async () => {
    const investor = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';
    defaultStore.append([
      makeEvent({ id: '700-1', type: 'funded', data: { investor } }),
      makeEvent({ id: '701-1', type: 'settled', data: { investor } }),
      makeEvent({ id: '702-1', type: 'funded', data: { investor: 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC' } }),
    ]);

    const res = await request(app).get(`/api/escrow/events?type=funded&investor=${investor}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('700-1');
  });

  test('documents the canonical event type list in OpenAPI', async () => {
    const res = await request(app).get('/openapi.json');
    const typeParameter = res.body.paths['/api/escrow/events'].get.parameters
      .find((parameter) => parameter.name === 'type');
    expect(typeParameter.schema.enum).toEqual(EVENT_TYPES);
  });
});
