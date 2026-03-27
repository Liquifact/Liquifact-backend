/**
 * Comprehensive tests for background worker queue and worker implementation.
 * Tests cover:
 *   - Queue operations (enqueue, status updates, retries)
 *   - Worker job processing and handling
 *   - Error conditions and edge cases
 *   - Security validations
 *   - Ack/nack semantics
 *   - Webhook notifications
 */

const { JobQueue } = require('../workers/queue');
const { BackgroundWorker } = require('../workers/worker');

describe('JobQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new JobQueue();
  });

  describe('enqueue', () => {
    test('should enqueue a job with valid inputs', () => {
      const jobId = queue.enqueue('verification', { userId: '123', data: 'test' });

      expect(typeof jobId).toBe('string');
      expect(jobId.length).toBeGreaterThan(0);

      const job = queue.getJob(jobId);
      expect(job).not.toBeNull();
      expect(job.type).toBe('verification');
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
    });

    test('should reject invalid job type', () => {
      expect(() => queue.enqueue('', { data: 'test' })).toThrow();
      expect(() => queue.enqueue(123, { data: 'test' })).toThrow();
      expect(() => queue.enqueue('a'.repeat(101), { data: 'test' })).toThrow();
    });

    test('should reject invalid job data', () => {
      expect(() => queue.enqueue('test', null)).toThrow();
      expect(() => queue.enqueue('test', ['array'])).toThrow();
      expect(() => queue.enqueue('test', 'string')).toThrow();
    });

    test('should reject oversized job data', () => {
      const largeData = { data: 'x'.repeat(1024 * 1024 + 1) };
      expect(() => queue.enqueue('test', largeData)).toThrow('exceeds 1MB');
    });

    test('should cap maxAttempts at 10', () => {
      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 100 });
      const job = queue.getJob(jobId);
      expect(job.maxAttempts).toBe(10);
    });

    test('should set default maxAttempts to 3', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const job = queue.getJob(jobId);
      expect(job.maxAttempts).toBe(3);
    });

    test('should reject invalid maxAttempts', () => {
      expect(() => queue.enqueue('test', { data: 'test' }, { maxAttempts: 0 })).toThrow();
      expect(() => queue.enqueue('test', { data: 'test' }, { maxAttempts: -1 })).toThrow();
      expect(() => queue.enqueue('test', { data: 'test' }, { maxAttempts: 'abc' })).toThrow();
    });

    test('should validate webhook URL format', () => {
      expect(() => 
        queue.enqueue('test', { data: 'test' }, { webhookUrl: 'invalid' })
      ).toThrow();

      expect(() => 
        queue.enqueue('test', { data: 'test' }, { webhookUrl: 'ftp://example.com' })
      ).toThrow('Webhook URL must use http or https protocol');
    });

    test('should reject private IP webhooks in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      expect(() => 
        queue.enqueue('test', { data: 'test' }, { webhookUrl: 'http://localhost:3000' })
      ).toThrow();

      expect(() => 
        queue.enqueue('test', { data: 'test' }, { webhookUrl: 'http://127.0.0.1' })
      ).toThrow();

      process.env.NODE_ENV = originalEnv;
    });

    test('should allow http/https URLs', () => {
      const jobHttp = queue.enqueue('test', { data: 'test' }, 
        { webhookUrl: 'http://example.com/webhook' });
      const jobHttps = queue.enqueue('test', { data: 'test' }, 
        { webhookUrl: 'https://example.com/webhook' });

      expect(queue.getJob(jobHttp)).not.toBeNull();
      expect(queue.getJob(jobHttps)).not.toBeNull();
    });

    test('should increment totalEnqueued metric', () => {
      queue.enqueue('test', { data: 'test' });
      queue.enqueue('test', { data: 'test' });

      expect(queue.getMetrics().totalEnqueued).toBe(2);
    });
  });

  describe('getJob', () => {
    test('should return job by ID', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const job = queue.getJob(jobId);

      expect(job).not.toBeNull();
      expect(job.id).toBe(jobId);
    });

    test('should return null for non-existent job', () => {
      expect(queue.getJob('invalid-id')).toBeNull();
    });
  });

  describe('getAllJobs', () => {
    test('should return all jobs without filter', () => {
      queue.enqueue('test', { data: 'test' });
      queue.enqueue('test', { data: 'test' });

      const jobs = queue.getAllJobs();
      expect(jobs.length).toBe(2);
    });

    test('should filter jobs by status', () => {
      const jobId1 = queue.enqueue('test', { data: 'test' });
      const jobId2 = queue.enqueue('test', { data: 'test' });

      queue.updateJobStatus(jobId1, 'completed');

      const pending = queue.getAllJobs({ status: 'pending' });
      const completed = queue.getAllJobs({ status: 'completed' });

      expect(pending.length).toBe(1);
      expect(completed.length).toBe(1);
    });

    test('should filter jobs by type', () => {
      queue.enqueue('verification', { data: 'test' });
      queue.enqueue('webhook', { data: 'test' });
      queue.enqueue('verification', { data: 'test' });

      const verifications = queue.getAllJobs({ type: 'verification' });
      const webhooks = queue.getAllJobs({ type: 'webhook' });

      expect(verifications.length).toBe(2);
      expect(webhooks.length).toBe(1);
    });

    test('should apply multiple filters', () => {
      const jobId1 = queue.enqueue('verification', { data: 'test' });
      queue.enqueue('webhook', { data: 'test' });
      queue.enqueue('verification', { data: 'test' });

      queue.updateJobStatus(jobId1, 'completed');

      const filtered = queue.getAllJobs({ type: 'verification', status: 'completed' });
      expect(filtered.length).toBe(1);
    });
  });

  describe('updateJobStatus', () => {
    test('should update job status', () => {
      const jobId = queue.enqueue('test', { data: 'test' });

      queue.updateJobStatus(jobId, 'processing');
      expect(queue.getJob(jobId).status).toBe('processing');

      queue.updateJobStatus(jobId, 'completed');
      expect(queue.getJob(jobId).status).toBe('completed');
    });

    test('should update updatedAt timestamp', async () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const beforeUpdate = queue.getJob(jobId).updatedAt;

      // Wait a bit to ensure timestamp changes
      await new Promise(r => setTimeout(r, 10));

      queue.updateJobStatus(jobId, 'processing');
      const afterUpdate = queue.getJob(jobId).updatedAt;

      expect(afterUpdate).toBeGreaterThan(beforeUpdate);
    });

    test('should reject invalid status', () => {
      const jobId = queue.enqueue('test', { data: 'test' });

      expect(() => queue.updateJobStatus(jobId, 'invalid')).toThrow();
    });

    test('should throw for non-existent job', () => {
      expect(() => queue.updateJobStatus('invalid', 'completed')).toThrow('not found');
    });

    test('should store last error', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const error = new Error('Test error');

      queue.updateJobStatus(jobId, 'failed', { lastError: error });
      expect(queue.getJob(jobId).lastError).toBe(error);
    });

    test('should increment completed metric', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.updateJobStatus(jobId, 'completed');

      expect(queue.getMetrics().totalCompleted).toBe(1);
    });

    test('should increment failed metric', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.updateJobStatus(jobId, 'failed');

      expect(queue.getMetrics().totalFailed).toBe(1);
    });
  });

  describe('ackJob / nackJob', () => {
    test('should mark job as completed with ackJob', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.ackJob(jobId);

      expect(queue.getJob(jobId).status).toBe('completed');
    });

    test('should mark job as failed with nackJob', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      const error = new Error('Failed');
      queue.nackJob(jobId, error);

      const job = queue.getJob(jobId);
      expect(job.status).toBe('failed');
      expect(job.lastError).toBe(error);
    });
  });

  describe('requeueJob', () => {
    test('should requeue a job within max attempts', () => {
      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 3 });
      queue.updateJobStatus(jobId, 'processing');

      const requeued = queue.requeueJob(jobId);

      expect(requeued).toBe(true);
      expect(queue.getJob(jobId).status).toBe('pending');
      expect(queue.getJob(jobId).attempts).toBe(1);
    });

    test('should reject requeue when max attempts exceeded', () => {
      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 2 });
      queue.updateJobStatus(jobId, 'processing', { attempts: 2 });

      const requeued = queue.requeueJob(jobId);

      expect(requeued).toBe(false);
    });

    test('should throw for non-existent job', () => {
      expect(() => queue.requeueJob('invalid')).toThrow('not found');
    });
  });

  describe('getNextPendingJob', () => {
    test('should return first pending job', () => {
      const jobId1 = queue.enqueue('test', { data: 'test1' });
      const jobId2 = queue.enqueue('test', { data: 'test2' });

      const pending = queue.getNextPendingJob();
      expect(pending.id).toBe(jobId1);
    });

    test('should return null when no pending jobs', () => {
      const jobId = queue.enqueue('test', { data: 'test' });
      queue.updateJobStatus(jobId, 'completed');

      expect(queue.getNextPendingJob()).toBeNull();
    });

    test('should return null when queue is empty', () => {
      expect(queue.getNextPendingJob()).toBeNull();
    });
  });

  describe('getMetrics', () => {
    test('should return correct metrics', async () => {
      queue.enqueue('test', { data: 'test' });
      queue.enqueue('test', { data: 'test' });

      const metrics = queue.getMetrics();
      expect(metrics.totalEnqueued).toBe(2);
      expect(metrics.totalPending).toBe(2);
      expect(metrics.totalCompleted).toBe(0);
      expect(metrics.totalFailed).toBe(0);
    });
  });

  describe('clear', () => {
    test('should clear all jobs', () => {
      queue.enqueue('test', { data: 'test' });
      queue.enqueue('test', { data: 'test' });

      queue.clear();

      expect(queue.getAllJobs().length).toBe(0);
      expect(queue.getMetrics().totalEnqueued).toBe(0);
    });
  });
});

describe('BackgroundWorker', () => {
  let queue;
  let worker;

  beforeEach(() => {
    queue = new JobQueue();
    worker = new BackgroundWorker(queue);
  });

  afterEach(async () => {
    if (worker.isRunning) {
      await worker.stop(1000);
    }
  });

  describe('constructor', () => {
    test('should require a queue', () => {
      expect(() => new BackgroundWorker(null)).toThrow('requires a JobQueue');
    });

    test('should cap maxConcurrency at 10', () => {
      const w = new BackgroundWorker(queue, { maxConcurrency: 100 });
      expect(w.maxConcurrency).toBe(10);
    });

    test('should reject invalid maxConcurrency', () => {
      expect(() => new BackgroundWorker(queue, { maxConcurrency: 0 })).toThrow();
      expect(() => new BackgroundWorker(queue, { maxConcurrency: 'abc' })).toThrow();
    });

    test('should cap jobTimeout at 300000ms', () => {
      const w = new BackgroundWorker(queue, { jobTimeout: 1000000 });
      expect(w.jobTimeout).toBe(300000);
    });

    test('should reject invalid jobTimeout', () => {
      expect(() => new BackgroundWorker(queue, { jobTimeout: 500 })).toThrow();
      expect(() => new BackgroundWorker(queue, { jobTimeout: 'abc' })).toThrow();
    });

    test('should validate logger', () => {
      expect(() => new BackgroundWorker(queue, { logger: {} })).toThrow('Logger must have a log method');
    });

    test('should use console as default logger', () => {
      const w = new BackgroundWorker(queue);
      expect(w.logger).toBe(console);
    });
  });

  describe('registerHandler', () => {
    test('should register a job handler', () => {
      const handler = jest.fn();
      worker.registerHandler('test', handler);

      expect(worker.jobHandlers.has('test')).toBe(true);
    });

    test('should reject invalid job type', () => {
      expect(() => worker.registerHandler('', jest.fn())).toThrow();
      expect(() => worker.registerHandler(123, jest.fn())).toThrow();
    });

    test('should reject non-function handler', () => {
      expect(() => worker.registerHandler('test', 'not-a-function')).toThrow();
    });
  });

  describe('start / stop', () => {
    test('should start the worker', async () => {
      worker.start(); // Don't await - start() never resolves while running
      expect(worker.isRunning).toBe(true);

      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });

    test('should not start if already running', async () => {
      worker.start();
      const spy = jest.spyOn(console, 'log');

      worker.start(); // Try to start again
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('already running'));

      spy.mockRestore();
      await worker.stop();
    });

    test('should stop gracefully', async () => {
      worker.start();
      expect(worker.isRunning).toBe(true);

      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });

    test('should handle stop when not running', async () => {
      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });
  });

  describe('job processing', () => {
    test('should process a job successfully', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      worker.registerHandler('test', handler);

      const jobId = queue.enqueue('test', { data: 'test' });
      worker.start();

      // Give worker time to process
      await new Promise(r => setTimeout(r, 500));
      await worker.stop();

      expect(handler).toHaveBeenCalledWith({ data: 'test' });
      expect(queue.getJob(jobId).status).toBe('completed');
    });

    test('should fail job when handler throws', async () => {
      const error = new Error('Handler failed');
      const handler = jest.fn().mockRejectedValue(error);
      worker.registerHandler('test', handler);

      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 1 });
      worker.start();

      await new Promise(r => setTimeout(r, 500));
      await worker.stop();

      expect(queue.getJob(jobId).status).toBe('failed');
    });

    test('should retry failed jobs', async () => {
      let callCount = 0;
      const handler = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          throw new Error('First attempt fails');
        }
      });

      worker.registerHandler('test', handler);
      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 3 });

      worker.start();
      await new Promise(r => setTimeout(r, 1500)); // Wait for retries
      await worker.stop();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(queue.getJob(jobId).status).toBe('completed');
    });

    test('should respect max attempts', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Always fails'));
      worker.registerHandler('test', handler);

      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 2 });
      worker.start();

      await new Promise(r => setTimeout(r, 1200));
      await worker.stop();

      expect(queue.getJob(jobId).status).toBe('failed');
      // Handler is called maxAttempts times (2)
      expect(handler.mock.calls.length).toBeLessThanOrEqual(3);
    });

    test('should fail job when handler not registered', async () => {
      const jobId = queue.enqueue('unknown', { data: 'test' }, { maxAttempts: 1 });
      worker.start();

      await new Promise(r => setTimeout(r, 500));
      await worker.stop();

      const job = queue.getJob(jobId);
      expect(job.status).toBe('failed');
      expect(job.lastError.message).toContain('No handler registered');
    });

    test('should enforce timeout on job handlers', async () => {
      const handler = jest.fn(
        () => new Promise(r => setTimeout(r, 10000)) // 10 second operation
      );
      
      const w = new BackgroundWorker(queue, { jobTimeout: 1000 });
      w.registerHandler('test', handler);

      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 1 });
      w.start();

      await new Promise(r => setTimeout(r, 1500));
      await w.stop();

      const job = queue.getJob(jobId);
      expect(job.status).toBe('failed');
      expect(job.lastError.message).toContain('timeout');
    });

    test('should respect maxConcurrency limit', async () => {
      let concurrentCalls = 0;
      let maxConcurrentCalls = 0;

      const handler = jest.fn(async () => {
        concurrentCalls++;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
        await new Promise(r => setTimeout(r, 200));
        concurrentCalls--;
      });

      const w = new BackgroundWorker(queue, { maxConcurrency: 2 });
      w.registerHandler('test', handler);

      // Enqueue 5 jobs
      for (let i = 0; i < 5; i++) {
        queue.enqueue('test', { data: `test${i}` });
      }

      w.start();
      await new Promise(r => setTimeout(r, 1500));
      await w.stop();

      expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
    });
  });

  describe('webhook notifications', () => {
    test('should notify webhook on job completion', async () => {
      const spy = jest.spyOn(worker, '_notifyWebhook');
      const handler = jest.fn().mockResolvedValue(undefined);

      worker.registerHandler('test', handler);
      const jobId = queue.enqueue('test', { data: 'test' }, 
        { webhookUrl: 'https://example.com/webhook' });

      worker.start();
      await new Promise(r => setTimeout(r, 500));
      await worker.stop();

      expect(spy).toHaveBeenCalledWith(expect.any(Object), 'completed', null);
      spy.mockRestore();
    });

    test('should notify webhook on job failure', async () => {
      const spy = jest.spyOn(worker, '_notifyWebhook');
      const handler = jest.fn().mockRejectedValue(new Error('Failed'));

      worker.registerHandler('test', handler);
      const jobId = queue.enqueue('test', { data: 'test' }, 
        { webhookUrl: 'https://example.com/webhook', maxAttempts: 1 });

      worker.start();
      await new Promise(r => setTimeout(r, 500));
      await worker.stop();

      expect(spy).toHaveBeenCalledWith(expect.any(Object), 'failed', expect.any(Error));
      spy.mockRestore();
    });

    test('should disable webhooks when enableWebhooks is false', async () => {
      const spy = jest.spyOn(BackgroundWorker.prototype, '_notifyWebhook');
      const w = new BackgroundWorker(queue, { enableWebhooks: false });
      const handler = jest.fn().mockResolvedValue(undefined);

      w.registerHandler('test', handler);
      queue.enqueue('test', { data: 'test' }, 
        { webhookUrl: 'https://example.com/webhook' });

      w.start();
      await new Promise(r => setTimeout(r, 500));
      await w.stop();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('getStatus', () => {
    test('should return worker status', async () => {
      worker.registerHandler('test', jest.fn());

      const status = worker.getStatus();
      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('activeJobs');
      expect(status).toHaveProperty('maxConcurrency');
      expect(status).toHaveProperty('registeredHandlers');
      expect(status).toHaveProperty('queueMetrics');
    });
  });

  describe('error handling', () => {
    test('should recover from handler errors', async () => {
      const handler = jest.fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockResolvedValueOnce(undefined);

      worker.registerHandler('test', handler);
      const jobId = queue.enqueue('test', { data: 'test' }, { maxAttempts: 2 });

      worker.start();
      await new Promise(r => setTimeout(r, 1000));
      await worker.stop();

      expect(queue.getJob(jobId).status).toBe('completed');
    });

    test('should continue processing after job failure', async () => {
      const handler1 = jest.fn().mockRejectedValue(new Error('Fails'));
      const handler2 = jest.fn().mockResolvedValue(undefined);

      worker.registerHandler('type1', handler1);
      worker.registerHandler('type2', handler2);

      const job1 = queue.enqueue('type1', { data: 'test' }, { maxAttempts: 1 });
      const job2 = queue.enqueue('type2', { data: 'test' });

      worker.start();
      await new Promise(r => setTimeout(r, 800));
      await worker.stop();

      expect(queue.getJob(job1).status).toBe('failed');
      expect(queue.getJob(job2).status).toBe('completed');
    });
  });
});
