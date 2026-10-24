'use strict';

/**
 * @fileoverview Integration tests for GET /api/escrow/events
 *
 * Uses the real defaultStore singleton and clears it before each test.
 */

const request = require('supertest');

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

  test('returns empty array when type filter matches nothing', async () => {
    defaultStore.append([makeEvent({ id: '101-1', type: 'funded' })]);
    const res = await request(app).get('/api/escrow/events?type=settled');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  // ── investor filter ───────────────────────────────────────────────────────

  test('filters by investor address', async () => {
    defaultStore.append([
      makeEvent({ id: '200-1', type: 'funded', data: { investor: 'GINVESTOR1' } }),
      makeEvent({ id: '200-2', type: 'funded', data: { investor: 'GINVESTOR2' } }),
    ]);
    const res = await request(app).get('/api/escrow/events?investor=GINVESTOR1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].data.investor).toBe('GINVESTOR1');
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
});
