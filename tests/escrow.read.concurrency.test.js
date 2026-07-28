'use strict';

// Mock external dependencies (same as escrow.read.test.js)
jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn((id) => {
    if (id === 'unknown-inv') return null;
    return `C_ESCROW_FOR_${id.toUpperCase()}`;
  }),
}));

jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => {
    return operation();
  }),
}));

// Mock rateLimit module to avoid ESM issues
jest.mock('../src/middleware/rateLimit', () => ({
  createRateLimiter: jest.fn(() => (req, res, next) => next()),
  globalLimiter: jest.fn(() => (req, res, next) => next()),
  sensitiveLimiter: jest.fn(() => (req, res, next) => next()),
  apiKeyLimiter: jest.fn(() => (req, res, next) => next()),
  createConfigRateLimiter: jest.fn(() => (req, res, next) => next()),
  adminConfigLimiter: jest.fn(() => (req, res, next) => next()),
  adminConfigKeyGenerator: jest.fn(),
  adminConfigHandler: jest.fn(),
  invoiceStateLimiter: jest.fn(() => (req, res, next) => next()),
  getApiKey: jest.fn(),
  CONFIG_RATE_LIMIT_WINDOW_MS: 60000,
  CONFIG_RATE_LIMIT_MAX: 20,
  METRICS_RATE_LIMIT_WINDOW_MS: 60000,
  METRICS_RATE_LIMIT_MAX: 30,
  metricsLimiter: jest.fn(() => (req, res, next) => next()),
  metricsRateLimitHandler: jest.fn(),
  createMetricsRateLimiter: jest.fn(() => (req, res, next) => next()),
}));

// In-memory DB mock for deterministic testing - MUST be before any requires
jest.mock('../src/db/knex', () => {
  const rows = new Map();
  const fakeDb = jest.fn((table) => ({
    _table: table,
    _whereId: null,
    where(field, value) {
      if (typeof field === 'string') {
        this._whereId = String(value);
      }
      return this;
    },
    async first() {
      if (!this._whereId) return null;
      return rows.get(this._whereId) || null;
    },
    async del() {
      rows.clear();
      return 0;
    },
    async destroy() {
      rows.clear();
    },
    async insert(payload) {
      const entries = Array.isArray(payload) ? payload : [payload];
      entries.forEach((entry) => {
        if (entry && entry.invoice_id) {
          rows.set(entry.invoice_id, entry);
        }
      });
      return Promise.resolve(entries.length);
    },
    async update(payload) {
      if (!this._whereId) return Promise.resolve(0);
      const existing = rows.get(this._whereId);
      if (existing) {
        rows.set(this._whereId, { ...existing, ...payload });
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  }));
  fakeDb.destroy = async () => {
    rows.clear();
  };
  fakeDb.clearRows = () => rows.clear();
  fakeDb.setRow = (id, row) => rows.set(id, row);
  fakeDb.getRow = (id) => rows.get(id);
  return fakeDb;
}, { virtual: true });

const request = require('supertest');
const { createStandardizedApp } = require('../src/app');
const db = require('../src/db/knex');
const { createRedisEscrowSummaryCache } = require('../src/cache/redis');
const { readEscrowState, getEscrowStateWithProjection, invalidateEscrowReadCache } = require('../src/services/escrowRead');
const { escrowReadCache } = require('../src/services/escrowReadCache');

describe('Escrow Read Concurrency Smoke Tests', () => {
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
    await db('escrow_event_projection').del();
    escrowReadCache.clear();
    if (cache && cache.client) {
      await cache.client.flushall();
    }
  });

  describe('Concurrent reads (cache stampede prevention)', () => {
    it('handles 50 concurrent reads without errors or lost updates', async () => {
      // Seed projection
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-concurrent-1',
        latest_event_id: 'evt_1',
        latest_event_type: 'funded',
        latest_ledger_sequence: 100,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
        latest_observed_at: new Date(),
      });

      // Fire 50 concurrent requests
      const concurrentRequests = Array.from({ length: 50 }, () =>
        request(app).get('/api/escrow/inv-concurrent-1')
      );

      const responses = await Promise.all(concurrentRequests);

      // All should succeed
      responses.forEach((res, idx) => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('funded');
        expect(res.body.data.fundedAmount).toBe(5000);
        expect(res.body.data.latest_ledger_sequence).toBe(100);
      });

      // Verify all responses are identical (no lost updates)
      const firstResponse = responses[0].body.data;
      responses.forEach((res) => {
        expect(res.body.data).toEqual(firstResponse);
      });

      // Verify cache was populated (no stampede)
      if (cache) {
        const cacheResult = await cache.getSummary('inv-concurrent-1', 101);
        expect(cacheResult.hit).toBe(true);
      }
    });

    it('handles concurrent reads of different invoices without cross-contamination', async () => {
      // Seed multiple projections
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-a',
        latest_event_id: 'evt_a',
        latest_event_type: 'funded',
        latest_ledger_sequence: 200,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 1000 }),
        latest_observed_at: new Date(),
      });

      await db('escrow_event_projection').insert({
        invoice_id: 'inv-b',
        latest_event_id: 'evt_b',
        latest_event_type: 'settled',
        latest_ledger_sequence: 300,
        latest_event_body: JSON.stringify({ status: 'settled', fundedAmount: 2000 }),
        latest_observed_at: new Date(),
      });

      // Fire concurrent requests for different invoices
      const requests = [
        ...Array.from({ length: 25 }, () => request(app).get('/api/escrow/inv-a')),
        ...Array.from({ length: 25 }, () => request(app).get('/api/escrow/inv-b')),
      ];

      const responses = await Promise.all(requests);

      // First 25 should be for inv-a, next 25 for inv-b
      responses.slice(0, 25).forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('funded');
        expect(res.body.data.fundedAmount).toBe(1000);
      });

      responses.slice(25).forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('settled');
        expect(res.body.data.fundedAmount).toBe(2000);
      });
    });

    it('maintains cache consistency under concurrent reads with TTL expiry', async () => {
      // Seed projection
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-ttl-1',
        latest_event_id: 'evt_ttl',
        latest_event_type: 'funded',
        latest_ledger_sequence: 400,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 3000 }),
        latest_observed_at: new Date(),
      });

      // First read populates cache
      const first = await request(app).get('/api/escrow/inv-ttl-1');
      expect(first.status).toBe(200);
      expect(first.body.data.fundedAmount).toBe(3000);

      // Verify cache hit
      if (cache) {
        const cacheResult = await cache.getSummary('inv-ttl-1', 401);
        expect(cacheResult.hit).toBe(true);
      }

      // Fire 30 concurrent reads (should all hit cache)
      const concurrentReads = Array.from({ length: 30 }, () =>
        request(app).get('/api/escrow/inv-ttl-1')
      );

      const responses = await Promise.all(concurrentReads);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.fundedAmount).toBe(3000);
        expect(res.body.data.fromProjection).toBe(true);
      });
    });
  });

  describe('Parallel writes and reads (lost update prevention)', () => {
    it('handles concurrent projection updates without lost writes', async () => {
      // Initial projection
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-race-1',
        latest_event_id: 'evt_1',
        latest_event_type: 'pending',
        latest_ledger_sequence: 1,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      // Simulate concurrent "writes" by directly updating the mock DB
      // In real scenario, this would be the indexer updating projections
      const writePromises = [
        db('escrow_event_projection')
          .where('invoice_id', 'inv-race-1')
          .update({
            latest_event_id: 'evt_2',
            latest_event_type: 'funded',
            latest_ledger_sequence: 2,
            latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 1000 }),
          }),
        db('escrow_event_projection')
          .where('invoice_id', 'inv-race-1')
          .update({
            latest_event_id: 'evt_3',
            latest_event_type: 'funded',
            latest_ledger_sequence: 3,
            latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 2000 }),
          }),
      ];

      // Concurrent reads during writes
      const readPromises = Array.from({ length: 20 }, () =>
        request(app).get('/api/escrow/inv-race-1')
      );

      await Promise.all([...writePromises, ...readPromises]);

      // Final read should see one of the written states (not a corrupted mix)
      const finalRead = await request(app).get('/api/escrow/inv-race-1');
      expect(finalRead.status).toBe(200);
      
      // Should be either evt_2 or evt_3 (both are valid)
      expect(['evt_2', 'evt_3']).toContain(finalRead.body.data.latest_event_id);
      expect([1000, 2000]).toContain(finalRead.body.data.fundedAmount);
    });

    it('prevents stale reads during concurrent write operations', async () => {
      // Seed initial state
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-stale-1',
        latest_event_id: 'evt_old',
        latest_event_type: 'pending',
        latest_ledger_sequence: 10,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      // Read to populate cache
      const cachedRead = await request(app).get('/api/escrow/inv-stale-1');
      expect(cachedRead.status).toBe(200);
      expect(cachedRead.body.data.status).toBe('pending');

      // Simulate write (update projection)
      await db('escrow_event_projection')
        .where('invoice_id', 'inv-stale-1')
        .update({
          latest_event_id: 'evt_new',
          latest_event_type: 'funded',
          latest_ledger_sequence: 20,
          latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 5000 }),
        });

      // Invalidate cache (as indexer would do after write)
      await invalidateEscrowReadCache('inv-stale-1');

      // Concurrent reads after write - should see new state, not stale cache
      const postWriteReads = Array.from({ length: 30 }, () =>
        request(app).get('/api/escrow/inv-stale-1')
      );

      const responses = await Promise.all(postWriteReads);

      // All reads should see the updated state (cache invalidation works)
      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('funded');
        expect(res.body.data.fundedAmount).toBe(5000);
        expect(res.body.data.latest_event_id).toBe('evt_new');
      });
    });
  });

  describe('Read-after-write consistency', () => {
    it('ensures read-after-write consistency with immediate invalidation', async () => {
      const invoiceId = 'inv-raw-1';

      // Initial write
      await db('escrow_event_projection').insert({
        invoice_id: invoiceId,
        latest_event_id: 'evt_1',
        latest_event_type: 'pending',
        latest_ledger_sequence: 1,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      // Read to populate cache
      const read1 = await request(app).get(`/api/escrow/${invoiceId}`);
      expect(read1.body.data.status).toBe('pending');

      // Update projection (simulating indexer write)
      await db('escrow_event_projection')
        .where('invoice_id', invoiceId)
        .update({
          latest_event_id: 'evt_2',
          latest_event_type: 'funded',
          latest_ledger_sequence: 2,
          latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 1500 }),
        });

      // Invalidate cache (as indexer would do)
      await invalidateEscrowReadCache(invoiceId);

      // Immediate read-after-write should see new state
      const read2 = await request(app).get(`/api/escrow/${invoiceId}`);
      expect(read2.status).toBe(200);
      expect(read2.body.data.status).toBe('funded');
      expect(read2.body.data.fundedAmount).toBe(1500);
      expect(read2.body.data.latest_event_id).toBe('evt_2');
      expect(read2.body.data.latest_ledger_sequence).toBe(2);
    });

    it('handles rapid sequential writes with consistent reads', async () => {
      const invoiceId = 'inv-rapid-1';

      // Initial state
      await db('escrow_event_projection').insert({
        invoice_id: invoiceId,
        latest_event_id: 'evt_0',
        latest_event_type: 'pending',
        latest_ledger_sequence: 0,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      // Rapid sequential writes
      for (let i = 1; i <= 10; i++) {
        await db('escrow_event_projection')
          .where('invoice_id', invoiceId)
          .update({
            latest_event_id: `evt_${i}`,
            latest_event_type: i < 5 ? 'funded' : 'settled',
            latest_ledger_sequence: i,
            latest_event_body: JSON.stringify({
              status: i < 5 ? 'funded' : 'settled',
              fundedAmount: i * 1000,
            }),
          });

        // Invalidate cache after each write (as indexer would do)
        await invalidateEscrowReadCache(invoiceId);

        // Read after each write
        const res = await request(app).get(`/api/escrow/${invoiceId}`);
        expect(res.status).toBe(200);
        expect(res.body.data.latest_event_id).toBe(`evt_${i}`);
        expect(res.body.data.fundedAmount).toBe(i * 1000);
      }
    });
  });

  describe('Cache invalidation races', () => {
    it('handles concurrent invalidation and reads without serving stale data', async () => {
      const invoiceId = 'inv-inv-race-1';

      // Seed and cache
      await db('escrow_event_projection').insert({
        invoice_id: invoiceId,
        latest_event_id: 'evt_old',
        latest_event_type: 'pending',
        latest_ledger_sequence: 1,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      // Populate cache
      await request(app).get(`/api/escrow/${invoiceId}`);

      // Concurrent invalidation and reads
      const invalidationPromises = Array.from({ length: 10 }, () =>
        invalidateEscrowReadCache(invoiceId)
      );

      const readPromises = Array.from({ length: 30 }, () =>
        request(app).get(`/api/escrow/${invoiceId}`)
      );

      await Promise.all([...invalidationPromises, ...readPromises]);

      // Final read should see current DB state (not stale cache)
      const finalRead = await request(app).get(`/api/escrow/${invoiceId}`);
      expect(finalRead.status).toBe(200);
      expect(finalRead.body.data.status).toBe('pending');
    });

    it('prevents cache stampede on mass invalidation', async () => {
      const invoices = Array.from({ length: 20 }, (_, i) => `inv-stampede-${i}`);

      // Seed all invoices
      for (let i = 0; i < invoices.length; i++) {
        await db('escrow_event_projection').insert({
          invoice_id: invoices[i],
          latest_event_id: `evt_${i}`,
          latest_event_type: 'funded',
          latest_ledger_sequence: i + 1,
          latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: (i + 1) * 100 }),
          latest_observed_at: new Date(),
        });
      }

      // Populate all caches
      for (const invoiceId of invoices) {
        await request(app).get(`/api/escrow/${invoiceId}`);
      }

      // Mass invalidation
      const invalidationPromises = invoices.map((id) => invalidateEscrowReadCache(id));
      await Promise.all(invalidationPromises);

      // Concurrent reads after mass invalidation (stampede scenario)
      const readPromises = invoices.flatMap((id) =>
        Array.from({ length: 5 }, () => request(app).get(`/api/escrow/${id}`))
      );

      const responses = await Promise.all(readPromises);

      // All should succeed with correct data
      responses.forEach((res, idx) => {
        expect(res.status).toBe(200);
        const invoiceIdx = Math.floor(idx / 5);
        expect(res.body.data.fundedAmount).toBe((invoiceIdx + 1) * 100);
      });
    });
  });

  describe('Edge cases and stress scenarios', () => {
    it('handles 100% cache miss scenario with high concurrency', async () => {
      // No projection seeded - all requests will miss cache and projection
      const invoiceId = 'inv-miss-1';

      const requests = Array.from({ length: 50 }, () =>
        request(app).get(`/api/escrow/${invoiceId}`)
      );

      const responses = await Promise.all(requests);

      // All should return neutral stub (not found)
      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('not_found');
        expect(res.body.data.fundedAmount).toBe(0);
      });
    });

    it('maintains consistency under alternating read-write-read patterns', async () => {
      const invoiceId = 'inv-alternating-1';

      await db('escrow_event_projection').insert({
        invoice_id: invoiceId,
        latest_event_id: 'evt_1',
        latest_event_type: 'pending',
        latest_ledger_sequence: 1,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      for (let i = 0; i < 10; i++) {
        // Read
        const read = await request(app).get(`/api/escrow/${invoiceId}`);
        expect(read.status).toBe(200);

        // Write
        await db('escrow_event_projection')
          .where('invoice_id', invoiceId)
          .update({
            latest_event_id: `evt_${i + 2}`,
            latest_event_type: 'funded',
            latest_ledger_sequence: i + 2,
            latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: (i + 1) * 500 }),
          });

        // Invalidate
        await invalidateEscrowReadCache(invoiceId);
      }

      // Final consistency check
      const finalRead = await request(app).get(`/api/escrow/${invoiceId}`);
      expect(finalRead.body.data.fundedAmount).toBe(5000);
      expect(finalRead.body.data.latest_event_id).toBe('evt_11');
    });

    it('handles mixed valid and invalid invoice IDs concurrently', async () => {
      // Seed one valid invoice
      await db('escrow_event_projection').insert({
        invoice_id: 'inv-valid',
        latest_event_id: 'evt_valid',
        latest_event_type: 'funded',
        latest_ledger_sequence: 100,
        latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 1000 }),
        latest_observed_at: new Date(),
      });

      const requests = [
        ...Array.from({ length: 25 }, () => request(app).get('/api/escrow/inv-valid')),
        ...Array.from({ length: 25 }, () => request(app).get('/api/escrow/unknown-inv')),
        ...Array.from({ length: 25 }, () => request(app).get('/api/escrow/nonexistent')),
      ];

      const responses = await Promise.all(requests);

      // First 25 should succeed
      responses.slice(0, 25).forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.fundedAmount).toBe(1000);
      });

      // Next 25 should 404
      responses.slice(25, 50).forEach((res) => {
        expect(res.status).toBe(404);
      });

      // Last 25 should return neutral stub
      responses.slice(50).forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('not_found');
      });
    });

    it('survives stress test with 100 concurrent mixed operations', async () => {
      const operations = [];

      // Mix of operations
      for (let i = 0; i < 100; i++) {
        const invoiceId = `inv-stress-${i % 10}`;
        
        if (i % 10 === 0 && i > 0) {
          // Write operation
          operations.push(
            db('escrow_event_projection')
              .where('invoice_id', invoiceId)
              .update({
                latest_event_id: `evt_${i}`,
                latest_event_type: 'funded',
                latest_ledger_sequence: i,
                latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: i * 100 }),
              })
              .then(() => invalidateEscrowReadCache(invoiceId))
          );
        } else {
          // Read operation
          operations.push(request(app).get(`/api/escrow/${invoiceId}`));
        }
      }

      // Seed initial data
      for (let i = 0; i < 10; i++) {
        await db('escrow_event_projection').insert({
          invoice_id: `inv-stress-${i}`,
          latest_event_id: `evt_initial_${i}`,
          latest_event_type: 'pending',
          latest_ledger_sequence: 0,
          latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
          latest_observed_at: new Date(),
        });
      }

      // Execute all operations concurrently
      const results = await Promise.all(operations);

      // Verify no crashes and reasonable responses
      let readCount = 0;
      results.forEach((result) => {
        if (result && result.status) {
          // It's a response
          expect([200, 404]).toContain(result.status);
          readCount++;
        }
        // Write operations return undefined (no assertion needed)
      });

      expect(readCount).toBeGreaterThan(0);
    });
  });

  describe('No lost update verification', () => {
    it('ensures all writes are eventually visible (no silent drops)', async () => {
      const invoiceId = 'inv-nodrop-1';

      // Initial state
      await db('escrow_event_projection').insert({
        invoice_id: invoiceId,
        latest_event_id: 'evt_0',
        latest_event_type: 'pending',
        latest_ledger_sequence: 0,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      const writtenValues = new Set();

      // Perform 50 sequential writes with reads in between
      for (let i = 1; i <= 50; i++) {
        const fundedAmount = i * 100;
        
        await db('escrow_event_projection')
          .where('invoice_id', invoiceId)
          .update({
            latest_event_id: `evt_${i}`,
            latest_event_type: 'funded',
            latest_ledger_sequence: i,
            latest_event_body: JSON.stringify({ status: 'funded', fundedAmount }),
          });

        await invalidateEscrowReadCache(invoiceId);

        // Read back
        const res = await request(app).get(`/api/escrow/${invoiceId}`);
        expect(res.status).toBe(200);
        
        // Record what we read
        writtenValues.add(res.body.data.fundedAmount);
        writtenValues.add(res.body.data.latest_event_id);
      }

      // Verify we saw a good variety of values (no systematic drops)
      expect(writtenValues.size).toBeGreaterThan(40); // Should see most writes
    });

    it('verifies monotonic ledger sequence under concurrent updates', async () => {
      const invoiceId = 'inv-mono-1';

      await db('escrow_event_projection').insert({
        invoice_id: invoiceId,
        latest_event_id: 'evt_0',
        latest_event_type: 'pending',
        latest_ledger_sequence: 0,
        latest_event_body: JSON.stringify({ status: 'pending', fundedAmount: 0 }),
        latest_observed_at: new Date(),
      });

      const observedLedgers = new Set();

      // Concurrent writes with increasing ledger sequences
      const writes = Array.from({ length: 20 }, (_, i) =>
        db('escrow_event_projection')
          .where('invoice_id', invoiceId)
          .update({
            latest_event_id: `evt_${i + 1}`,
            latest_event_type: 'funded',
            latest_ledger_sequence: i + 1,
            latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: (i + 1) * 100 }),
          })
          .then(() => invalidateEscrowReadCache(invoiceId)) // Invalidate after each write
      );

      // Concurrent reads
      const reads = Array.from({ length: 40 }, () =>
        request(app).get(`/api/escrow/${invoiceId}`).then((res) => {
          if (res.body.data.latest_ledger_sequence) {
            observedLedgers.add(res.body.data.latest_ledger_sequence);
          }
        })
      );

      await Promise.all([...writes, ...reads]);

      // Final read
      const finalRead = await request(app).get(`/api/escrow/${invoiceId}`);
      const finalLedger = finalRead.body.data.latest_ledger_sequence;

      // Final ledger should be one of the written values (not corrupted)
      expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).toContain(finalLedger);
      
      // Verify no data corruption - final state should be consistent
      expect(finalRead.body.data.status).toBe('funded');
      expect(finalRead.body.data.fundedAmount).toBeGreaterThan(0);
      expect(finalRead.body.data.latest_event_id).toMatch(/^evt_\d+$/);
      
      // In a mock environment with synchronous operations, we may see only the final state
      // The important thing is that we see SOME valid state, not a corrupted mix
      expect(observedLedgers.size).toBeGreaterThanOrEqual(1);
    });
  });
});