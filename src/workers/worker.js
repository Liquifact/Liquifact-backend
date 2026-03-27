/**
 * Background Worker for processing asynchronous jobs.
 * Implements a main processing loop with retry, ack/nack semantics, and webhook notifications.
 * 
 * @module workers/worker
 * @security
 *   - Worker enforces concurrency limits to prevent resource exhaustion
 *   - Job handlers have configurable timeouts to prevent infinite hangs
 *   - Webhook calls are retried with exponential backoff
 *   - Errors are caught and logged to prevent cascade failures
 */

const { withRetry } = require('../utils/retry');

/**
 * Represents a job handler.
 * @callback JobHandler
 * @param {Object} jobData - The job payload
 * @returns {Promise<void>} Handler must resolve on success or reject with error
 */

/**
 * BackgroundWorker class processes jobs from a queue asynchronously.
 * Implements job handling, retry logic, and optional webhook notifications.
 */
class BackgroundWorker {
  /**
   * Creates a new BackgroundWorker instance.
   * 
   * @param {JobQueue} queue - The job queue to process jobs from
   * @param {Object} [options={}] - Worker configuration
   * @param {number} [options.maxConcurrency=2] - Maximum concurrent jobs (capped at 10)
   * @param {number} [options.jobTimeout=30000] - Max time per job in milliseconds (max: 300000)
   * @param {number} [options.pollInterval=1000] - Queue polling interval in milliseconds
   * @param {boolean} [options.enableWebhooks=true] - Enable webhook notifications
   * @param {Function} [options.logger] - Custom logger function (defaults to console)
   * @throws {Error} If queue is not provided
   * @security
   *   - maxConcurrency is capped at 10 to prevent resource exhaustion
   *   - jobTimeout is capped at 5 minutes to prevent infinite hangs
   *   - Logger is validated to be a function
   */
  constructor(queue, options = {}) {
    if (!queue) {
      throw new Error('BackgroundWorker requires a JobQueue instance');
    }

    this.queue = queue;

    // Security: Cap concurrency
    let maxConcurrency = options.maxConcurrency ?? 2;
    if (typeof maxConcurrency !== 'number' || maxConcurrency < 1) {
      throw new Error('maxConcurrency must be a positive number');
    }
    this.maxConcurrency = Math.max(1, Math.min(maxConcurrency, 10));

    // Security: Cap job timeout
    let jobTimeout = options.jobTimeout ?? 30000;
    if (typeof jobTimeout !== 'number' || jobTimeout < 1000) {
      throw new Error('jobTimeout must be at least 1000ms');
    }
    this.jobTimeout = Math.max(1000, Math.min(jobTimeout, 300000)); // Max 5 minutes

    this.pollInterval = options.pollInterval ?? 1000;
    this.enableWebhooks = options.enableWebhooks !== false;
    this.logger = options.logger || console;

    // Validate logger
    if (typeof this.logger.log !== 'function') {
      throw new Error('Logger must have a log method');
    }

    // Internal state
    this.isRunning = false;
    this.activeJobs = new Map();
    this.jobHandlers = new Map();
    this.pollTimeout = null;
  }

  /**
   * Registers a handler for a specific job type.
   * 
   * @param {string} jobType - The job type identifier
   * @param {JobHandler} handler - Async function to handle jobs of this type
   * @throws {Error} If jobType is invalid or handler is not a function
   */
  registerHandler(jobType, handler) {
    if (typeof jobType !== 'string' || jobType.length === 0) {
      throw new Error('Job type must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    this.jobHandlers.set(jobType, handler);
    this.logger.log(`[Worker] Registered handler for job type: ${jobType}`);
  }

  /**
   * Starts the worker loop, polling the queue for jobs.
   * 
   * @returns {Promise<void>} Resolves when the worker starts (doesn't resolve until stopped)
   */
  async start() {
    if (this.isRunning) {
      this.logger.log('[Worker] Worker is already running');
      return;
    }

    this.isRunning = true;
    this.logger.log('[Worker] Starting background worker');

    this._poll();

    return new Promise(() => {
      // This never resolves while running; callers should await start() and handle stop separately
    });
  }

  /**
   * Stops the worker loop gracefully.
   * Waits for active jobs to complete before returning.
   * 
   * @param {number} [timeout=30000] - Max time to wait for active jobs (in milliseconds)
   * @returns {Promise<void>} Resolves when worker has stopped and jobs are complete
   */
  async stop(timeout = 30000) {
    if (!this.isRunning) {
      this.logger.log('[Worker] Worker is not running');
      return;
    }

    this.isRunning = false;
    this.logger.log('[Worker] Stopping background worker');

    // Clear poll timeout
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    // Wait for active jobs to complete
    const startTime = Date.now();
    while (this.activeJobs.size > 0) {
      if (Date.now() - startTime > timeout) {
        this.logger.log(`[Worker] Timeout waiting for ${this.activeJobs.size} active jobs`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.logger.log('[Worker] Worker stopped');
  }

  /**
   * Main polling loop - fetches and processes jobs from the queue.
   * 
   * @private
   */
  _poll() {
    if (!this.isRunning) {
      return;
    }

    // Process jobs if under concurrency limit
    while (this.activeJobs.size < this.maxConcurrency) {
      const job = this.queue.getNextPendingJob();
      if (!job) {
        break; // No more jobs available
      }

      // Start processing this job
      this._processJob(job);
    }

    // Schedule next poll
    this.pollTimeout = setTimeout(() => this._poll(), this.pollInterval);
  }

  /**
   * Process a single job asynchronously.
   * 
   * @private
   * @param {Job} job - The job to process
   */
  _processJob(job) {
    const { id: jobId, type: jobType } = job;

    // Mark job as active
    this.activeJobs.set(jobId, true);

    // Update queue status
    try {
      this.queue.updateJobStatus(jobId, 'processing', {
        processedAt: Date.now(),
      });
    } catch (error) {
      this.logger.log(`[Worker] Error updating job status: ${error.message}`);
      this.activeJobs.delete(jobId);
      return;
    }

    // Execute job in background
    (async () => {
      try {
        // Get the handler for this job type
        const handler = this.jobHandlers.get(jobType);
        if (!handler) {
          throw new Error(`No handler registered for job type: ${jobType}`);
        }

        // Execute handler with timeout
        await this._executeWithTimeout(handler, job.data, this.jobTimeout);

        // Success - ack the job
        this.queue.ackJob(jobId);
        this.logger.log(`[Worker] Job completed successfully: ${jobId}`);

        // Notify via webhook if configured
        if (this.enableWebhooks && job.webhookUrl) {
          await this._notifyWebhook(job, 'completed', null);
        }
      } catch (error) {
        this.logger.log(`[Worker] Job failed (attempt ${job.attempts + 1}/${job.maxAttempts}): ${jobId} - ${error.message}`);

        // Try to requeue for retry
        const requeued = this.queue.requeueJob(jobId);

        if (requeued) {
          // Notify webhook of retry
          if (this.enableWebhooks && job.webhookUrl) {
            await this._notifyWebhook(job, 'retrying', error);
          }
        } else {
          // Max retries exceeded - mark as failed
          this.queue.nackJob(jobId, error);
          this.logger.log(`[Worker] Job exceeded max attempts: ${jobId}`);

          // Notify webhook of final failure
          if (this.enableWebhooks && job.webhookUrl) {
            await this._notifyWebhook(job, 'failed', error);
          }
        }
      } finally {
        // Mark job as no longer active
        this.activeJobs.delete(jobId);

        // Continue polling for more jobs
        this._poll();
      }
    })();
  }

  /**
   * Executes a handler function with a timeout.
   * 
   * @private
   * @param {Function} handler - The async handler function
   * @param {Object} jobData - Job data to pass to handler
   * @param {number} timeout - Timeout in milliseconds
   * @throws {Error} If handler times out or throws
   */
  _executeWithTimeout(handler, jobData, timeout) {
    return Promise.race([
      handler(jobData),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Job handler timeout after ${timeout}ms`)),
          timeout
        )
      ),
    ]);
  }

  /**
   * Sends a webhook notification about job status.
   * 
   * @private
   * @param {Job} job - The job
   * @param {string} status - Job status ('completed', 'failed', 'retrying')
   * @param {Error|null} error - Error object if applicable
   */
  async _notifyWebhook(job, status, error) {
    if (!job.webhookUrl) {
      return;
    }

    const payload = {
      jobId: job.id,
      jobType: job.type,
      status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      timestamp: new Date().toISOString(),
      error: error ? error.message : null,
    };

    try {
      await withRetry(
        async () => {
          // Use dynamic require to avoid circular dependency issues
          // In production, replace with actual HTTP client
          await this._sendWebhookRequest(job.webhookUrl, payload);
        },
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 5000,
        }
      );
    } catch (webhookError) {
      this.logger.log(`[Worker] Webhook notification failed for job ${job.id}: ${webhookError.message}`);
      // Don't throw - webhook errors shouldn't fail the job
    }
  }

  /**
   * Sends an HTTP POST request to a webhook URL.
   * 
   * @private
   * @param {string} url - The webhook URL
   * @param {Object} payload - The payload to send
   * @throws {Error} If the request fails
   * @security
   *   - URL validation is done at enqueue time
   *   - Requests have a timeout to prevent hanging
   *   - Only POST method is used
   */
  async _sendWebhookRequest(url, payload) {
    // This is a placeholder - in production, use actual HTTP client (fetch, axios, etc.)
    // For testing, this method should be mocked
    
    // Simulate HTTP request for now
    const timeoutMs = 5000;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Webhook request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // In production, replace with actual HTTP client:
      // const response = await fetch(url, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(payload),
      //   timeout: timeoutMs,
      // });
      // if (!response.ok) throw new Error(`Webhook failed: ${response.statusText}`);

      // For now, simulate success after a short delay
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 10);
    });
  }

  /**
   * Gets worker status information.
   * 
   * @returns {Object} Status object with activity metrics
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeJobs: this.activeJobs.size,
      maxConcurrency: this.maxConcurrency,
      registeredHandlers: Array.from(this.jobHandlers.keys()),
      queueMetrics: this.queue.getMetrics(),
    };
  }
}

module.exports = {
  BackgroundWorker,
};
