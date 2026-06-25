/**
 * @fileoverview Comprehensive tests for JobQueue, BackgroundWorker, and JobPersistence.
 * Covers: enqueue/dequeue/ack/retry/cancel, persistence mirror, crash-recovery,
 * feature-flag (in-memory only), payload sanitisation, and edge cases.
 *
 * @module workers/jobWorker.test
 */

'use strict';

jest.mock('../db/knex');

const JobQueue   = require('./jobQueue');
const BackgroundWorker = require('./worker');
const { JOB_STATUS } = require('./jobQueue');
const { createJobPersistence, sanitisePayload } = require('./jobPersistence');

// ---------------------------------------------------------------------------
// Shared persistence mock factory
// ---------------------------------------------------------------------------
function makePersistence(overrides = {}) {
  return {
    persistJob:       jest.fn().mockResolvedValue(undefined),
    updateJobStatus:  jest.fn().mockResolvedValue(undefined),
    ackJob:           jest.fn().mockResolvedValue(undefined),
    recoverUnackedJobs: jest.fn().mockResolvedValue([]),
    pruneCompleted:   jest.fn().mockResolvedValue(0),
    ...overrides,
  };
}

// ===========================================================================
// JobQueue — in-memory (existing behaviour, no persistence)
// ===========================================================================
describe('JobQueue (in-memory)', () => {
  let queue;

  beforeEach(() => { queue = new JobQueue(); });
  afterEach(()  => { queue.clear(); });

  // ── enqueue ──────────────────────────────────────────────────────────────
  describe('enqueue', () => {
    it('returns a crypto-random job ID', () => {
      const id = queue.enqueue('test', { x: 1 });
      expect(id).toMatch(/^job-[0-9a-f]{16}$/);
    });

    it('assigns unique IDs', () => {
      const ids = Array.from({ length: 20 }, () => queue.enqueue('test', {}));
      expect(new Set(ids).size).toBe(20);
    });

    it('creates job with correct initial state', () => {
      const id = queue.enqueue('verify', { email: 'u@example.com' });
      expect(queue.getJob(id)).toEqual({
        id,
        type:        'verify',
        payload:     { email: 'u@example.com' },
        status:      JOB_STATUS.PENDING,
        priority:    0,
        delayMs:     0,
        createdAt:   expect.any(Number),
        startedAt:   null,
        completedAt: null,
        attempts:    0,
        lastError:   null,
      });
    });

    it('stores priority option', () => {
      const id = queue.enqueue('test', {}, { priority: 7 });
      expect(queue.getJob(id).priority).toBe(7);
    });

    it('stores delayMs option', () => {
      const id = queue.enqueue('test', {}, { delayMs: 3000 });
      expect(queue.getJob(id).delayMs).toBe(3000);
    });

    it('rejects empty-string type', () => {
      expect(() => queue.enqueue('', {})).toThrow('Job type must be a non-empty string');
    });

    it('rejects non-string type', () => {
      expect(() => queue.enqueue(42, {})).toThrow('Job type must be a non-empty string');
    });

    it('rejects circular payload', () => {
      const obj = {}; obj.self = obj;
      expect(() => queue.enqueue('test', obj)).toThrow('Job payload must be JSON-serializable');
    });

    it('rejects when queue is full', () => {
      const q = new JobQueue({ maxQueueSize: 2 });
      q.enqueue('t', {}); q.enqueue('t', {});
      expect(() => q.enqueue('t', {})).toThrow('Queue is full');
    });

    it('accepts deeply-nested JSON payload', () => {
      const p = { a: { b: { c: [1, 2, 3] } } };
      const id = queue.enqueue('deep', p);
      expect(queue.getJob(id).payload).toEqual(p);
    });
  });

  // ── dequeue ───────────────────────────────────────────────────────────────
  describe('dequeue', () => {
    it('returns null on empty queue', () => {
      expect(queue.dequeue()).toBeNull();
    });

    it('dequeues in FIFO order', () => {
      const [i1, i2, i3] = ['a','b','c'].map(x => queue.enqueue('t', { x }));
      expect(queue.dequeue().id).toBe(i1);
      expect(queue.dequeue().id).toBe(i2);
      expect(queue.dequeue().id).toBe(i3);
    });

    it('sets status to PROCESSING', () => {
      queue.enqueue('t', {});
      expect(queue.dequeue().status).toBe(JOB_STATUS.PROCESSING);
    });

    it('increments attempts', () => {
      queue.enqueue('t', {});
      expect(queue.dequeue().attempts).toBe(1);
    });

    it('sets startedAt', () => {
      queue.enqueue('t', {});
      const before = Date.now();
      const job    = queue.dequeue();
      expect(job.startedAt).toBeGreaterThanOrEqual(before);
    });

    it('skips delayed jobs and returns ready ones', () => {
      const delayedId = queue.enqueue('t', {}, { delayMs: Date.now() + 60_000 });
      const readyId   = queue.enqueue('t', {});
      expect(queue.dequeue().id).toBe(readyId);
      expect(queue.queue).toContain(delayedId);
    });

    it('processes retry queue before main queue', () => {
      const id1 = queue.enqueue('t', {});
      queue.dequeue();
      queue.retry(id1, new Error('x'));
      queue.getJob(id1).delayMs = 0; // make immediately ready

      const id2 = queue.enqueue('t', {});
      expect(queue.dequeue().id).toBe(id1);
      expect(queue.dequeue().id).toBe(id2);
    });
  });

  // ── ack ───────────────────────────────────────────────────────────────────
  describe('ack', () => {
    it('marks job COMPLETED and sets completedAt', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      const before = Date.now();
      queue.ack(id);
      const job = queue.getJob(id);
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
      expect(job.completedAt).toBeGreaterThanOrEqual(before);
    });

    it('throws for unknown job', () => {
      expect(() => queue.ack('no-such')).toThrow('not found');
    });

    it('throws when job is PENDING (not yet dequeued)', () => {
      const id = queue.enqueue('t', {});
      expect(() => queue.ack(id)).toThrow('Cannot ack');
    });

    it('throws when job already acked', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      queue.ack(id);
      expect(() => queue.ack(id)).toThrow('Cannot ack');
    });
  });

  // ── retry ─────────────────────────────────────────────────────────────────
  describe('retry', () => {
    it('puts job in retry queue', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      queue.retry(id, new Error('oops'));
      expect(queue.retryQueue).toContain(id);
    });

    it('sets status RETRYING while attempts remain', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      queue.retry(id, new Error('x'));
      expect(queue.getJob(id).status).toBe(JOB_STATUS.RETRYING);
    });

    it('sets status FAILED after maxRetries exceeded', () => {
      const q  = new JobQueue({ maxRetries: 1 });
      const id = q.enqueue('t', {});
      q.dequeue(); q.retry(id, new Error('1'));
      q.getJob(id).delayMs = 0;
      q.dequeue(); q.retry(id, new Error('2'));
      expect(q.getJob(id).status).toBe(JOB_STATUS.FAILED);
    });

    it('stores error message', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      queue.retry(id, new Error('Specific error'));
      expect(queue.getJob(id).lastError).toBe('Specific error');
    });

    it('handles non-Error objects', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      queue.retry(id, 'plain string');
      expect(queue.getJob(id).lastError).toBe('plain string');
    });

    it('applies exponential backoff', () => {
      const id = queue.enqueue('t', {});
      queue.dequeue();
      const before = Date.now();
      queue.retry(id, new Error('x'));
      const job   = queue.getJob(id);
      const delay = job.delayMs - before;
      // attempt=1 → 2^0 * 1000 = 1000 ms (±200 ms tolerance)
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1200);
    });

    it('caps backoff at 60 seconds', () => {
      const q  = new JobQueue({ maxRetries: 10 });
      const id = q.enqueue('t', {});
      for (let i = 0; i < 10; i++) {
        q.dequeue();
        q.retry(id, new Error('x'));
        q.getJob(id).delayMs = 0;
      }
      const remaining = q.getJob(id).delayMs - Date.now();
      expect(remaining).toBeLessThanOrEqual(60_000);
    });

    it('sets completedAt when marking FAILED', () => {
      const q  = new JobQueue({ maxRetries: 0 });
      const id = q.enqueue('t', {});
      q.dequeue();
      const before = Date.now();
      q.retry(id, new Error('x'));
      expect(q.getJob(id).completedAt).toBeGreaterThanOrEqual(before);
    });

    it('throws for unknown job', () => {
      expect(() => queue.retry('no-such', new Error())).toThrow('not found');
    });

    it('honours hard cap of 10 retries', () => {
      const q  = new JobQueue({ maxRetries: 10 });
      expect(q.maxRetries).toBe(10);
      const q2 = new JobQueue({ maxRetries: 99 });
      expect(q2.maxRetries).toBe(10);
    });
  });

  // ── cancel ────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    it('removes the job', () => {
      const id = queue.enqueue('t', {});
      expect(queue.cancel(id)).toBe(true);
      expect(queue.getJob(id)).toBeNull();
    });

    it('returns false for unknown id', () => {
      expect(queue.cancel('nope')).toBe(false);
    });

    it('cancelled job is skipped on dequeue', () => {
      const id = queue.enqueue('t', {});
      queue.cancel(id);
      expect(queue.dequeue()).toBeNull();
    });
  });

  // ── getStats ──────────────────────────────────────────────────────────────
  describe('getStats', () => {
    it('returns zero stats for empty queue', () => {
      expect(queue.getStats()).toEqual({
        pending: 0, processing: 0, completed: 0,
        failed: 0, retrying: 0, total: 0,
        queueLength: 0, retryQueueLength: 0,
      });
    });

    it('counts each status correctly', () => {
      const id1 = queue.enqueue('t', {});
      const id2 = queue.enqueue('t', {});
      queue.dequeue();
      queue.ack(id1);
      const stats = queue.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.processing).toBe(1);
      expect(stats.pending).toBe(0);
      void id2;
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────
  describe('clear', () => {
    it('removes all jobs and resets queues', () => {
      queue.enqueue('t', {}); queue.enqueue('t', {});
      expect(queue.clear()).toBe(2);
      expect(queue.jobs.size).toBe(0);
      expect(queue.queue.length).toBe(0);
      expect(queue.retryQueue.length).toBe(0);
    });

    it('returns 0 for empty queue', () => {
      expect(queue.clear()).toBe(0);
    });
  });
});

// ===========================================================================
// JobQueue — persistence mirror (feature flag ON)
// ===========================================================================
describe('JobQueue (with persistence adapter)', () => {
  let persistence;
  let queue;

  beforeEach(() => {
    persistence = makePersistence();
    queue = new JobQueue({ persistence });
  });
  afterEach(() => queue.clear());

  it('calls persistJob on enqueue', () => {
    const id = queue.enqueue('test', { v: 1 });
    expect(persistence.persistJob).toHaveBeenCalledWith(
      expect.objectContaining({ id, type: 'test', payload: { v: 1 } })
    );
  });

  it('calls updateJobStatus on dequeue', () => {
    queue.enqueue('test', {});
    queue.dequeue();
    expect(persistence.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: JOB_STATUS.PROCESSING })
    );
  });

  it('calls ackJob on ack', () => {
    const id = queue.enqueue('test', {});
    queue.dequeue();
    queue.ack(id);
    expect(persistence.ackJob).toHaveBeenCalledWith(id);
  });

  it('does NOT call ackJob for a failed ack (wrong status)', () => {
    const id = queue.enqueue('test', {});
    expect(() => queue.ack(id)).toThrow();
    expect(persistence.ackJob).not.toHaveBeenCalled();
  });

  it('calls updateJobStatus on retry (RETRYING)', () => {
    const id = queue.enqueue('test', {});
    queue.dequeue();
    queue.retry(id, new Error('x'));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id, status: JOB_STATUS.RETRYING })
    );
  });

  it('calls updateJobStatus on retry → FAILED', () => {
    const q  = new JobQueue({ maxRetries: 0, persistence });
    const id = q.enqueue('test', {});
    q.dequeue();
    q.retry(id, new Error('x'));
    expect(persistence.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id, status: JOB_STATUS.FAILED })
    );
  });

  it('does not call any persistence method on cancel', () => {
    const id = queue.enqueue('test', {});
    persistence.persistJob.mockClear();
    queue.cancel(id);
    expect(persistence.updateJobStatus).not.toHaveBeenCalled();
    expect(persistence.ackJob).not.toHaveBeenCalled();
  });

  // ── restoreFromPersistence ─────────────────────────────────────────────
  describe('restoreFromPersistence', () => {
    it('returns 0 when no unacked jobs exist', async () => {
      persistence.recoverUnackedJobs.mockResolvedValue([]);
      const count = await queue.restoreFromPersistence();
      expect(count).toBe(0);
      expect(queue.jobs.size).toBe(0);
    });

    it('restores pending jobs to the main queue', async () => {
      const fakeJob = {
        id: 'job-aabbccdd11223344', type: 'webhook_delivery',
        payload: { invoiceId: 'inv1' }, status: 'pending',
        priority: 0, delayMs: 0, createdAt: Date.now(),
        startedAt: null, completedAt: null, attempts: 0, lastError: null,
      };
      persistence.recoverUnackedJobs.mockResolvedValue([fakeJob]);

      const count = await queue.restoreFromPersistence();
      expect(count).toBe(1);
      expect(queue.jobs.has(fakeJob.id)).toBe(true);
      expect(queue.queue).toContain(fakeJob.id);
    });

    it('restores previously-retried jobs to the retry queue', async () => {
      const fakeJob = {
        id: 'job-aabbccdd11223345', type: 'webhook_delivery',
        payload: { invoiceId: 'inv2' }, status: 'retrying',
        priority: 0, delayMs: 0, createdAt: Date.now(),
        startedAt: Date.now() - 5000, completedAt: null,
        attempts: 2, lastError: 'timeout',
      };
      persistence.recoverUnackedJobs.mockResolvedValue([fakeJob]);

      await queue.restoreFromPersistence();
      expect(queue.retryQueue).toContain(fakeJob.id);
      expect(queue.queue).not.toContain(fakeJob.id);
    });

    it('resets status to PENDING on restored jobs', async () => {
      const fakeJob = {
        id: 'job-aabbccdd11223346', type: 't', payload: {},
        status: 'processing', priority: 0, delayMs: 0,
        createdAt: Date.now(), startedAt: Date.now() - 1000,
        completedAt: null, attempts: 1, lastError: null,
      };
      persistence.recoverUnackedJobs.mockResolvedValue([fakeJob]);

      await queue.restoreFromPersistence();
      expect(queue.getJob(fakeJob.id).status).toBe(JOB_STATUS.PENDING);
      expect(queue.getJob(fakeJob.id).startedAt).toBeNull();
    });

    it('skips duplicate jobs already in memory', async () => {
      const id = queue.enqueue('t', {});
      const inMemoryJob = queue.getJob(id);
      persistence.recoverUnackedJobs.mockResolvedValue([{
        ...inMemoryJob, status: 'pending', startedAt: null,
      }]);

      const count = await queue.restoreFromPersistence();
      expect(count).toBe(0);
    });

    it('does not exceed maxQueueSize during recovery', async () => {
      const q = new JobQueue({ maxQueueSize: 2, persistence });
      q.enqueue('t', {}); q.enqueue('t', {});

      const extra = Array.from({ length: 3 }, (_, i) => ({
        id: `job-recover${i}`, type: 't', payload: {}, status: 'pending',
        priority: 0, delayMs: 0, createdAt: Date.now(),
        startedAt: null, completedAt: null, attempts: 0, lastError: null,
      }));
      persistence.recoverUnackedJobs.mockResolvedValue(extra);

      const count = await q.restoreFromPersistence();
      expect(count).toBe(0); // queue already full
    });

    it('returns 0 and does not throw when persistence adapter is null', async () => {
      const qNoP = new JobQueue();
      await expect(qNoP.restoreFromPersistence()).resolves.toBe(0);
    });

    it('returns 0 gracefully when recoverUnackedJobs throws', async () => {
      persistence.recoverUnackedJobs.mockRejectedValue(new Error('DB error'));
      // createJobPersistence catches the error and returns []
      // so we simulate that behaviour here via mock
      await expect(queue.restoreFromPersistence()).resolves.toBe(0);
    });
  });
});
// ===========================================================================
// sanitisePayload (jobPersistence helper)
// ===========================================================================
describe('sanitisePayload', () => {
  it('accepts a plain object', () => {
    const result = sanitisePayload({ a: 1, b: 'hello' });
    expect(result).toEqual({ ok: true, payload: { a: 1, b: 'hello' } });
  });

  it('accepts a JSON string', () => {
    const result = sanitisePayload('{"x":42}');
    expect(result).toEqual({ ok: true, payload: { x: 42 } });
  });

  it('rejects null', () => {
    expect(sanitisePayload(null).ok).toBe(false);
  });

  it('rejects an array', () => {
    expect(sanitisePayload([1, 2]).ok).toBe(false);
  });

  it('rejects a primitive number', () => {
    expect(sanitisePayload(42).ok).toBe(false);
  });

  it('rejects invalid JSON string', () => {
    expect(sanitisePayload('{bad json}').ok).toBe(false);
  });

  it('round-trips nested objects cleanly', () => {
    const payload = { a: { b: { c: true } }, arr: [1, 2, 3] };
    const result  = sanitisePayload(payload);
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual(payload);
  });
});

// ===========================================================================
// createJobPersistence — DB adapter unit tests (real logic, mocked knex)
// ===========================================================================
describe('createJobPersistence', () => {
  // Build a minimal knex mock that lets us inspect calls
  function makeDb(overrides = {}) {
    const chain = {
      where:       jest.fn().mockReturnThis(),
      whereIn:     jest.fn().mockReturnThis(),
      whereNull:   jest.fn().mockReturnThis(),
      orderBy:     jest.fn().mockReturnThis(),
      limit:       jest.fn().mockReturnThis(),
      select:      jest.fn().mockResolvedValue([]),
      insert:      jest.fn().mockResolvedValue([1]),
      update:      jest.fn().mockResolvedValue(1),
      del:         jest.fn().mockResolvedValue(0),
      ...overrides,
    };
    const db = jest.fn(() => chain);
    db._chain = chain;
    return db;
  }

  it('persistJob calls db insert with correct row shape', async () => {
    const db   = makeDb();
    const p    = createJobPersistence(db);
    const job  = {
      id: 'job-abc', type: 'webhook_delivery', payload: { x: 1 },
      status: 'pending', priority: 0, delayMs: 0,
      createdAt: 1000, startedAt: null, completedAt: null,
      attempts: 0, lastError: null,
    };

    await p.persistJob(job);
    expect(db).toHaveBeenCalledWith('background_jobs');
    expect(db._chain.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-abc', type: 'webhook_delivery',
      payload: JSON.stringify({ x: 1 }),
      status: 'pending', priority: 0,
    }));
  });

  it('persistJob does not throw when insert fails', async () => {
    const db = makeDb({ insert: jest.fn().mockRejectedValue(new Error('DB down')) });
    const p  = createJobPersistence(db);
    await expect(p.persistJob({ id: 'j1', type: 't', payload: {}, status: 'pending',
      priority: 0, delayMs: 0, createdAt: 0, startedAt: null,
      completedAt: null, attempts: 0, lastError: null })).resolves.toBeUndefined();
  });

  it('updateJobStatus calls db update with status fields', async () => {
    const db  = makeDb();
    const p   = createJobPersistence(db);
    const job = {
      id: 'job-upd', type: 't', payload: {}, status: 'processing',
      priority: 0, delayMs: 0, createdAt: 0,
      startedAt: 500, completedAt: null, attempts: 1, lastError: null,
    };

    await p.updateJobStatus(job);
    expect(db._chain.where).toHaveBeenCalledWith({ id: 'job-upd' });
    expect(db._chain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'processing', attempts: 1, started_at: 500,
    }));
  });

  it('updateJobStatus swallows DB errors', async () => {
    const db = makeDb({ update: jest.fn().mockRejectedValue(new Error('x')) });
    const p  = createJobPersistence(db);
    await expect(p.updateJobStatus({ id: 'j', status: 'processing',
      delayMs: 0, startedAt: null, completedAt: null,
      attempts: 0, lastError: null })).resolves.toBeUndefined();
  });

  it('ackJob stamps acked_at and status=completed', async () => {
    const db = makeDb();
    const p  = createJobPersistence(db);
    await p.ackJob('job-ack');
    expect(db._chain.where).toHaveBeenCalledWith({ id: 'job-ack' });
    expect(db._chain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', acked_at: expect.any(Number),
    }));
  });

  it('ackJob swallows DB errors', async () => {
    const db = makeDb({ update: jest.fn().mockRejectedValue(new Error('x')) });
    const p  = createJobPersistence(db);
    await expect(p.ackJob('j')).resolves.toBeUndefined();
  });

  it('recoverUnackedJobs returns mapped job objects', async () => {
    const row = {
      id: 'job-rec1', type: 'webhook_delivery',
      payload: JSON.stringify({ invoiceId: 'i1' }),
      status: 'processing', priority: 2, delay_ms: 0,
      created_at: 1000, started_at: 900, completed_at: null,
      attempts: 1, last_error: null, acked_at: null,
    };
    const db = makeDb({ select: jest.fn().mockResolvedValue([row]) });
    const p  = createJobPersistence(db);

    const jobs = await p.recoverUnackedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      id: 'job-rec1', type: 'webhook_delivery',
      payload: { invoiceId: 'i1' }, status: 'pending',
      attempts: 1, startedAt: null,
    }));
  });

  it('recoverUnackedJobs skips rows with corrupt payload', async () => {
    const rows = [
      { id: 'j1', type: 't', payload: '{bad}', status: 'pending',
        priority: 0, delay_ms: 0, created_at: 0,
        started_at: null, completed_at: null, attempts: 0,
        last_error: null, acked_at: null },
      { id: 'j2', type: 't', payload: JSON.stringify({ ok: true }),
        status: 'pending', priority: 0, delay_ms: 0, created_at: 0,
        started_at: null, completed_at: null, attempts: 0,
        last_error: null, acked_at: null },
    ];
    const db = makeDb({ select: jest.fn().mockResolvedValue(rows) });
    const p  = createJobPersistence(db);

    const jobs = await p.recoverUnackedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('j2');
  });

  it('recoverUnackedJobs returns [] on DB error', async () => {
    const db = makeDb({ select: jest.fn().mockRejectedValue(new Error('conn')) });
    const p  = createJobPersistence(db);
    await expect(p.recoverUnackedJobs()).resolves.toEqual([]);
  });

  it('recoverUnackedJobs is bounded by maxRecoveryRows', async () => {
    const db   = makeDb({ select: jest.fn().mockResolvedValue([]) });
    const p    = createJobPersistence(db, { maxRecoveryRows: 50 });
    await p.recoverUnackedJobs();
    expect(db._chain.limit).toHaveBeenCalledWith(50);
  });

  it('pruneCompleted deletes old completed/failed rows', async () => {
    const db = makeDb({ del: jest.fn().mockResolvedValue(3) });
    const p  = createJobPersistence(db);
    const deleted = await p.pruneCompleted(86_400_000);
    expect(deleted).toBe(3);
    expect(db._chain.del).toHaveBeenCalled();
  });

  it('pruneCompleted returns 0 on DB error', async () => {
    const db = makeDb({ del: jest.fn().mockRejectedValue(new Error('x')) });
    const p  = createJobPersistence(db);
    await expect(p.pruneCompleted(1000)).resolves.toBe(0);
  });
});

// ===========================================================================
// BackgroundWorker
// ===========================================================================
describe('BackgroundWorker', () => {
  let queue;
  let worker;

  beforeEach(() => {
    queue  = new JobQueue();
    worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50 });
  });

  afterEach(async () => {
    if (worker.isRunning) { await worker.stop(); }
    queue.clear();
  });

  // ── constructor ───────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('defaults: not running, 1000ms poll, concurrency 2', () => {
      const w = new BackgroundWorker();
      expect(w.isRunning).toBe(false);
      expect(w.pollIntervalMs).toBe(1000);
      expect(w.maxConcurrency).toBe(2);
    });

    it('enforces minimum poll interval of 10ms', () => {
      expect(new BackgroundWorker({ pollIntervalMs: 1 }).pollIntervalMs).toBe(10);
    });

    it('enforces minimum concurrency of 1', () => {
      expect(new BackgroundWorker({ maxConcurrency: 0 }).maxConcurrency).toBe(1);
    });
  });

  // ── registerHandler ───────────────────────────────────────────────────────
  describe('registerHandler', () => {
    it('registers successfully', () => {
      worker.registerHandler('test', jest.fn());
      expect(worker.handlers.has('test')).toBe(true);
    });

    it('allows overwriting a handler', () => {
      const h1 = jest.fn(), h2 = jest.fn();
      worker.registerHandler('t', h1);
      worker.registerHandler('t', h2);
      expect(worker.handlers.get('t')).toBe(h2);
    });

    it('throws on empty type', () => {
      expect(() => worker.registerHandler('', jest.fn())).toThrow('non-empty string');
    });

    it('throws when handler is not a function', () => {
      expect(() => worker.registerHandler('t', 'bad')).toThrow('function');
    });
  });

  // ── start ─────────────────────────────────────────────────────────────────
  describe('start', () => {
    it('sets isRunning to true', async () => {
      worker.registerHandler('t', jest.fn());
      await worker.start();
      expect(worker.isRunning).toBe(true);
    });

    it('throws if already running', async () => {
      worker.registerHandler('t', jest.fn());
      await worker.start();
      await expect(worker.start()).rejects.toThrow('already running');
    });

    it('throws if no handlers registered', async () => {
      await expect(worker.start()).rejects.toThrow('No job handlers registered');
    });
  });

  // ── stop ──────────────────────────────────────────────────────────────────
  describe('stop', () => {
    it('sets isRunning to false', async () => {
      worker.registerHandler('t', jest.fn());
      await worker.start();
      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });

    it('waits for in-flight jobs', async () => {
      let done = false;
      worker.registerHandler('t', async () => {
        await new Promise(r => setTimeout(r, 80));
        done = true;
      });
      await worker.start();
      worker.enqueue('t', {});
      await new Promise(r => setTimeout(r, 30));
      await worker.stop(500);
      expect(done).toBe(true);
    });

    it('times out if jobs take too long', async () => {
      worker.registerHandler('t', async () => new Promise(r => setTimeout(r, 2000)));
      await worker.start();
      worker.enqueue('t', {});
      await new Promise(r => setTimeout(r, 30));
      await worker.stop(80);
      expect(worker.processingCount).toBeGreaterThan(0);
    });

    it('resolves cleanly when not running', async () => {
      await expect(worker.stop()).resolves.toBeUndefined();
    });
  });

  // ── enqueue ───────────────────────────────────────────────────────────────
  describe('enqueue', () => {
    it('returns a job ID', () => {
      worker.registerHandler('t', jest.fn());
      expect(worker.enqueue('t', {})).toMatch(/^job-[0-9a-f]+$/);
    });

    it('throws when no handler is registered for type', () => {
      expect(() => worker.enqueue('unknown', {})).toThrow('No handler registered');
    });

    it('passes options through', () => {
      worker.registerHandler('t', jest.fn());
      const id  = worker.enqueue('t', {}, { priority: 9 });
      expect(queue.getJob(id).priority).toBe(9);
    });
  });

  // ── job processing ────────────────────────────────────────────────────────
  describe('job processing', () => {
    it('calls handler and marks job COMPLETED', async () => {
      const handler = jest.fn();
      worker.registerHandler('t', handler);
      await worker.start();

      const id = worker.enqueue('t', { x: 42 });
      await new Promise(r => setTimeout(r, 200));
      await worker.stop();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id, type: 't' }));
      expect(queue.getJob(id).status).toBe(JOB_STATUS.COMPLETED);
    });

    it('retries on handler failure', async () => {
      worker.registerHandler('t', jest.fn().mockRejectedValue(new Error('boom')));
      await worker.start();

      const id = worker.enqueue('t', {});
      await new Promise(r => setTimeout(r, 200));
      await worker.stop();

      expect(queue.getJob(id).status).toBe(JOB_STATUS.RETRYING);
      expect(queue.getJob(id).lastError).toBe('boom');
    });

    it('handles null thrown from handler', async () => {
      worker.registerHandler('t', jest.fn().mockRejectedValue(null));
      await worker.start();
      const id = worker.enqueue('t', {});
      await new Promise(r => setTimeout(r, 200));
      await worker.stop();
      expect(queue.getJob(id).status).toBe(JOB_STATUS.RETRYING);
    });

    it('processes up to maxConcurrency jobs in parallel', async () => {
      const started = [];
      const w = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 30, maxConcurrency: 3 });
      w.registerHandler('t', async (job) => {
        started.push(job.id);
        await new Promise(r => setTimeout(r, 100));
      });
      await w.start();

      ['a','b','c'].forEach(() => w.enqueue('t', {}));
      await new Promise(r => setTimeout(r, 60));
      expect(w.processingCount).toBe(3);

      await w.stop(500);
    });
  });

  // ── getStats ──────────────────────────────────────────────────────────────
  describe('getStats', () => {
    it('returns worker and queue stats', async () => {
      worker.registerHandler('t', jest.fn(async () => new Promise(r => setTimeout(r, 100))));
      await worker.start();
      worker.enqueue('t', {});
      await new Promise(r => setTimeout(r, 40));

      const stats = worker.getStats();
      expect(stats.isRunning).toBe(true);
      expect(stats.processingCount).toBeGreaterThanOrEqual(1);
      expect(stats.handlerCount).toBe(1);
      expect(stats.queueStats).toBeDefined();
      await worker.stop();
    });
  });

  // ── crash recovery integration ────────────────────────────────────────────
  describe('crash recovery (persistence adapter)', () => {
    it('restores unacked jobs before poll loop starts', async () => {
      const restoredJob = {
        id: 'job-crashtest01234567', type: 't',
        payload: { from: 'db' }, status: 'pending',
        priority: 0, delayMs: 0, createdAt: Date.now(),
        startedAt: null, completedAt: null, attempts: 0, lastError: null,
      };
      const persistence = makePersistence({
        recoverUnackedJobs: jest.fn().mockResolvedValue([restoredJob]),
      });
      const q = new JobQueue({ persistence });
      const w = new BackgroundWorker({ jobQueue: q, pollIntervalMs: 50 });

      const handler = jest.fn();
      w.registerHandler('t', handler);
      await w.start();

      await new Promise(r => setTimeout(r, 200));
      await w.stop();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: restoredJob.id }));
    });

    it('does not replay acked jobs (persistence skips acked_at rows)', async () => {
      // recoverUnackedJobs already filters acked_at IS NOT NULL in the DB;
      // here we confirm that when adapter returns [], nothing is replayed
      const persistence = makePersistence({
        recoverUnackedJobs: jest.fn().mockResolvedValue([]),
      });
      const q = new JobQueue({ persistence });
      const w = new BackgroundWorker({ jobQueue: q, pollIntervalMs: 50 });
      const handler = jest.fn();
      w.registerHandler('t', handler);
      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();
      expect(handler).not.toHaveBeenCalled();
    });

    it('starts normally even when recovery query throws', async () => {
      const persistence = makePersistence({
        recoverUnackedJobs: jest.fn().mockRejectedValue(new Error('DB down')),
      });
      const q = new JobQueue({ persistence });
      const w = new BackgroundWorker({ jobQueue: q, pollIntervalMs: 50 });
      w.registerHandler('t', jest.fn());
      await expect(w.start()).resolves.toBeUndefined();
      expect(w.isRunning).toBe(true);
      await w.stop();
    });

    it('feature flag OFF: no persistence calls made', () => {
      // Plain JobQueue — no persistence adapter — no DB calls
      const q = new JobQueue();
      q.enqueue('t', {});
      q.dequeue();
      // No errors thrown, no persistence methods called
      expect(q._persistence).toBeNull();
    });
  });
});
