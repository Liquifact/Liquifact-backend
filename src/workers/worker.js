/**
 * @fileoverview Background worker for processing asynchronous jobs.
 * Provides a worker loop that dequeues jobs and executes them with proper error handling.
 *
 * Crash recovery
 * --------------
 * When the attached JobQueue has a persistence adapter configured, calling
 * `start()` automatically restores unacked jobs from the DB before the poll
 * loop begins.  Recovery is bounded (see `JobQueue.restoreFromPersistence`)
 * and never blocks indefinitely.
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
const logger   = require('../logger');

/**
 * Background worker that processes queued jobs.
 *
 * Features:
 * - Asynchronous job processing with configurable handlers
 * - Automatic retry with exponential backoff
 * - Graceful start/stop with in-flight job handling
 * - Optional crash recovery via JobQueue persistence adapter
 * - Processing statistics and monitoring
 * - Security validation of job handlers
 *
 * @class BackgroundWorker
 */
class BackgroundWorker {
  /**
   * Creates a new BackgroundWorker instance.
   *
   * @param {Object} options - Worker configuration
   * @param {JobQueue} [options.jobQueue]       - Job queue instance (creates new if not provided)
   * @param {number}   [options.pollIntervalMs=1000] - How often to check queue (min 10ms)
   * @param {number}   [options.maxConcurrency=2]    - Max concurrent job processing
   */
  constructor(options = {}) {
    this.jobQueue = options.jobQueue || new JobQueue();

    // Security: bound poll interval to prevent CPU spinning
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 1000, 10);

    // Security: limit concurrency to prevent resource exhaustion
    this.maxConcurrency = Math.max(options.maxConcurrency ?? 2, 1);

    /** @type {Map<string,Function>} Handler registry: job type → async function */
    this.handlers = new Map();

    this.isRunning      = false;
    this.processingCount = 0;
    this.pollTimer      = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a handler for a specific job type.
   *
   * @param {string}   jobType - The job type (e.g., 'webhook_delivery')
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
   * Start the worker loop.
   *
   * When the attached queue has a persistence adapter, unacked jobs are
   * restored from the DB before the poll loop begins (crash recovery).
   * Recovery is async; `start()` returns a Promise in that case and resolves
   * once recovery is complete and the poll loop has started.
   *
   * @returns {Promise<void>}
   * @throws {Error} If already running or no handlers registered
   */
  async start() {
    if (this.isRunning) {
      throw new Error('Worker is already running');
    }
    if (this.handlers.size === 0) {
      throw new Error('No job handlers registered');
    }

    // Crash recovery: restore unacked jobs from DB before polling begins.
    if (this.jobQueue._persistence) {
      try {
        const restored = await this.jobQueue.restoreFromPersistence();
        if (restored > 0) {
          logger.info({ restored }, '[worker] Crash recovery: restored unacked jobs from DB');
        }
      } catch (err) {
        // Recovery failure must not prevent startup.
        logger.error({ err }, '[worker] Crash recovery failed; starting with empty queue');
      }
    }

    this.isRunning = true;
    this._poll();
  }

  /**
   * Stop the worker loop gracefully.
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

    const startTime = Date.now();
    while (this.processingCount > 0 && Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.processingCount > 0) {
      logger.warn(
        { processingCount: this.processingCount },
        'Worker stopped with jobs still processing (timeout)'
      );
    }
  }

  /**
   * Enqueue a job for processing.
   *
   * @param {string} jobType     - The job type
   * @param {Object} payload     - The job payload
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
   * Get statistics about worker state and queue.
   *
   * @returns {Object} Worker stats including running status, processing count, queue stats
   */
  getStats() {
    return {
      isRunning:       this.isRunning,
      processingCount: this.processingCount,
      handlerCount:    this.handlers.size,
      queueStats:      this.jobQueue.getStats(),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Poll the queue and process available jobs.
   * Runs continuously while isRunning is true.
   *
   * @private
   */
  _poll() {
    if (!this.isRunning) { return; }

    while (this.processingCount < this.maxConcurrency) {
      const job = this.jobQueue.dequeue();
      if (!job) { break; }

      this.processingCount += 1;

      this._processJob(job).catch((err) => {
        logger.error({ err, jobId: job.id }, 'Unexpected error processing job');
      });
    }

    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this._poll(), this.pollIntervalMs);
    }
  }

  /**
   * Process a single job with its registered handler.
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

      await handler(job);

      this.jobQueue.ack(job.id);
    } catch (err) {
      this.jobQueue.retry(job.id, err);
    } finally {
      this.processingCount -= 1;
    }
  }
}

module.exports = BackgroundWorker;
