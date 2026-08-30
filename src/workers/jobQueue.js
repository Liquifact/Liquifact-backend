'use strict';
/**
 * @fileoverview In-memory job queue with optional durable persistence.
 * @module workers/jobQueue
 */

const crypto = require('crypto');
const metrics = require('../metrics');
const logger = require('../logger');
const { get: getContext, ALLOWED_KEYS } = require('../requestContext');

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERN = /(secret|token|password|api[_-]?key|authorization|credential)/i;
const NON_TERMINAL_STATUSES = ['pending', 'processing', 'retrying'];

/**
 * Maximum size for serialized trace context in bytes (1 KB).
 * Prevents oversized context from bloating job records.
 */
const MAX_TRACE_CONTEXT_BYTES = 1024;

/**
 * Extracts and validates trace context from the current AsyncLocalStorage.
 *
 * Only keys in ALLOWED_KEYS are extracted to prevent user-controlled fields
 * from becoming log labels. Values must be non-empty strings.
 *
 * @returns {Object|null} Validated trace context object, or null if empty.
 */
function extractTraceContext() {
  const ctx = getContext();
  const traceCtx = {};
  
  for (const key of ALLOWED_KEYS) {
    const value = ctx[key];
    if (typeof value === 'string' && value.length > 0) {
      traceCtx[key] = value;
    }
  }
  
  // Return null instead of empty object to distinguish "no context" from "empty context"
  return Object.keys(traceCtx).length > 0 ? traceCtx : null;
}

/**
 * Validates a trace context object against security constraints.
 *
 * Only allows keys in ALLOWED_KEYS, requires non-empty string values,
 * and enforces size limit when serialized.
 *
 * @param {Object} traceCtx - Trace context to validate.
 * @returns {{ ok: true, context: Object } | { ok: false, error: string }}
 */
function validateTraceContext(traceCtx) {
  if (!traceCtx || typeof traceCtx !== 'object') {
    return { ok: false, error: 'Trace context must be an object' };
  }
  
  const validated = {};
  for (const key of Object.keys(traceCtx)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: `Invalid trace context key: ${key}` };
    }
    
    const value = traceCtx[key];
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, error: `Trace context key "${key}" must be a non-empty string` };
    }
    
    validated[key] = value;
  }
  
  // Check size limit
  try {
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TRACE_CONTEXT_BYTES) {
      return { ok: false, error: 'Trace context exceeds size limit' };
    }
  } catch (_err) {
    return { ok: false, error: 'Failed to serialize trace context' };
  }
  
  return { ok: true, context: validated };
}

const JOB_STATUS = {
  PENDING:    'pending',
  PROCESSING: 'processing',
  COMPLETED:  'completed',
  FAILED:     'failed',
  RETRYING:   'retrying',
};

class JobQueue {
  /**
   * Creates a new JobQueue instance.
   *
   * @param {Object} options - Configuration options.
   * @param {number} [options.maxRetries=3] - Maximum retry attempts (hard-capped at 10).
   * @param {number} [options.maxQueueSize=10000] - Maximum number of jobs in queue.
   * @param {object|null} [options.persistence=null] - Persistence adapter from createJobPersistence().
   */
  constructor(options = {}) {
    this.maxRetries   = Math.min(options.maxRetries ?? 3, 10);
    this.maxQueueSize = options.maxQueueSize || 10000;
    this._persistence = options.persistence || null;
    
    // Using Map for efficient O(1) lookups
    this.jobs = new Map();
    
    // Queue structure: array of job IDs
    this.queue = [];
    
    // Retry queue: separate queue for jobs that need retrying
    this.retryQueue = [];

    metrics.registerJobQueue(this);
  }

  /**
   * Enqueue a job for processing.
   *
   * @param {string} type - Job type identifier.
   * @param {Object} payload - Job payload (must be JSON-serializable).
   * @param {Object} [options] - Optional job configuration.
   * @param {number} [options.priority=0] - Job priority (higher = processed first).
   * @param {number} [options.delayMs=0] - Delay before job becomes available for processing.
   * @returns {string} jobId - The generated job ID.
   */
  enqueue(type, payload, options = {}) {
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new Error('Job type must be a non-empty string');
    }
    try {
      JSON.stringify(payload);
    } catch (_err) {
      throw new Error('Job payload must be JSON-serializable');
    }
    if (this.queue.length + this.retryQueue.length >= this.maxQueueSize) {
      throw new Error(`Queue is full (max ${this.maxQueueSize} jobs)`);
    }

    // Capture and validate trace context from current AsyncLocalStorage
    const traceContext = extractTraceContext();
    const validation = validateTraceContext(traceContext);
    if (!validation.ok) {
      logger.warn({ error: validation.error }, '[jobQueue] Invalid trace context, enqueuing without trace');
    }

    const jobId = `job-${crypto.randomBytes(8).toString('hex')}`;
    const job = {
      id:          jobId,
      type,
      payload,
      status:      JOB_STATUS.PENDING,
      priority:    options.priority || 0,
      delayMs:     options.delayMs  || 0,
      createdAt:   Date.now(),
      startedAt:   null,
      completedAt: null,
      attempts:    0,
      lastError:   null,
      traceContext: validation.ok ? validation.context : null,
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    if (this._persistence) { this._persistence.persistJob(job); }
    return jobId;
  }

  /**
   * Dequeue the next ready job (retry queue first, then main queue).
   * Skips delayed jobs (delayMs > now).
   *
   * @returns {Object|null} Job object or null if no job is ready.
   */
  dequeue() {
    // Retry queue has priority
    if (this.retryQueue.length > 0) {
      const jobId = this.retryQueue.shift();
      const job   = this.jobs.get(jobId);
      if (job) {
        if (this._isReadyToProcess(job)) {
          job.status    = JOB_STATUS.PROCESSING;
          job.startedAt = Date.now();
          job.attempts += 1;
          if (this._persistence) { this._persistence.updateJobStatus(job); }
          return job;
        }
        this.retryQueue.push(jobId); // not ready yet
      }
    }

    // Main queue
    while (this.queue.length > 0) {
      const jobId = this.queue.shift();
      const job   = this.jobs.get(jobId);
      if (!job) { continue; }
      if (this._isReadyToProcess(job)) {
        job.status    = JOB_STATUS.PROCESSING;
        job.startedAt = Date.now();
        job.attempts += 1;
        if (this._persistence) { this._persistence.updateJobStatus(job); }
        return job;
      }
      if (job.delayMs > 0) { this.queue.push(jobId); }
    }

    return null;
  }

  /**
   * Acknowledge successful completion. Stamps acked_at in DB to block replay.
   *
   * @param {string} jobId - The job ID to acknowledge.
   */
  ack(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) { throw new Error(`Job ${jobId} not found`); }
    if (job.status !== JOB_STATUS.PROCESSING) {
      throw new Error(`Cannot ack job ${jobId}: status is ${job.status}, expected ${JOB_STATUS.PROCESSING}`);
    }
    job.status      = JOB_STATUS.COMPLETED;
    job.completedAt = Date.now();
    if (this._persistence) { this._persistence.ackJob(jobId); }
  }

  /**
   * Cancel a pending job.
   *
   * @param {string} jobId - The job ID to cancel.
   * @returns {boolean} True if job was found and cancelled, false otherwise.
   */
  cancel(jobId) {
    return this.jobs.delete(jobId);
  }

  /**
   * Retry a failed job with exponential backoff (capped at 60 seconds).
   * Marks job as FAILED after maxRetries is exceeded (hard cap of 10).
   *
   * @param {string} jobId - The job ID to retry.
   * @param {Error|*} error - The error that caused the retry.
   */
  retry(jobId, error) {
    const job = this.jobs.get(jobId);
    if (!job) { throw new Error(`Job ${jobId} not found`); }

    job.lastError = error && error.message ? error.message : String(error);

    if (job.attempts <= this.maxRetries) {
      job.status  = JOB_STATUS.RETRYING;
      // 2^(attempts-1) seconds, max 60 s
      const delay = Math.min(Math.pow(2, job.attempts - 1) * 1000, 60000);
      job.delayMs = Date.now() + delay;
      this.retryQueue.push(jobId);
    } else {
      job.status      = JOB_STATUS.FAILED;
      job.completedAt = Date.now();
    }
    if (this._persistence) { this._persistence.updateJobStatus(job); }
  }

  /**
   * Retrieves a job by ID.
   *
   * @param {string} jobId - The job ID to retrieve.
   * @returns {Object|null} The job object, or null if not found.
   */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Gets queue statistics.
   *
   * @returns {Object} Statistics object with counts for each job status.
   */
  getStats() {
    const s = { pending: 0, processing: 0, completed: 0, failed: 0, retrying: 0,
      total: this.jobs.size, queueLength: this.queue.length,
      retryQueueLength: this.retryQueue.length };
    for (const job of this.jobs.values()) {
      if      (job.status === JOB_STATUS.PENDING)    { s.pending    += 1; }
      else if (job.status === JOB_STATUS.PROCESSING) { s.processing += 1; }
      else if (job.status === JOB_STATUS.COMPLETED)  { s.completed  += 1; }
      else if (job.status === JOB_STATUS.FAILED)     { s.failed     += 1; }
      else if (job.status === JOB_STATUS.RETRYING)   { s.retrying   += 1; }
    }
    return s;
  }

  /**
   * Clears all jobs and resets queues.
   *
   * @returns {number} Number of jobs cleared.
   */
  clear() {
    const count = this.jobs.size;
    this.jobs.clear();
    this.queue      = [];
    this.retryQueue = [];
    return count;
  }

  /**
   * Restores unacked jobs from the DB into the in-memory queue.
   * Only callable when a persistence adapter is configured.
   * Jobs that were in-flight (PROCESSING) are re-added for at-least-once delivery.
   * Bounded by persistence.maxRecoveryRows so startup is never blocked indefinitely.
   *
   * @returns {Promise<number>} Number of jobs restored.
   */
  async restoreFromPersistence() {
    if (!this._persistence) { return 0; }

    let recovered;
    try {
      recovered = await this._persistence.recoverUnackedJobs();
    } catch (err) {
      logger.error({ err }, '[jobQueue] Failed to recover persisted jobs; starting empty');
      return 0;
    }
    let count = 0;

    for (const job of recovered) {
      if (this.jobs.has(job.id)) { continue; }
      if (this.queue.length + this.retryQueue.length >= this.maxQueueSize) { break; }

      if (job.status === JOB_STATUS.PROCESSING) {
        job.status = JOB_STATUS.PENDING;
        job.startedAt = null;
      }

      this.jobs.set(job.id, job);
      // Jobs that already had attempts go to the retry queue; fresh ones to main.
      if (job.attempts > 0) {
        this.retryQueue.push(job.id);
      } else {
        this.queue.push(job.id);
      }
      count += 1;
    }
    return count;
  }

  // ── private ──────────────────────────────────────────────────────────────

  /**
   * Checks if a job is ready to be processed.
   *
   * @param {Object} job - The job to check.
   * @returns {boolean} True if the job is ready for processing.
   */
  _isReadyToProcess(job) {
    if (job.status !== JOB_STATUS.PENDING && job.status !== JOB_STATUS.RETRYING) {
      return false;
    }
    const now = Date.now();
    return typeof job.delayMs === 'number' ? now >= job.delayMs : job.delayMs === 0;
  }
}

/**
 * Recursively sorts object keys for deterministic serialization.
 *
 * @param {any} value - Value to sort.
 * @returns {any} Value with sorted object keys.
 */
function sortKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortKeys(value[key]);
    return acc;
  }, {});
}

/**
 * Removes secret-like fields before a job payload is persisted.
 *
 * @param {any} payload - Raw job payload.
 * @returns {any} Sanitized payload safe for database storage.
 */
function sanitizePayloadForPersistence(payload) {
  if (payload === null || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(sanitizePayloadForPersistence);
  }

  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      acc[key] = REDACTED;
      return acc;
    }

    if (value !== null && typeof value === 'object') {
      acc[key] = sanitizePayloadForPersistence(value);
      return acc;
    }

    acc[key] = value;
    return acc;
  }, {});
}

/**
 * Computes a stable SHA-256 fingerprint for a sanitized payload.
 *
 * @param {Object} payload - Sanitized payload object.
 * @returns {string} Hex-encoded SHA-256 digest.
 */
function computePayloadFingerprint(payload) {
  const canonical = JSON.stringify(sortKeys(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Database-backed job queue for crash-safe transaction submission.
 *
 * Persists enqueue/ack/retry transitions to `tx_submissions` and can restore
 * non-terminal jobs after process restart.
 *
 * @class DurableJobQueue
 * @extends JobQueue
 */
class DurableJobQueue extends JobQueue {
  /**
   * Creates a durable queue backed by the shared Knex database.
   *
   * @param {Object} options - Queue configuration.
   * @param {import('knex').Knex} options.db - Shared Knex instance.
   * @param {string} [options.tableName='tx_submissions'] - Persistence table name.
   * @param {number} [options.maxRetries=3] - Maximum retry attempts per job.
   * @param {number} [options.maxQueueSize=10000] - Maximum in-memory queue size.
   */
  constructor(options = {}) {
    super(options);

    if (!options.db || typeof options.db !== 'function') {
      throw new Error('DurableJobQueue requires a Knex db instance');
    }

    this.db = options.db;
    this.tableName = options.tableName || 'tx_submissions';
    this._restored = false;
  }

  /**
   * Persists a newly enqueued job row.
   *
   * @param {string} type - Job type identifier.
   * @param {Object} payload - Raw job payload.
   * @param {Object} [options={}] - Enqueue options.
   * @returns {Promise<string>} Generated job ID.
   */
  async enqueue(type, payload, options = {}) {
    const jobId = super.enqueue(type, payload, options);
    const job = this.getJob(jobId);
    const sanitizedPayload = sanitizePayloadForPersistence(payload);

    await this.db(this.tableName).insert({
      id: jobId,
      job_type: type,
      payload_fingerprint: computePayloadFingerprint(sanitizedPayload),
      payload: JSON.stringify(sanitizedPayload),
      status: job.status,
      attempts: job.attempts,
      priority: job.priority,
      delay_until_ms: job.delayMs,
      last_error: job.lastError,
      trace_context: job.traceContext ? JSON.stringify(job.traceContext) : null,
      created_at: new Date(job.createdAt),
      started_at: null,
      completed_at: null,
      updated_at: new Date(),
    });

    return jobId;
  }

  /**
   * Marks a job complete in memory and in the database.
   *
   * @param {string} jobId - Job identifier.
   * @returns {void}
   */
  ack(jobId) {
    super.ack(jobId);
    const job = this.getJob(jobId);
    this._persistJobState(job).catch((err) => {
      logger.warn({ err: err.message, jobId }, 'Failed to persist tx submission ack');
    });
  }

  /**
   * Schedules or finalizes a retry in memory and in the database.
   *
   * @param {string} jobId - Job identifier.
   * @param {Error} error - Failure error.
   * @returns {void}
   */
  retry(jobId, error) {
    super.retry(jobId, error);
    const job = this.getJob(jobId);
    this._persistJobState(job).catch((err) => {
      logger.warn({ err: err.message, jobId }, 'Failed to persist tx submission retry');
    });
  }

  /**
   * Dequeues the next ready job and marks it processing in the database.
   *
   * @returns {Object|null} Next job to process.
   */
  dequeue() {
    const job = super.dequeue();
    if (job) {
      this._persistJobState(job).catch((err) => {
        logger.warn({ err: err.message, jobId: job.id }, 'Failed to persist tx submission dequeue');
      });
    }
    return job;
  }

  /**
   * Restores non-terminal jobs from the database after restart.
   *
   * Processing jobs are reset to pending so they can be safely retried.
   * Calling restore more than once is idempotent.
   *
   * @returns {Promise<{restored: number, skipped: number}>} Restore summary.
   */
  async restore() {
    if (this._restored) {
      return { restored: 0, skipped: 0 };
    }

    const rows = await this.db(this.tableName)
      .whereIn('status', NON_TERMINAL_STATUSES)
      .orderBy('created_at', 'asc');

    let restored = 0;
    let skipped = 0;

    for (const row of rows) {
      if (this.jobs.has(row.id)) {
        skipped += 1;
        continue;
      }

      const job = this._rowToJob(row);

      if (row.status === JOB_STATUS.PROCESSING) {
        job.status = JOB_STATUS.PENDING;
        job.startedAt = null;
        await this.db(this.tableName)
          .where({ id: row.id })
          .update({
            status: JOB_STATUS.PENDING,
            started_at: null,
            updated_at: new Date(),
          });
      }

      this.jobs.set(job.id, job);

      if (job.status === JOB_STATUS.RETRYING) {
        this.retryQueue.push(job.id);
      } else {
        this.queue.push(job.id);
      }

      restored += 1;
    }

    this._restored = true;
    return { restored, skipped };
  }

  /**
   * Writes the current in-memory job state to the database.
   *
   * @private
   * @param {Object} job - In-memory job object.
   * @returns {Promise<number>} Number of updated rows.
   */
  async _persistJobState(job) {
    return this.db(this.tableName)
      .where({ id: job.id })
      .update({
        status: job.status,
        attempts: job.attempts,
        priority: job.priority,
        delay_until_ms: job.delayMs,
        last_error: job.lastError,
        started_at: job.startedAt ? new Date(job.startedAt) : null,
        completed_at: job.completedAt ? new Date(job.completedAt) : null,
        updated_at: new Date(),
      });
  }

  /**
   * Converts a persisted row into an in-memory job object.
   *
   * @private
   * @param {Object} row - Database row.
   * @returns {Object} Job object compatible with JobQueue.
   */
  _rowToJob(row) {
    let payload = row.payload;
    if (typeof payload === 'string') {
      payload = JSON.parse(payload);
    }

    // Restore trace context if present and valid
    let traceContext = null;
    if (row.trace_context) {
      try {
        const parsed = typeof row.trace_context === 'string' 
          ? JSON.parse(row.trace_context) 
          : row.trace_context;
        // Validate against ALLOWED_KEYS to prevent injection
        const validated = {};
        for (const key of Object.keys(parsed)) {
          if (ALLOWED_KEYS.has(key) && typeof parsed[key] === 'string' && parsed[key]) {
            validated[key] = parsed[key];
          }
        }
        if (Object.keys(validated).length > 0) {
          traceContext = validated;
        }
      } catch (err) {
        logger.warn(
          { jobId: row.id, error: err.message },
          '[DurableJobQueue] Failed to parse trace_context from row'
        );
      }
    }

    return {
      id: row.id,
      type: row.job_type,
      payload,
      status: row.status,
      priority: row.priority || 0,
      delayMs: Number(row.delay_until_ms || 0),
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
      completedAt: row.completed_at ? new Date(row.completed_at).getTime() : null,
      attempts: row.attempts || 0,
      lastError: row.last_error || null,
      traceContext,
    };
  }
}

module.exports = JobQueue;
module.exports.JOB_STATUS = JOB_STATUS;
module.exports.DurableJobQueue = DurableJobQueue;
module.exports.sanitizePayloadForPersistence = sanitizePayloadForPersistence;
module.exports.computePayloadFingerprint = computePayloadFingerprint;
