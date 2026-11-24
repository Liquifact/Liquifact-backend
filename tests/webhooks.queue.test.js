'use strict';

/**
 * Tests for bounded webhook delivery queue.
 *
 * Verifies:
 *  - Global concurrency limit is strictly enforced
 *  - Worker slots are freed immediately during retry sleep
 *  - Queue overflow drops oldest pending item with status "dropped"
 *  - drain() resolves when idle and respects timeout
 *  - Per-webhook ordering serializes deliveries for the same webhook
 */

const { DeliveryQueue } = require('../src/webhooks/queue');

describe('Webhook Delivery Queue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('concurrency is never exceeded', async () => {
    const queue = new DeliveryQueue({ concurrency: 3, maxQueueSize: 20 });
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 10 }, (_, i) => {
      return queue.enqueue({
        task: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // simulate async work
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return { success: true };
        },
      });
    });

    // Advance fake timers so all tasks complete
    while (queue.running > 0 || queue.queue.length > 0) {
      jest.advanceTimersByTime(50);
      await Promise.resolve();
    }

    await Promise.all(tasks);

    expect(maxInFlight).toBe(3);
    expect(queue.running).toBe(0);
    expect(queue.getStats().queued).toBe(0);
  });

  test('retry waits do not occupy workers', async () => {
    const queue = new DeliveryQueue({ concurrency: 1, maxQueueSize: 10 });
    let job1Attempts = 0;
    let job2Executed = false;

    // Job 1 fails first attempt, requests retry after 5000ms delay
    const p1 = queue.enqueue({
      task: async () => {
        job1Attempts++;
        if (job1Attempts === 1) {
          return { success: false, retryable: true, delayMs: 5000 };
        }
        return { success: true };
      },
    });

    // Run first attempt
    await Promise.resolve();

    expect(job1Attempts).toBe(1);
    // Worker slot is freed immediately!
    expect(queue.running).toBe(0);
    expect(queue.getStats().activeTimers).toBe(1);

    // Job 2 is enqueued and should run IMMEDIATELY because worker slot is free
    const p2 = queue.enqueue({
      task: async () => {
        job2Executed = true;
        return { success: true };
      },
    });

    await Promise.resolve();
    expect(job2Executed).toBe(true);

    // Now advance past the 5000ms retry timer for job 1
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    expect(job1Attempts).toBe(2);
    await Promise.all([p1, p2]);
  });

  test('queue overflow drops oldest item and marks status: "dropped"', async () => {
    const queue = new DeliveryQueue({ concurrency: 1, maxQueueSize: 2 });

    // Block the 1 running slot
    let releaseBlock;
    const blockingPromise = queue.enqueue({
      task: () => new Promise((resolve) => { releaseBlock = resolve; }),
    });

    const recordA = { id: 'rec-A', status: 'pending' };
    const recordB = { id: 'rec-B', status: 'pending' };
    const recordC = { id: 'rec-C', status: 'pending' };

    // Queue slots: maxQueueSize is 2
    // Enqueue A (queue length = 1)
    const pA = queue.enqueue({ deliveryRecord: recordA, task: async () => ({ success: true }) });
    // Enqueue B (queue length = 2)
    const pB = queue.enqueue({ deliveryRecord: recordB, task: async () => ({ success: true }) });

    expect(recordA.status).toBe('pending');
    expect(recordB.status).toBe('pending');

    // Enqueue C -> exceeds maxQueueSize 2 -> drops oldest (A)
    const pC = queue.enqueue({ deliveryRecord: recordC, task: async () => ({ success: true }) });

    expect(recordA.status).toBe('dropped');
    expect(queue.getStats().dropped).toBe(1);
    expect(recordB.status).toBe('pending');
    expect(recordC.status).toBe('pending');

    // Unblock worker
    releaseBlock({ success: true });
    await blockingPromise;

    // Remaining items execute
    await Promise.all([pA, pB, pC]);
    expect(recordB.status).toBe('pending'); // completed task didn't overwrite record
  });

  test('drain() resolves when all jobs and retry timers are complete', async () => {
    const queue = new DeliveryQueue({ concurrency: 2, maxQueueSize: 10 });
    let attempts = 0;

    queue.enqueue({
      task: async () => {
        attempts++;
        if (attempts === 1) {
          return { success: false, retryable: true, delayMs: 1000 };
        }
        return { success: true };
      },
    });

    await Promise.resolve();

    let drained = false;
    queue.drain().then(() => {
      drained = true;
    });

    expect(drained).toBe(false);

    // Advance past retry timer and flush async microtasks
    jest.advanceTimersByTime(1000);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(drained).toBe(true);
    expect(attempts).toBe(2);
  });

  test('drain(timeoutMs) respects timeout if work does not finish in time', async () => {
    const queue = new DeliveryQueue({ concurrency: 1, maxQueueSize: 10 });

    // Job stays blocked indefinitely
    queue.enqueue({
      task: () => new Promise(() => {}),
    });

    await Promise.resolve();

    let drainResult = null;
    queue.drain(500).then((res) => {
      drainResult = res;
    });

    expect(drainResult).toBeNull();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(drainResult).toBe(false);
  });

  test('perWebhookOrdering serializes deliveries for the same webhook', async () => {
    const queue = new DeliveryQueue({ concurrency: 5, perWebhookOrdering: true });
    const order = [];

    let finishWh1Job1;

    // wh-1 job 1: held until finishWh1Job1 called
    const p1 = queue.enqueue({
      webhookId: 'wh-1',
      task: async () => {
        order.push('wh-1:job-1:start');
        await new Promise((r) => { finishWh1Job1 = r; });
        order.push('wh-1:job-1:end');
        return { success: true };
      },
    });

    // wh-1 job 2: should wait even though concurrency=5
    const p2 = queue.enqueue({
      webhookId: 'wh-1',
      task: async () => {
        order.push('wh-1:job-2:start');
        order.push('wh-1:job-2:end');
        return { success: true };
      },
    });

    // wh-2 job 1: should run immediately because different webhookId
    const p3 = queue.enqueue({
      webhookId: 'wh-2',
      task: async () => {
        order.push('wh-2:job-1:start');
        order.push('wh-2:job-1:end');
        return { success: true };
      },
    });

    await Promise.resolve();

    expect(order).toContain('wh-1:job-1:start');
    expect(order).toContain('wh-2:job-1:start');
    expect(order).toContain('wh-2:job-1:end');
    expect(order).not.toContain('wh-1:job-2:start');

    // Now release wh-1 job 1
    finishWh1Job1();
    await Promise.resolve();

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([
      'wh-1:job-1:start',
      'wh-2:job-1:start',
      'wh-2:job-1:end',
      'wh-1:job-1:end',
      'wh-1:job-2:start',
      'wh-1:job-2:end',
    ]);
  });
});
