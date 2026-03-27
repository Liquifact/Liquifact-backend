/**
 * @fileoverview Background worker for processing asynchronous jobs.
 * Provides a worker loop that dequeues jobs and executes them with proper error handling.
 * 
 * Security Considerations:
 * - Handler execution is wrapped in try-catch to prevent uncaught exceptions
 * - Worker validates that handlers are functions before executing
 * - Processing count prevents stack overflow from chained promises
 * - Poll interval is bounded (minimum 10ms) to prevent CPU spinning
 * - Graceful shutdown allows in-flight jobs to complete
 * 
 * @module workers/worker
 */

const JobQueue = require('./jobQueue');
const { JOB_STATUS } = require('./jobQueue');

/**
 * Background worker that processes queued jobs
 * 
 * Features:
 * - Asynchronous job processing with configurable handlers
 * - Automatic retry with exponential backoff
 * - Graceful start/stop with in-flight job handling
 * - Processing statistics and monitoring
 * - Security validation of job handlers
 * 
 * @class BackgroundWorker
 */
class BackgroundWorker {
  /**
   * Creates a new BackgroundWorker instance
   * 
   * @param {Object} options - Worker configuration
   * @param {JobQueue} [options.jobQueue] - Job queue instance (creates new if not provided)
   * @param {number} [options.pollIntervalMs=1000] - How often to check queue (min 10ms)
   * @param {number} [options.maxConcurrency=2] - Max concurrent job processing
   */
  constructor(options = {}) {
    this.jobQueue = options.jobQueue || new JobQueue();
    
    // Security: Bound poll interval to prevent CPU spinning
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 1000, 10);
    
    // Security: Limit concurrency to prevent resource exhaustion
    this.maxConcurrency = Math.max(
      options.maxConcurrency ?? 2,
      1
    );
    
    // Handler registry: map of job type to handler function
    this.handlers = new Map();
    
    // Worker state
    this.isRunning = false;
    this.processingCount = 0;
    this.pollTimer = null;
  }

  /**
   * Register a handler for a specific job type
   * 
   * Security Validation:
   * - Handler must be a function
   * - Job type must be a non-empty string
   * 
   * @param {string} jobType - The job type (e.g., 'verify', 'webhook_retry')
   * @param {Function} handler - Async function(job) to handle the job
   * @throws {Error} If handler is not a function or jobType is invalid
   */
  registerHandler(jobType, handler) {
    if (typeof jobType !== 'string' || jobType.trim().length === 0) {
      throw new Error('Job type must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new Error(`Handler must be a function, got ${typeof handler}`);
    }

    this.handlers.set(jobType, handler);
  }

  /**
   * Start the worker loop
   * 
   * Once started, the worker will continuously poll the queue and process jobs
   * using registered handlers. Worker runs until stop() is called.
   * 
   * @throws {Error} If already running or no handlers registered
   */
  start() {
    if (this.isRunning) {
      throw new Error('Worker is already running');
    }

    if (this.handlers.size === 0) {
      throw new Error('No job handlers registered');
    }

    this.isRunning = true;
    this._poll();
  }

  /**
   * Stop the worker loop gracefully
   * 
   * Stops accepting new jobs but allows in-flight jobs to complete.
   * Resolves when all in-flight jobs are done (or timeout).
   * 
   * @param {number} [timeoutMs=10000] - Max time to wait for in-flight jobs
   * @returns {Promise<void>}
   */
  async stop(timeoutMs = 10000) {
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight jobs to complete
    const startTime = Date.now();
    while (this.processingCount > 0 && Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100)); // eslint-disable-line no-await-in-loop
    }

    if (this.processingCount > 0) {
      console.warn(
        `Worker stopped with ${this.processingCount} jobs still processing (timeout)`
      );
    }
  }

  /**
   * Enqueue a job for processing
   * 
   * @param {string} jobType - The job type
   * @param {Object} payload - The job payload
   * @param {Object} [options={}] - Additional options (priority, delayMs)
   * @returns {string} The job ID
   * @throws {Error} If job type has no registered handler
   */
  enqueue(jobType, payload, options = {}) {
    if (!this.handlers.has(jobType)) {
      throw new Error(
        `No handler registered for job type "${jobType}". ` +
        `Registered types: ${Array.from(this.handlers.keys()).join(', ')}`
      );
    }

    return this.jobQueue.enqueue(jobType, payload, options);
  }

  /**
   * Get statistics about worker state and queue
   * 
   * @returns {Object} Worker stats including running status, processing count, queue stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      processingCount: this.processingCount,
      handlerCount: this.handlers.size,
      queueStats: this.jobQueue.getStats(),
    };
  }

  /**
   * Poll the queue and process available jobs
   * 
   * This runs continuously when the worker is started.
   * It processes up to maxConcurrency jobs at a time.
   * 
   * @private
   */
  _poll() {
    if (!this.isRunning) {
      return;
    }

    // Process jobs up to concurrency limit
    while (this.processingCount < this.maxConcurrency) {
      const job = this.jobQueue.dequeue();
      if (!job) {
        break; // Queue is empty
      }

      this.processingCount += 1;

      // Process job asynchronously (don't await, let it run in background)
      this._processJob(job).catch((err) => {
        console.error(`Unexpected error processing job ${job.id}:`, err);
      });
    }

    // Schedule next poll
    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this._poll(), this.pollIntervalMs);
    }
  }

  /**
   * Process a single job with its registered handler
   * 
   * Security & Error Handling:
   * - Handler must exist for job type (validated at registration time)
   * - Handler execution is wrapped in try-catch
   * - Errors trigger retry logic with exponential backoff
   * - Job ID is validated before processing
   * 
   * @private
   * @param {Object} job - The job to process
   * @returns {Promise<void>}
   */
  async _processJob(job) {
    try {
      if (!job || !job.id || !job.type) {
        throw new Error('Invalid job structure');
      }

      const handler = this.handlers.get(job.type);
      if (!handler) {
        throw new Error(`No handler for job type "${job.type}"`);
      }

      // Execute the handler
      await handler(job);

      // Job succeeded
      this.jobQueue.ack(job.id);
    } catch (err) {
      // Job failed, attempt retry
      this.jobQueue.retry(job.id, err);
    } finally {
      this.processingCount -= 1;
    }
  }
}

module.exports = BackgroundWorker;
