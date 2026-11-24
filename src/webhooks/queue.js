'use strict';

/**
 * Bounded Webhook Delivery Queue
 *
 * Enforces:
 *  - Global concurrency limit (WEBHOOK_CONCURRENCY, default: 8)
 *  - Optional per-webhook FIFO ordering
 *  - Bounded queue capacity (WEBHOOK_QUEUE_MAX, default: 1000) with oldest-drop policy
 *  - Dropped deliveries marked status: "dropped"
 *  - Retry scheduling without holding worker slots during backoff sleep
 *  - Graceful drain(timeoutMs) for shutdown and test isolation
 */

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_QUEUE_MAX = 1000;

class DeliveryQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency] Global concurrency limit.
   * @param {number} [options.maxQueueSize] Max queued jobs before dropping oldest.
   * @param {boolean} [options.perWebhookOrdering] If true, serialize jobs per webhookId.
   */
  constructor(options = {}) {
    const envConcurrency = process.env.WEBHOOK_CONCURRENCY
      ? parseInt(process.env.WEBHOOK_CONCURRENCY, 10)
      : undefined;
    const envMaxQueue = process.env.WEBHOOK_QUEUE_MAX
      ? parseInt(process.env.WEBHOOK_QUEUE_MAX, 10)
      : undefined;

    this.concurrency = options.concurrency || envConcurrency || DEFAULT_CONCURRENCY;
    this.maxQueueSize = options.maxQueueSize || envMaxQueue || DEFAULT_QUEUE_MAX;
    this.perWebhookOrdering = options.perWebhookOrdering ?? false;

    this.queue = [];
    this.running = 0;
    this.activeWebhookIds = new Set();
    this.droppedCount = 0;
    this.activeTimers = new Set();
    this.drainWaiters = [];
  }

  /**
   * Enqueues a delivery task.
   *
   * @param {object} job
   * @param {string} [job.webhookId]
   * @param {object} [job.deliveryRecord]
   * @param {Function} job.task Async function executing an attempt.
   * @returns {Promise<any>}
   */
  enqueue(job) {
    return new Promise((resolve, reject) => {
      const entry = {
        ...job,
        resolve,
        reject,
      };

      if (this.queue.length >= this.maxQueueSize) {
        const dropped = this.queue.shift();
        this.droppedCount++;
        if (dropped.deliveryRecord) {
          dropped.deliveryRecord.status = 'dropped';
        }
        if (typeof dropped.resolve === 'function') {
          dropped.resolve({ status: 'dropped', dropped: true });
        }
      }

      this.queue.push(entry);
      this.pump();
    });
  }

  /**
   * Re-enqueues a job scheduled after backoff delay.
   *
   * @param {object} job
   */
  enqueueRetry(job) {
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      this.droppedCount++;
      if (dropped.deliveryRecord) {
        dropped.deliveryRecord.status = 'dropped';
      }
      if (typeof dropped.resolve === 'function') {
        dropped.resolve({ status: 'dropped', dropped: true });
      }
    }
    this.queue.push(job);
    this.pump();
  }

  /**
   * Pumps jobs from queue into available concurrency slots.
   */
  pump() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      let jobIndex = 0;
      if (this.perWebhookOrdering) {
        jobIndex = this.queue.findIndex(
          (j) => !j.webhookId || !this.activeWebhookIds.has(j.webhookId),
        );
        if (jobIndex === -1) {
          // All pending items have an in-flight job for their webhook
          break;
        }
      }

      const [job] = this.queue.splice(jobIndex, 1);
      this.running++;
      if (this.perWebhookOrdering && job.webhookId) {
        this.activeWebhookIds.add(job.webhookId);
      }

      this.executeJob(job);
    }
  }

  /**
   * Executes a single attempt of a job.
   *
   * @param {object} job
   */
  async executeJob(job) {
    try {
      const result = await job.task();

      if (result && result.retryable && typeof result.delayMs === 'number') {
        // Free worker slot immediately so retry sleep does NOT hold concurrency!
        this.finishWorker(job);

        // Schedule timer outside the worker slot
        const timer = setTimeout(() => {
          this.activeTimers.delete(timer);
          this.enqueueRetry(job);
        }, result.delayMs);

        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        this.activeTimers.add(timer);
        return;
      }

      // Successful or final attempt
      this.finishWorker(job);
      job.resolve(result);
    } catch (err) {
      this.finishWorker(job);
      job.reject(err);
    }
  }

  /**
   * Releases worker slot and notifies drain waiters if queue is idle.
   *
   * @param {object} job
   */
  finishWorker(job) {
    this.running--;
    if (this.perWebhookOrdering && job.webhookId) {
      this.activeWebhookIds.delete(job.webhookId);
    }
    this.pump();
    this.checkDrain();
  }

  /**
   * Checks if all running, queued, and delayed jobs are finished.
   */
  checkDrain() {
    if (this.running === 0 && this.queue.length === 0 && this.activeTimers.size === 0) {
      while (this.drainWaiters.length > 0) {
        const waiter = this.drainWaiters.shift();
        waiter.resolve(true);
      }
    }
  }

  /**
   * Waits for all in-flight jobs and retry timers to finish.
   *
   * @param {number} [timeoutMs] Maximum time to wait.
   * @returns {Promise<boolean>} Resolves true when idle, false if timeout reached.
   */
  drain(timeoutMs) {
    if (this.running === 0 && this.queue.length === 0 && this.activeTimers.size === 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let timeoutTimer;
      const waiter = {
        resolve: (val) => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          resolve(val);
        },
      };

      if (timeoutMs && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          const idx = this.drainWaiters.indexOf(waiter);
          if (idx !== -1) {
            this.drainWaiters.splice(idx, 1);
          }
          resolve(false);
        }, timeoutMs);
        if (typeof timeoutTimer.unref === 'function') {
          timeoutTimer.unref();
        }
      }

      this.drainWaiters.push(waiter);
    });
  }

  /**
   * Returns live queue telemetry.
   *
   * @returns {{ concurrency: number, running: number, queued: number, dropped: number, activeTimers: number }}
   */
  getStats() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      queued: this.queue.length,
      dropped: this.droppedCount,
      activeTimers: this.activeTimers.size,
    };
  }

  /**
   * Resets queue state (used in tests).
   */
  reset() {
    this.queue = [];
    this.running = 0;
    this.activeWebhookIds.clear();
    this.droppedCount = 0;
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    while (this.drainWaiters.length > 0) {
      const waiter = this.drainWaiters.shift();
      waiter.resolve(true);
    }
  }
}

const defaultQueue = new DeliveryQueue();

module.exports = {
  DeliveryQueue,
  defaultQueue,
  enqueue: (job) => defaultQueue.enqueue(job),
  drain: (timeoutMs) => defaultQueue.drain(timeoutMs),
  getStats: () => defaultQueue.getStats(),
  reset: () => defaultQueue.reset(),
};
