'use strict';

const request = require('supertest');
const { createStandardizedApp } = require('../src/app');
const db = require('../src/db/knex');
const { createRedisEscrowSummaryCache } = require('../src/cache/redis');

// Mock external dependencies
jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (id === 'unknown-inv') return null;
    return `C_ESCROW_FOR_${id.toUpperCase()}`;
  }),
}));

// We'll mock soroban to test fallback
jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => {
    return operation();
  }),
}));

describe('GET /api/escrow/:invoiceId', () => {
  let app;
  let cache;

  beforeAll(() => {
    app = createStandardizedApp();
    cache = createRedisEscrowSummaryCache();
  });

  afterAll(async () => {
    await db.destroy();
    if (cache && cache.client) {
      await cache.client.quit();
    }
  });

  beforeEach(async () => {
    // Clear tables and cache
    await db('escrow_event_projection').del();
    if (cache && cache.client) {
      await cache.client.flushall();
    }
  });

  it('returns 404 for unknown invoice', async () => {
    const res = await request(app).get('/api/escrow/unknown-inv');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No escrow contract mapping found/);
  });

  it('reads from projection table when cache misses', async () => {
    // Seed projection
    await db('escrow_event_projection').insert({
      invoice_id: 'inv-proj-1',
      latest_event_id: 'evt_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 12345,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
      latest_observed_at: new Date()
    });

    const res = await request(app).get('/api/escrow/inv-proj-1');
    expect(res.status).toBe(200);
    expect(res.headers['x-escrow-address']).toBe('C_ESCROW_FOR_INV-PROJ-1');
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.fundedAmount).toBe(5000);
    expect(res.body.data.latest_ledger_sequence).toBe(12345);
    expect(res.body.data.latest_event_type).toBe('funded');
    expect(res.body.message).toMatch(/from event projection/);

    // Verify it was cached
    if (cache) {
      const cacheResult = await cache.getSummary('inv-proj-1', 12346);
      expect(cacheResult.hit).toBe(true);
      expect(cacheResult.value.status).toBe('funded');
    }
  });

  it('falls back to live read if projection misses', async () => {
    const res = await request(app).get('/api/escrow/inv-live-1');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('not_found'); // Based on mock fallback logic
    expect(res.body.data.latest_event_type).toBe('live_read');
    expect(res.body.message).toMatch(/live Soroban contract/);
  });

  it('invalidates cache on ledger gap', async () => {
    if (!cache) return; // Skip if no redis configured

    // Force set cache with old ledger
    await cache.setSummary('inv-gap-1', { status: 'pending', fundedAmount: 0 }, 1000);

    // If we were to query it at ledger 2000 (gap > threshold), it should miss.
    // In our app.js we don't pass currentLedger to cache.getSummary() so it doesn't gap-invalidate during GET.
    // But testing the cache gap invalidation directly:
    const cacheResult = await cache.getSummary('inv-gap-1', 2000);
    expect(cacheResult.hit).toBe(false);
    expect(cacheResult.reason).toBe('ledger_gap');
  });
});
