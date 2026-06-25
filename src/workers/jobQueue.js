'use strict';
/**
 * @fileoverview In-memory job queue with optional durable persistence.
 * @module workers/jobQueue
 */

const crypto = require('crypto');

const JOB_STATUS = {
  PENDING:    'pending',
  PROCESSING: 'processing',
  COMPLETED:  'completed',
  FAILED:     'failed',
  RETRYING:   'retrying',
};

class JobQueue {
  /**
   * @param {Object}  options
   * @param {number}  [options.maxRetries=3]       Hard-capped at 10.
   * @param {number}  [options.maxQueueSize=10000]
   * @param {object|null} [options.persistence=null] Adapter from createJobPersistence().
   */
  constructor(options = {}) {
    this.maxRetries   = Math.min(options.maxRetries ?? 3, 10);
    this.maxQueueSize = options.maxQueueSize || 10000;
    this._persistence = options.persistence ?? null;
    this.jobs         = new Map();
    this.queue        = [];
    this.retryQueue   = [];
  }

  /**
   * Enqueue a job.
   * @param {string} type
   * @param {Object} payload  Must be JSON-serialisable.
   * @param {Object} [options]
   * @param {number} [options.priority=0]
   * @param {number} [options.delayMs=0]
   * @returns {string} jobId
   */
  enqueue(type, payload, options = {}) {
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new Error('Job type must be a non-empty string');
    }
    try {
      JSON.stringify(payload);
    } catch (err) {
      throw new Error(`Job payload must be JSON-serializable: ${err.message}`);
    }
    if (this.queue.length + this.retryQueue.length >= this.maxQueueSize) {
      throw new Error(`Queue is full (max ${this.maxQueueSize} jobs)`);
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
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    if (this._persistence) { this._persistence.persistJob(job); }
    return jobId;
  }

  /**
   * Dequeue the next ready job (retry queue first, then main queue).
   * @returns {Object|null}
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
   * Acknowledge successful completion.  Stamps acked_at in DB to block replay.
   * @param {string} jobId
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
   * @param {string} jobId
   * @returns {boolean}
   */
  cancel(jobId) {
    return this.jobs.delete(jobId);
  }

  /**
   * Retry a failed job with exponential backoff (capped 60 s).
   * Marks FAILED after maxRetries is exceeded (hard cap 10).
   * @param {string} jobId
   * @param {Error|*} error
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

  /** @returns {Object|null} */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /** @returns {Object} */
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

  /** @returns {number} count cleared */
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

    const recovered = await this._persistence.recoverUnackedJobs();
    let count = 0;

    for (const job of recovered) {
      if (this.jobs.has(job.id)) { continue; }
      if (this.queue.length + this.retryQueue.length >= this.maxQueueSize) { break; }

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

  _isReadyToProcess(job) {
    if (job.status !== JOB_STATUS.PENDING && job.status !== JOB_STATUS.RETRYING) {
      return false;
    }
    const now = Date.now();
    return typeof job.delayMs === 'number' ? now >= job.delayMs : job.delayMs === 0;
  }
}

module.exports = JobQueue;
module.exports.JOB_STATUS = JOB_STATUS;
