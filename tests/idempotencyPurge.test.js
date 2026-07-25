'use strict';

/**
 * Tests for the idempotency purge job covering:
 *  - Expired rows are deleted in batches
 *  - Valid (non-expired) rows are never deleted
 *  - Batch size is respected
 *  - Max batches limit is respected
 *  - Metrics are emitted correctly
 *  - Safe under concurrent inserts
 *  - Configuration from environment variables
 */

const db = require('../src/db/knex');
const {
  purgeExpiredKeys,
  deleteExpiredBatch,
  schedulePurge,
  triggerPurge,
  startPurgeWorker,
  stopPurgeWorker,
  getStats,
  getBatchSize,
  getIntervalMs,
  getMaxBatches,
  purgeQueue,
  purgeWorker,
} = require('../src/jobs/idempotencyPurge');

// Mock logger to avoid noise in tests
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock metrics to avoid real metric collection
jest.mock('../src/metrics', () => {
  const mockCounter = {
    inc: jest.fn(),
  };
  return {
    getRegistry: jest.fn(() => ({
      registerMetric: jest.fn(),
    })),
    Counter: jest.fn(() => mockCounter),
  };
});

/**
 * Helper to insert idempotency keys into the database for testing.
 * @param {Object} data - Key data
 * @returns {Promise<string>} The inserted key ID
 */
async function insertIdempotencyKey(data) {
  const [result] = await db('idempotency_keys')
    .insert({
      idempotency_key: data.key,
      request_fingerprint: data.fingerprint || 'abc123',
      response_status: data.responseStatus || 201,
      response_body: data.responseBody || JSON.stringify({ success: true }),
      expires_at: data.expiresAt,
      created_at: data.createdAt || new Date(),
      updated_at: data.updatedAt || new Date(),
    })
    .returning('id');

  return result.id;
}

/**
 * Helper to count rows in the idempotency_keys table.
 * @param {Object} [where] - Optional WHERE clause
 * @returns {Promise<number>} Count of rows
 */
async function countKeys(where = {}) {
  const [result] = await db('idempotency_keys')
    .count('* as count')
    .where(where);

  return parseInt(result.count, 10);
}

/**
 * Helper to get all keys from the database.
 * @returns {Promise<Array>} All idempotency keys
 */
async function getAllKeys() {
  return db('idempotency_keys').select('*').orderBy('created_at', 'asc');
}

// -- Setup -----------------------------------------------------------------

describe('Idempotency Purge Job', () => {
  beforeEach(async () => {
    // Clean up the table before each test
    await db('idempotency_keys').del();

    // Clear environment variables
    delete process.env.IDEMPOTENCY_PURGE_BATCH_SIZE;
    delete process.env.IDEMPOTENCY_PURGE_INTERVAL_MS;
    delete process.env.IDEMPOTENCY_PURGE_MAX_BATCHES;
  });

  afterEach(async () => {
    // Clean up after each test
    await db('idempotency_keys').del();
  });

  afterAll(async () => {
    // Stop the worker and close the database connection
    await stopPurgeWorker();
    await db.destroy();
  });

  // -- Configuration --------------------------------------------------------

  describe('Configuration', () => {
    it('uses default batch size when env var is not set', () => {
      expect(getBatchSize()).toBe(1000);
    });

    it('uses custom batch size from env var', () => {
      process.env.IDEMPOTENCY_PURGE_BATCH_SIZE = '500';
      expect(getBatchSize()).toBe(500);
    });

    it('caps batch size at 10000', () => {
      process.env.IDEMPOTENCY_PURGE_BATCH_SIZE = '50000';
      expect(getBatchSize()).toBe(10000);
    });

    it('uses default batch size for invalid env var', () => {
      process.env.IDEMPOTENCY_PURGE_BATCH_SIZE = 'invalid';
      expect(getBatchSize()).toBe(1000);
    });

    it('uses default interval when env var is not set', () => {
      expect(getIntervalMs()).toBe(3600000); // 1 hour
    });

    it('uses custom interval from env var', () => {
      process.env.IDEMPOTENCY_PURGE_INTERVAL_MS = '120000';
      expect(getIntervalMs()).toBe(120000);
    });

    it('enforces minimum interval of 60000ms', () => {
      process.env.IDEMPOTENCY_PURGE_INTERVAL_MS = '30000';
      expect(getIntervalMs()).toBe(3600000); // Falls back to default
    });

    it('uses default max batches when env var is not set', () => {
      expect(getMaxBatches()).toBe(100);
    });

    it('uses custom max batches from env var', () => {
      process.env.IDEMPOTENCY_PURGE_MAX_BATCHES = '50';
      expect(getMaxBatches()).toBe(50);
    });

    it('caps max batches at 1000', () => {
      process.env.IDEMPOTENCY_PURGE_MAX_BATCHES = '5000';
      expect(getMaxBatches()).toBe(1000);
    });
  });

  // -- Purge Logic ----------------------------------------------------------

  describe('Purge Logic', () => {
    it('deletes expired keys', async () => {
      // Insert an expired key
      const expiredDate = new Date(Date.now() - 86400000); // 1 day ago
      await insertIdempotencyKey({
        key: 'expired_key_1',
        expiresAt: expiredDate,
      });

      const deleted = await deleteExpiredBatch(1000);
      expect(deleted).toBe(1);

      const count = await countKeys();
      expect(count).toBe(0);
    });

    it('does not delete valid (non-expired) keys', async () => {
      // Insert a valid key that expires in the future
      const futureDate = new Date(Date.now() + 86400000); // 1 day from now
      await insertIdempotencyKey({
        key: 'valid_key_1',
        expiresAt: futureDate,
      });

      const deleted = await deleteExpiredBatch(1000);
      expect(deleted).toBe(0);

      const count = await countKeys();
      expect(count).toBe(1);
    });

    it('deletes only expired keys, preserving valid ones', async () => {
      const expiredDate = new Date(Date.now() - 86400000);
      const futureDate = new Date(Date.now() + 86400000);

      // Insert mix of expired and valid keys
      await insertIdempotencyKey({ key: 'expired_1', expiresAt: expiredDate });
      await insertIdempotencyKey({ key: 'valid_1', expiresAt: futureDate });
      await insertIdempotencyKey({ key: 'expired_2', expiresAt: expiredDate });
      await insertIdempotencyKey({ key: 'valid_2', expiresAt: futureDate });

      const deleted = await deleteExpiredBatch(1000);
      expect(deleted).toBe(2);

      const remaining = await getAllKeys();
      expect(remaining.length).toBe(2);
      expect(remaining[0].idempotency_key).toBe('valid_1');
      expect(remaining[1].idempotency_key).toBe('valid_2');
    });

    it('respects batch size limit', async () => {
      const expiredDate = new Date(Date.now() - 86400000);

      // Insert 10 expired keys
      for (let i = 0; i < 10; i++) {
        await insertIdempotencyKey({
          key: `expired_key_${i}`,
          expiresAt: expiredDate,
        });
      }

      // Delete with batch size of 5
      const deleted = await deleteExpiredBatch(5);
      expect(deleted).toBe(5);

      const remaining = await countKeys();
      expect(remaining).toBe(5);
    });

    it('deletes oldest expired keys first', async () => {
      const oldestDate = new Date(Date.now() - 172800000); // 2 days ago
      const newerDate = new Date(Date.now() - 86400000); // 1 day ago

      await insertIdempotencyKey({ key: 'newer_expired', expiresAt: newerDate });
      await insertIdempotencyKey({ key: 'oldest_expired', expiresAt: oldestDate });

      // Delete 1 key
      await deleteExpiredBatch(1);

      const remaining = await getAllKeys();
      expect(remaining.length).toBe(1);
      expect(remaining[0].idempotency_key).toBe('newer_expired');
    });
  });

  // -- Full Purge Job -------------------------------------------------------

  describe('Full Purge Job', () => {
    it('completes successfully when no expired keys exist', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      await insertIdempotencyKey({ key: 'valid_key', expiresAt: futureDate });

      const job = { id: 'test-job-1', payload: {} };
      const result = await purgeExpiredKeys(job);

      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(0);
      expect(result.batchCount).toBe(0);

      // Valid key should remain
      const count = await countKeys();
      expect(count).toBe(1);
    });

    it('purges all expired keys in multiple batches', async () => {
      process.env.IDEMPOTENCY_PURGE_BATCH_SIZE = '3';

      const expiredDate = new Date(Date.now() - 86400000);

      // Insert 8 expired keys
      for (let i = 0; i < 8; i++) {
        await insertIdempotencyKey({
          key: `expired_key_${i}`,
          expiresAt: expiredDate,
        });
      }

      const job = { id: 'test-job-2', payload: {} };
      const result = await purgeExpiredKeys(job);

      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(8);
      expect(result.batchCount).toBe(3); // 3 + 3 + 2 = 8

      const count = await countKeys();
      expect(count).toBe(0);
    });

    it('stops at max batches limit', async () => {
      process.env.IDEMPOTENCY_PURGE_BATCH_SIZE = '2';
      process.env.IDEMPOTENCY_PURGE_MAX_BATCHES = '3';

      const expiredDate = new Date(Date.now() - 86400000);

      // Insert 10 expired keys
      for (let i = 0; i < 10; i++) {
        await insertIdempotencyKey({
          key: `expired_key_${i}`,
          expiresAt: expiredDate,
        });
      }

      const job = { id: 'test-job-3', payload: {} };
      const result = await purgeExpiredKeys(job);

      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(6); // 3 batches × 2 per batch
      expect(result.batchCount).toBe(3);
      expect(result.maxBatchesReached).toBe(true);

      const remaining = await countKeys();
      expect(remaining).toBe(4); // 10 - 6 = 4
    });

    it('sets maxBatchesReached to false when all keys are purged', async () => {
      const expiredDate = new Date(Date.now() - 86400000);

      // Insert 5 expired keys
      for (let i = 0; i < 5; i++) {
        await insertIdempotencyKey({
          key: `expired_key_${i}`,
          expiresAt: expiredDate,
        });
      }

      const job = { id: 'test-job-4', payload: {} };
      const result = await purgeExpiredKeys(job);

      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(5);
      expect(result.maxBatchesReached).toBe(false);
    });

    it('includes duration in the result', async () => {
      const expiredDate = new Date(Date.now() - 86400000);
      await insertIdempotencyKey({ key: 'expired_key', expiresAt: expiredDate });

      const job = { id: 'test-job-5', payload: {} };
      const result = await purgeExpiredKeys(job);

      expect(result.durationSeconds).toBeDefined();
      expect(typeof result.durationSeconds).toBe('number');
      expect(result.durationSeconds).toBeGreaterThan(0);
    });
  });

  // -- Safety Under Concurrent Inserts --------------------------------------

  describe('Safety Under Concurrent Inserts', () => {
    it('never deletes keys that become valid during purge', async () => {
      const expiredDate = new Date(Date.now() - 86400000);
      const futureDate = new Date(Date.now() + 86400000);

      // Insert expired keys
      await insertIdempotencyKey({ key: 'expired_1', expiresAt: expiredDate });
      await insertIdempotencyKey({ key: 'expired_2', expiresAt: expiredDate });

      // Simulate concurrent insert during purge
      const insertPromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        await insertIdempotencyKey({ key: 'concurrent_insert', expiresAt: futureDate });
      })();

      // Run purge
      const job = { id: 'test-job-6', payload: {} };
      const result = await purgeExpiredKeys(job);

      await insertPromise;

      // Only expired keys should be deleted
      expect(result.totalDeleted).toBe(2);

      const remaining = await getAllKeys();
      expect(remaining.length).toBe(1);
      expect(remaining[0].idempotency_key).toBe('concurrent_insert');
    });
  });

  // -- Worker Management ----------------------------------------------------

  describe('Worker Management', () => {
    it('schedules a purge job with default delay', () => {
      const jobId = schedulePurge();
      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
    });

    it('schedules a purge job with custom delay', () => {
      const jobId = schedulePurge({ delayMs: 5000 });
      expect(jobId).toBeDefined();
    });

    it('triggers immediate purge', () => {
      const jobId = triggerPurge();
      expect(jobId).toBeDefined();
    });

    it('returns stats for worker and queue', () => {
      const stats = getStats();

      expect(stats).toBeDefined();
      expect(stats.worker).toBeDefined();
      expect(stats.queue).toBeDefined();
      expect(stats.config).toBeDefined();
      expect(stats.config.batchSize).toBeDefined();
      expect(stats.config.intervalMs).toBeDefined();
      expect(stats.config.maxBatches).toBeDefined();
    });

    it('starts purge worker successfully', () => {
      startPurgeWorker();
      expect(purgeWorker.isRunning).toBe(true);
    });

    it('does not start worker twice', () => {
      startPurgeWorker();
      const initialRunning = purgeWorker.isRunning;

      startPurgeWorker(); // Second call should be no-op

      expect(purgeWorker.isRunning).toBe(initialRunning);
    });

    it('stops purge worker gracefully', async () => {
      startPurgeWorker();
      expect(purgeWorker.isRunning).toBe(true);

      await stopPurgeWorker(100);
      expect(purgeWorker.isRunning).toBe(false);
    });
  });

  // -- Error Handling -------------------------------------------------------

  describe('Error Handling', () => {
    it('handles database errors gracefully', async () => {
      // Mock a database error by temporarily breaking the connection
      const originalRaw = db.raw;
      db.raw = jest.fn().mockRejectedValue(new Error('Database connection lost'));

      const job = { id: 'test-job-error', payload: {} };

      await expect(purgeExpiredKeys(job)).rejects.toThrow('Database connection lost');

      // Restore the original function
      db.raw = originalRaw;
    });

    it('includes error details in thrown exception', async () => {
      const originalRaw = db.raw;
      db.raw = jest.fn().mockRejectedValue(new Error('Test error'));

      const job = { id: 'test-job-error-2', payload: {} };

      try {
        await purgeExpiredKeys(job);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toBe('Test error');
      }

      db.raw = originalRaw;
    });
  });

  // -- Integration Test -----------------------------------------------------

  describe('Integration Test', () => {
    it('performs a complete purge cycle with realistic data', async () => {
      const now = Date.now();
      const expiredDate = new Date(now - 86400000); // 1 day ago
      const futureDate = new Date(now + 86400000); // 1 day from now

      // Insert 15 expired keys
      for (let i = 0; i < 15; i++) {
        await insertIdempotencyKey({
          key: `expired_${i}`,
          fingerprint: `fp_${i}`,
          expiresAt: expiredDate,
        });
      }

      // Insert 5 valid keys
      for (let i = 0; i < 5; i++) {
        await insertIdempotencyKey({
          key: `valid_${i}`,
          fingerprint: `fp_valid_${i}`,
          expiresAt: futureDate,
        });
      }

      const initialCount = await countKeys();
      expect(initialCount).toBe(20);

      // Run purge
      const job = { id: 'test-job-integration', payload: {} };
      const result = await purgeExpiredKeys(job);

      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(15);

      const finalCount = await countKeys();
      expect(finalCount).toBe(5);

      // Verify all remaining keys are valid
      const remaining = await getAllKeys();
      for (const key of remaining) {
        expect(key.idempotency_key).toMatch(/^valid_/);
        expect(new Date(key.expires_at).getTime()).toBeGreaterThan(now);
      }
    });
  });
});
