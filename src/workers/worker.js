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
const { createJobPersistence } = require('./jobPersistence');
const { assertJobStructure } = require('./persistenceValidation');
const logger = require('../logger');
const metrics = require('../metrics');
const auditLogStore = require('../services/auditLogStore');
const { run: runWithContext } = require('../requestContext');

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
/**
 * Checks if job queue persistence is enabled via environment variable.
 *
 * @returns {boolean} True if persistence is enabled.
 */
function isPersistenceEnabled() {
  return String(process.env.JOB_QUEUE_PERSISTENCE_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Gets the maximum number of rows to recover from persistence.
 *
 * @returns {number} Maximum recovery rows (default 1000).
 */
function getMaxRecoveryRows() {
  const parsed = parseInt(process.env.JOB_QUEUE_MAX_RECOVERY_ROWS || '1000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * Creates the default queue, enabling durable backing only when the feature flag is set.
 *
 * @returns {JobQueue} Queue instance.
 */
function createDefaultJobQueue() {
  if (!isPersistenceEnabled()) {
    return new JobQueue();
  }

  const db = require('../db/knex');
  return new JobQueue({
    persistence: createJobPersistence(db, { maxRecoveryRows: getMaxRecoveryRows() }),
  });
}

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
    this.jobQueue = options.jobQueue || createDefaultJobQueue();

    // Security: bound poll interval to prevent CPU spinning
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 1000, 10);

    // Security: limit concurrency to prevent resource exhaustion
    this.maxConcurrency = Math.max(options.maxConcurrency ?? 2, 1);

    /** @type {Map<string,Function>} Handler registry: job type → async function */
    this.handlers = new Map();

    this.isRunning      = false;
    this.processingCount = 0;
    this.pollTimer = null;

    metrics.registerWorker(this);
    this.processingCount = 0;
    this.pollTimer = null;
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
        logger.error({ err, ...buildJobContext(job) }, 'Unexpected error processing job');
      });
    }

    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this._poll(), this.pollIntervalMs);
    }
  }

  /**
   * Process a single job with its registered handler.
   *
   * Restores trace context from job.traceContext (if present) before executing
   * the handler, ensuring logs and metrics are correlated with the original request.
   *
   * @private
   * @param {Object} job - The job to process
   * @returns {Promise<void>}
   */
  async _processJob(job) {
    try {
      assertJobStructure(job);

      const handler = this.handlers.get(job.type);
      if (!handler) {
        throw new Error(`No handler for job type "${job.type}"`);
      }

      // Restore trace context for the job lifetime
      if (job.traceContext && typeof job.traceContext === 'object') {
        await runWithContext(job.traceContext, async () => {
          await handler(job);
        });
      } else {
        await handler(job);
      }

      this.jobQueue.ack(job.id);
    } catch (err) {
      logger.error({ err, ...buildJobContext(job) }, 'Job handler failed');
      this.jobQueue.retry(job.id, err);
    } finally {
      this.processingCount -= 1;
    }
  }
}


/**
 * Allow-listed payload keys that are safe to surface in error logs.
 * Everything else in the payload (webhook secrets, signing tokens, full
 * invoice bodies, …) is deliberately dropped.
 *
 * @type {Set<string>}
 */
const CONTEXT_KEYS = new Set([
  'tenantId', 'invoiceId', 'correlationId', 'performedBy', 'policyId', 'batchSize',
]);

/**
 * Build a compact, log-safe execution context object from a job record.
 *
 * The context always carries `jobId`, `jobType`, and `attempt` (the attempt
 * count at the time of failure). From the job payload, only the allow-listed
 * {@link CONTEXT_KEYS} are copied — and only when their values are primitives
 * (string/number/boolean/null), so nested objects can never smuggle secrets
 * into logs. When present, `correlationId` links the failure back to the
 * request that enqueued the job.
 *
 * As defence in depth, the assembled context is passed through the shared
 * `redactValue` scrubber from `services/auditLogStore`, which masks any value
 * whose key matches a sensitive pattern (password, secret, token, apiKey, …).
 *
 * @param {Object} job - Job record from the queue
 * @returns {Object} Redacted context with jobId, jobType, attempt, and allowed payload keys
 */
function buildJobContext(job) {
  if (!job || typeof job !== 'object') { return {}; }
  const ctx = {
    jobId: job.id,
    jobType: job.type,
    attempt: job.attempts ?? job.attempt ?? 1,
  };

  const payload = job.payload || {};
  if (payload && typeof payload === 'object') {
    for (const k of CONTEXT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) {
        const v = payload[k];
        // only include primitive values to avoid leaking nested secrets
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
          ctx[k] = v;
        }
      }
    }
  }
  return auditLogStore.redactValue(ctx);
}

module.exports = BackgroundWorker;
module.exports.createDefaultJobQueue = createDefaultJobQueue;
module.exports.isPersistenceEnabled = isPersistenceEnabled;
module.exports.getMaxRecoveryRows = getMaxRecoveryRows;
module.exports.buildJobContext = buildJobContext;
