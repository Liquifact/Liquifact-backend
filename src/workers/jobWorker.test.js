/**
 * @fileoverview Comprehensive tests for job queue and background worker.
 * Covers enqueue/dequeue, retry logic, error handling, and edge cases.
 * 
 * @module workers/jobWorker.test
 */

const JobQueue = require('./jobQueue');
const BackgroundWorker = require('./worker');
const { JOB_STATUS } = require('./jobQueue');

describe('JobQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new JobQueue();
  });

  afterEach(() => {
    queue.clear();
  });

  describe('enqueue', () => {
    it('should enqueue a job and return a job ID', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      expect(jobId).toMatch(/^job-[0-9a-f]+$/);
      expect(queue.jobs.size).toBe(1);
    });

    it('should assign unique job IDs', () => {
      const id1 = queue.enqueue('test', { data: 1 });
      const id2 = queue.enqueue('test', { data: 2 });
      expect(id1).not.toBe(id2);
    });

    it('should create job with correct initial state', () => {
      const jobId = queue.enqueue('verify', { email: 'test@example.com' });
      const job = queue.getJob(jobId);

      expect(job).toEqual({
        id: jobId,
        type: 'verify',
        payload: { email: 'test@example.com' },
        status: JOB_STATUS.PENDING,
        priority: 0,
        delayMs: 0,
        createdAt: expect.any(Number),
        startedAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
      });
    });

    it('should support priority option', () => {
      const jobId = queue.enqueue('test', { data: 'test' }, { priority: 5 });
      const job = queue.getJob(jobId);
      expect(job.priority).toBe(5);
    });

    it('should support delayMs option', () => {
      const delayMs = 5000;
      const jobId = queue.enqueue('test', { data: 'test' }, { delayMs });
      const job = queue.getJob(jobId);
      expect(job.delayMs).toBe(delayMs);
    });

    it('should reject invalid job type (empty string)', () => {
      expect(() => {
        queue.enqueue('', { data: 'test' });
      }).toThrow('Job type must be a non-empty string');
    });

    it('should reject invalid job type (non-string)', () => {
      expect(() => {
        queue.enqueue(123, { data: 'test' });
      }).toThrow('Job type must be a non-empty string');
    });

    it('should reject non-JSON-serializable payload', () => {
      const circular = { a: 1 };
      circular.self = circular; // Create circular reference

      expect(() => {
        queue.enqueue('test', circular);
      }).toThrow('Job payload must be JSON-serializable');
    });

    it('should reject when queue is full', () => {
      const smallQueue = new JobQueue({ maxQueueSize: 2 });
      smallQueue.enqueue('test', { data: 1 });
      smallQueue.enqueue('test', { data: 2 });

      expect(() => {
        smallQueue.enqueue('test', { data: 3 });
      }).toThrow('Queue is full');
    });

    it('should accept complex nested payloads', () => {
      const payload = {
        nested: { deep: { data: [1, 2, 3] } },
        array: [{ id: 1 }, { id: 2 }],
      };
      const jobId = queue.enqueue('complex', payload);
      const job = queue.getJob(jobId);
      expect(job.payload).toEqual(payload);
    });
  });

  describe('dequeue', () => {
    it('should return null when queue is empty', () => {
      expect(queue.dequeue()).toBeNull();
    });

    it('should dequeue jobs in FIFO order', () => {
      const id1 = queue.enqueue('test', { data: 1 });
      const id2 = queue.enqueue('test', { data: 2 });
      const id3 = queue.enqueue('test', { data: 3 });

      expect(queue.dequeue().id).toBe(id1);
      expect(queue.dequeue().id).toBe(id2);
      expect(queue.dequeue().id).toBe(id3);
    });

    it('should set job status to PROCESSING on dequeue', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const job = queue.dequeue();
      expect(job.status).toBe(JOB_STATUS.PROCESSING);
    });

    it('should increment attempts on dequeue', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const job = queue.dequeue();
      expect(job.attempts).toBe(1);
    });

    it('should skip delayed jobs', () => {
      const now = Date.now();
      const futureDelay = now + 10000;

      const delayedId = queue.enqueue('test', { data: 'delayed' }, { delayMs: futureDelay });
      const readyId = queue.enqueue('test', { data: 'ready' });

      const job = queue.dequeue();
      expect(job.id).toBe(readyId);
      expect(queue.queue).toContain(delayedId);
    });

    it('should process retry queue before main queue', () => {
      const id1 = queue.enqueue('test', { data: 1 });
      queue.dequeue(); // Move to processing
      queue.retry(id1, new Error('test')); // Add to retry queue with delay

      // For this test, manually set delay to 0 so it's immediately ready
      queue.getJob(id1).delayMs = 0;

      const id2 = queue.enqueue('test', { data: 2 });

      // Retry queue should be processed first
      expect(queue.dequeue().id).toBe(id1);
      expect(queue.dequeue().id).toBe(id2);
    });

    it('should set startedAt timestamp on dequeue', () => {
      queue.enqueue('test', { data: 'test' });
      const timeBefore = Date.now();
      const job = queue.dequeue();
      const timeAfter = Date.now();

      expect(job.startedAt).toBeGreaterThanOrEqual(timeBefore);
      expect(job.startedAt).toBeLessThanOrEqual(timeAfter);
    });
  });

  describe('ack', () => {
    it('should mark job as COMPLETED', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.dequeue();
      queue.ack(jobId);

      const job = queue.getJob(jobId);
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
    });

    it('should set completedAt timestamp', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.dequeue();

      const timeBefore = Date.now();
      queue.ack(jobId);
      const timeAfter = Date.now();

      const job = queue.getJob(jobId);
      expect(job.completedAt).toBeGreaterThanOrEqual(timeBefore);
      expect(job.completedAt).toBeLessThanOrEqual(timeAfter);
    });

    it('should throw when acking non-existent job', () => {
      expect(() => {
        queue.ack('non-existent-job');
      }).toThrow('Job non-existent-job not found');
    });

    it('should throw when acking non-processing job', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      expect(() => {
        queue.ack(jobId); // Not dequeued yet
      }).toThrow('Cannot ack job');
    });

    it('should throw when acking completed job', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.dequeue();
      queue.ack(jobId);

      expect(() => {
        queue.ack(jobId); // Already acked
      }).toThrow('Cannot ack job');
    });
  });

  describe('retry', () => {
    it('should put job back in retry queue', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.dequeue();
      queue.retry(jobId, new Error('Failed'));

      expect(queue.retryQueue).toContain(jobId);
    });

    it('should set status to RETRYING when attempts remain', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const job = queue.dequeue();
      queue.retry(jobId, new Error('Failed'));

      expect(job.status).toBe(JOB_STATUS.RETRYING);
    });

    it('should set status to FAILED when max retries exceeded', () => {
      const smallQueue = new JobQueue({ maxRetries: 1 });
      const jobId = smallQueue.enqueue('test', { data: 'test' });

      // Attempt 1
      smallQueue.dequeue();
      smallQueue.retry(jobId, new Error('First failure'));
      expect(smallQueue.getJob(jobId).status).toBe(JOB_STATUS.RETRYING);

      // For test, make job immediately ready (set delay to 0)
      smallQueue.getJob(jobId).delayMs = 0;

      // Attempt 2
      smallQueue.dequeue();
      smallQueue.retry(jobId, new Error('Second failure'));
      expect(smallQueue.getJob(jobId).status).toBe(JOB_STATUS.FAILED);
    });

    it('should implement exponential backoff delays', () => {
      const jobId = queue.enqueue('test', { data: 'test' });

      for (let i = 0; i < 2; i++) {
        const job = queue.dequeue();
        const beforeRetry = Date.now();
        queue.retry(jobId, new Error(`Failure ${i}`));
        
        const retryJob = queue.getJob(jobId);
        if (retryJob && retryJob.delayMs > beforeRetry) {
          const delay = retryJob.delayMs - beforeRetry;

          // Exponential backoff: 2^(attempt-1) seconds (in ms)
          // At i=0: attempts will be 1, delay = 2^0 = 1 second
          // At i=1: attempts will be 2, delay = 2^1 = 2 seconds
          const expectedDelay = Math.pow(2, i) * 1000;
          expect(delay).toBeCloseTo(expectedDelay, -2); // -2 = within 100ms
        }
        
        // For next iteration, make job ready immediately
        if (i < 1) {
          retryJob.delayMs = 0;
        }
      }
    });

    it('should cap retry delay at 60 seconds', () => {
      const smallQueue = new JobQueue({ maxRetries: 10 });
      let jobId = smallQueue.enqueue('test', { data: 'test' });

      // Retry 10 times to reach high attempt count
      for (let i = 0; i < 10; i++) {
        smallQueue.dequeue();
        smallQueue.retry(jobId, new Error('Failure'));
      }

      const job = smallQueue.getJob(jobId);
      const delayMs = job.delayMs - Date.now();
      expect(delayMs).toBeLessThanOrEqual(60000); // 60 seconds
    });

    it('should store error message', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.dequeue();
      queue.retry(jobId, new Error('Specific error message'));

      const job = queue.getJob(jobId);
      expect(job.lastError).toBe('Specific error message');
    });

    it('should handle non-Error objects', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.dequeue();
      queue.retry(jobId, 'String error');

      const job = queue.getJob(jobId);
      expect(job.lastError).toBe('String error');
    });

    it('should throw when retrying non-existent job', () => {
      expect(() => {
        queue.retry('non-existent-job', new Error('test'));
      }).toThrow('Job non-existent-job not found');
    });

    it('should set completedAt when max retries exceeded', () => {
      const smallQueue = new JobQueue({ maxRetries: 0 });
      const jobId = smallQueue.enqueue('test', { data: 'test' });
      const job1 = smallQueue.dequeue();
      
      expect(job1.attempts).toBe(1); // Verify dequeue incremented attempts

      const timeBefore = Date.now();
      smallQueue.retry(jobId, new Error('Failed'));
      const timeAfter = Date.now();

      const job = smallQueue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job.status).toBe(JOB_STATUS.FAILED);
      expect(job.completedAt).toBeDefined();
      expect(job.completedAt).toBeGreaterThanOrEqual(timeBefore);
      expect(job.completedAt).toBeLessThanOrEqual(timeAfter);
    });
  });

  describe('getJob', () => {
    it('should return job if exists', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const job = queue.getJob(jobId);
      expect(job.id).toBe(jobId);
      expect(job.type).toBe('test');
    });

    it('should return null if job does not exist', () => {
      expect(queue.getJob('non-existent')).toBeNull();
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty queue', () => {
      const stats = queue.getStats();
      expect(stats).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        retrying: 0,
        total: 0,
        queueLength: 0,
        retryQueueLength: 0,
      });
    });

    it('should count pending jobs', () => {
      queue.enqueue('test', { data: 1 });
      queue.enqueue('test', { data: 2 });

      const stats = queue.getStats();
      expect(stats.pending).toBe(2);
      expect(stats.total).toBe(2);
    });

    it('should count processing jobs', () => {
      const id1 = queue.enqueue('test', { data: 1 });
      const id2 = queue.enqueue('test', { data: 2 });

      queue.dequeue();
      queue.dequeue();

      const stats = queue.getStats();
      expect(stats.processing).toBe(2);
    });

    it('should count completed jobs', () => {
      const id1 = queue.enqueue('test', { data: 1 });
      const id2 = queue.enqueue('test', { data: 2 });

      queue.dequeue();
      queue.ack(id1);
      queue.dequeue();
      queue.ack(id2);

      const stats = queue.getStats();
      expect(stats.completed).toBe(2);
    });

    it('should count failed jobs', () => {
      const smallQueue = new JobQueue({ maxRetries: 0 });
      const id1 = smallQueue.enqueue('test', { data: 1 });

      smallQueue.dequeue();
      smallQueue.retry(id1, new Error('Failed'));

      const job = smallQueue.getJob(id1);
      expect(job.status).toBe(JOB_STATUS.FAILED);

      const stats = smallQueue.getStats();
      expect(stats.failed).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all jobs', () => {
      queue.enqueue('test', { data: 1 });
      queue.enqueue('test', { data: 2 });
      queue.enqueue('test', { data: 3 });

      const cleared = queue.clear();
      expect(cleared).toBe(3);
      expect(queue.jobs.size).toBe(0);
      expect(queue.queue.length).toBe(0);
      expect(queue.retryQueue.length).toBe(0);
    });

    it('should return zero when clearing empty queue', () => {
      const cleared = queue.clear();
      expect(cleared).toBe(0);
    });
  });
});

describe('BackgroundWorker', () => {
  let worker;
  let queue;

  beforeEach(() => {
    queue = new JobQueue();
    worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50 });
  });

  afterEach(async () => {
    if (worker.isRunning) {
      await worker.stop();
    }
    queue.clear();
  });

  describe('constructor', () => {
    it('should create worker with default options', () => {
      const w = new BackgroundWorker();
      expect(w.isRunning).toBe(false);
      expect(w.pollIntervalMs).toBe(1000);
      expect(w.maxConcurrency).toBe(2);
    });

    it('should enforce minimum poll interval', () => {
      const w = new BackgroundWorker({ pollIntervalMs: 5 });
      expect(w.pollIntervalMs).toBe(10);
    });

    it('should enforce minimum concurrency', () => {
      const w = new BackgroundWorker({ maxConcurrency: -5 });
      expect(w.maxConcurrency).toBe(1);
    });
  });

  describe('registerHandler', () => {
    it('should register a handler', () => {
      const handler = jest.fn();
      worker.registerHandler('test', handler);
      expect(worker.handlers.has('test')).toBe(true);
    });

    it('should throw on invalid job type', () => {
      expect(() => {
        worker.registerHandler('', jest.fn());
      }).toThrow('Job type must be a non-empty string');
    });

    it('should throw if handler is not a function', () => {
      expect(() => {
        worker.registerHandler('test', 'not a function');
      }).toThrow('Handler must be a function');
    });

    it('should allow overwriting existing handler', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      worker.registerHandler('test', handler1);
      worker.registerHandler('test', handler2);

      expect(worker.handlers.get('test')).toBe(handler2);
    });
  });

  describe('start', () => {
    it('should throw if already running', async () => {
      worker.registerHandler('test', jest.fn());
      worker.start();

      expect(() => {
        worker.start();
      }).toThrow('Worker is already running');

      await worker.stop();
    });

    it('should throw if no handlers registered', () => {
      expect(() => {
        worker.start();
      }).toThrow('No job handlers registered');
    });

    it('should set isRunning to true', () => {
      worker.registerHandler('test', jest.fn());
      worker.start();
      expect(worker.isRunning).toBe(true);
      worker.stop();
    });
  });

  describe('stop', () => {
    it('should set isRunning to false', async () => {
      worker.registerHandler('test', jest.fn());
      worker.start();
      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });

    it('should wait for in-flight jobs to complete', async () => {
      let handlerCalled = false;
      const handler = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        handlerCalled = true;
      });

      worker.registerHandler('test', handler);
      worker.start();

      worker.enqueue('test', { data: 1 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await worker.stop(500);

      expect(handlerCalled).toBe(true);
      expect(worker.processingCount).toBe(0);
    });

    it('should timeout waiting for slow jobs', async () => {
      const handler = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      });

      worker.registerHandler('test', handler);
      worker.start();

      worker.enqueue('test', { data: 1 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await worker.stop(100);

      expect(worker.processingCount).toBeGreaterThan(0);
    });

    it('should work when not running', async () => {
      expect(async () => {
        await worker.stop();
      }).not.toThrow();
    });
  });

  describe('enqueue', () => {
    it('should enqueue a job', () => {
      const handler = jest.fn();
      worker.registerHandler('test', handler);
      const jobId = worker.enqueue('test', { data: 'test' });

      expect(jobId).toMatch(/^job-[0-9a-f]+$/);
      expect(queue.getJob(jobId)).toBeDefined();
    });

    it('should throw if no handler for job type', () => {
      expect(() => {
        worker.enqueue('unknown', { data: 'test' });
      }).toThrow('No handler registered');
    });

    it('should support options', () => {
      const handler = jest.fn();
      worker.registerHandler('test', handler);
      const jobId = worker.enqueue('test', { data: 'test' }, { priority: 5 });

      const job = queue.getJob(jobId);
      expect(job.priority).toBe(5);
    });
  });

  describe('job processing', () => {
    it('should process jobs with registered handler', async () => {
      const handler = jest.fn();
      worker.registerHandler('test', handler);
      worker.start();

      const jobId = worker.enqueue('test', { data: 'processing' });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        id: jobId,
        type: 'test',
        payload: { data: 'processing' },
      }));

      const job = queue.getJob(jobId);
      expect(job.status).toBe(JOB_STATUS.COMPLETED);
    });

    it('should call handler with job object', async () => {
      const handler = jest.fn();
      worker.registerHandler('test', handler);
      worker.start();

      const jobId = worker.enqueue('test', { data: 'test' });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      const callArgs = handler.mock.calls[0][0];
      expect(callArgs.id).toBe(jobId);
      expect(callArgs.type).toBe('test');
      expect(callArgs.payload).toEqual({ data: 'test' });
    });

    it('should handle handler errors with retry', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler failed'));
      worker.registerHandler('test', handler);
      worker.start();

      const jobId = worker.enqueue('test', { data: 'test' });

      await new Promise((resolve) => setTimeout(resolve, 300));
      await worker.stop();

      const job = queue.getJob(jobId);
      expect(job.status).toBe(JOB_STATUS.RETRYING);
      expect(job.attempts).toBe(1);
      expect(job.lastError).toBe('Handler failed');
    });

    it('should process multiple jobs concurrently', async () => {
      const handler = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      worker = new BackgroundWorker({
        jobQueue: queue,
        pollIntervalMs: 50,
        maxConcurrency: 3,
      });

      worker.registerHandler('test', handler);
      worker.start();

      worker.enqueue('test', { data: 1 });
      worker.enqueue('test', { data: 2 });
      worker.enqueue('test', { data: 3 });

      await new Promise((resolve) => setTimeout(resolve, 150));

      await worker.stop();

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should handle job with null error', async () => {
      const handler = jest.fn().mockRejectedValue(null);
      worker.registerHandler('test', handler);
      worker.start();

      const jobId = worker.enqueue('test', { data: 'test' });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker.stop();

      const job = queue.getJob(jobId);
      expect(job.status).toBe(JOB_STATUS.RETRYING);
    });
  });

  describe('getStats', () => {
    it('should return current worker stats', async () => {
      const handler = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      worker.registerHandler('test', handler);
      worker.registerHandler('email', handler);
      worker.start();

      worker.enqueue('test', { data: 1 });
      worker.enqueue('email', { email: 'test@example.com' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = worker.getStats();
      expect(stats.isRunning).toBe(true);
      expect(stats.processingCount).toBeGreaterThanOrEqual(1);
      expect(stats.handlerCount).toBe(2);
      expect(stats.queueStats).toBeDefined();

      await worker.stop();
    });
  });
});
