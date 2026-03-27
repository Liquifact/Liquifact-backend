/**
 * In-memory Job Queue for asynchronous task processing.
 * Stores job metadata, status, and retry information.
 * 
 * @module workers/queue
 * @security
 *   - Job data is validated to prevent excessive payload sizes
 *   - Retry options are bounded to prevent resource exhaustion
 *   - Job IDs are UUIDs to prevent enumeration attacks
 */

const crypto = require('crypto');

/**
 * Represents a single job in the queue.
 * @typedef {Object} Job
 * @property {string} id - Unique job identifier (UUID)
 * @property {string} type - Job type identifier (e.g., 'webhook', 'verification')
 * @property {Object} data - Job payload
 * @property {string} status - Current status: 'pending', 'processing', 'completed', 'failed'
 * @property {number} attempts - Current attempt count
 * @property {number} maxAttempts - Maximum retry attempts (default: 3, max: 10)
 * @property {Error|null} lastError - Last error encountered
 * @property {number} createdAt - Timestamp when job was created
 * @property {number} updatedAt - Timestamp of last status change
 * @property {number} processedAt - Timestamp when job was first processed
 * @property {string|null} webhookUrl - Optional webhook URL for status updates
 */

/**
 * JobQueue class manages an in-memory queue of jobs for asynchronous processing.
 * Provides safe enqueue, status updates, and job retrieval operations.
 */
class JobQueue {
  constructor() {
    // Security: Using Map for O(1) lookups instead of array filtering
    this.jobs = new Map();
    this.metrics = {
      totalEnqueued: 0,
      totalCompleted: 0,
      totalFailed: 0,
    };
  }

  /**
   * Enqueues a new job to the queue.
   * 
   * @param {string} jobType - Type identifier for the job (e.g., 'webhook', 'verification')
   * @param {Object} jobData - Job payload data
   * @param {Object} [options={}] - Job options
   * @param {number} [options.maxAttempts=3] - Maximum retry attempts (capped at 10)
   * @param {string} [options.webhookUrl] - Optional webhook URL for status notifications
   * @returns {string} The unique job ID
   * @throws {Error} If job type or data is invalid
   * @security
   *   - Job data size is limited to 1MB to prevent memory exhaustion
   *   - Job type must be a non-empty string (max 100 chars)
   *   - Webhook URLs are URL-validated
   */
  enqueue(jobType, jobData, options = {}) {
    // Input validation
    if (typeof jobType !== 'string' || jobType.length === 0 || jobType.length > 100) {
      throw new Error('Job type must be a non-empty string (max 100 characters)');
    }

    if (jobData === null || typeof jobData !== 'object' || Array.isArray(jobData)) {
      throw new Error('Job data must be a non-array object');
    }

    // Security: Validate job data size (1MB limit)
    const jobDataSize = JSON.stringify(jobData).length;
    if (jobDataSize > 1024 * 1024) {
      throw new Error('Job data exceeds 1MB size limit');
    }

    // Validate and cap maxAttempts
    let maxAttempts = options.maxAttempts ?? 3;
    if (typeof maxAttempts !== 'number' || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive number');
    }
    maxAttempts = Math.max(1, Math.min(maxAttempts, 10)); // Cap at 10

    // Validate webhookUrl if provided
    if (options.webhookUrl) {
      this._validateWebhookUrl(options.webhookUrl);
    }

    // Create job with security-oriented defaults
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      type: jobType,
      data: jobData,
      status: 'pending',
      attempts: 0,
      maxAttempts,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      processedAt: null,
      webhookUrl: options.webhookUrl || null,
    };

    this.jobs.set(jobId, job);
    this.metrics.totalEnqueued++;

    return jobId;
  }

  /**
   * Retrieves a job by ID.
   * 
   * @param {string} jobId - The job ID to retrieve
   * @returns {Job|null} The job object or null if not found
   */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Retrieves all jobs with optional filtering.
   * 
   * @param {Object} [filter={}] - Filter criteria
   * @param {string} [filter.status] - Filter by status
   * @param {string} [filter.type] - Filter by job type
   * @returns {Job[]} Array of matching jobs
   */
  getAllJobs(filter = {}) {
    let jobs = Array.from(this.jobs.values());

    if (filter.status) {
      jobs = jobs.filter(j => j.status === filter.status);
    }

    if (filter.type) {
      jobs = jobs.filter(j => j.type === filter.type);
    }

    return jobs;
  }

  /**
   * Gets the next pending job to process.
   * 
   * @returns {Job|null} The first pending job or null if queue is empty
   */
  getNextPendingJob() {
    const pendingJobs = this.getAllJobs({ status: 'pending' });
    return pendingJobs.length > 0 ? pendingJobs[0] : null;
  }

  /**
   * Updates the status of a job.
   * 
   * @param {string} jobId - The job ID
   * @param {string} newStatus - New status ('processing', 'completed', 'failed', 'pending')
   * @param {Object} [metadata={}] - Additional metadata (error, processedAt, etc.)
   * @throws {Error} If job not found or status is invalid
   */
  updateJobStatus(jobId, newStatus, metadata = {}) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const validStatuses = ['pending', 'processing', 'completed', 'failed'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }

    job.status = newStatus;
    job.updatedAt = Date.now();

    if (metadata.lastError) {
      job.lastError = metadata.lastError;
    }

    if (metadata.processedAt !== undefined) {
      job.processedAt = metadata.processedAt;
    }

    if (metadata.attempts !== undefined) {
      job.attempts = metadata.attempts;
    }

    // Update metrics
    if (newStatus === 'completed') {
      this.metrics.totalCompleted++;
    } else if (newStatus === 'failed') {
      this.metrics.totalFailed++;
    }
  }

  /**
   * Acknowledge (complete) a job successfully.
   * 
   * @param {string} jobId - The job ID
   * @throws {Error} If job not found
   */
  ackJob(jobId) {
    this.updateJobStatus(jobId, 'completed');
  }

  /**
   * Negatively acknowledge (fail) a job.
   * 
   * @param {string} jobId - The job ID
   * @param {Error} error - The error that caused the failure
   * @throws {Error} If job not found
   */
  nackJob(jobId, error) {
    this.updateJobStatus(jobId, 'failed', { lastError: error });
  }

  /**
   * Requeues a failed job for retry.
   * 
   * @param {string} jobId - The job ID
   * @returns {boolean} True if requeued, false if max attempts exceeded
   * @throws {Error} If job not found
   */
  requeueJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.attempts >= job.maxAttempts) {
      return false;
    }

    job.status = 'pending';
    job.attempts += 1;
    job.updatedAt = Date.now();

    return true;
  }

  /**
   * Gets queue metrics.
   * 
   * @returns {Object} Metrics object with counts
   */
  getMetrics() {
    return {
      ...this.metrics,
      totalPending: this.getAllJobs({ status: 'pending' }).length,
      totalProcessing: this.getAllJobs({ status: 'processing' }).length,
    };
  }

  /**
   * Clears all jobs from the queue (for testing).
   * 
   * @security This should only be called in testing or during shutdown.
   */
  clear() {
    this.jobs.clear();
    this.metrics = {
      totalEnqueued: 0,
      totalCompleted: 0,
      totalFailed: 0,
    };
  }

  /**
   * Validates a webhook URL for security.
   * 
   * @private
   * @param {string} url - The URL to validate
   * @throws {Error} If URL is invalid or insecure
   * @security
   *   - Only allows http and https protocols
   *   - Prevents localhost in production
   *   - Prevents private IP ranges
   */
  _validateWebhookUrl(url) {
    try {
      const parsed = new URL(url);

      // Only allow http and https
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Webhook URL must use http or https protocol');
      }

      // Prevent private IPs and localhost
      const hostname = parsed.hostname;
      const isPrivate = /^(localhost|127\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[01]\.|192\.168\.)/.test(hostname);
      
      if (isPrivate && process.env.NODE_ENV === 'production') {
        throw new Error('Private IP addresses not allowed for webhooks in production');
      }
    } catch (error) {
      if (error.message.startsWith('Webhook URL')) {
        throw error;
      }
      throw new Error(`Invalid webhook URL: ${error.message}`);
    }
  }
}

module.exports = {
  JobQueue,
};
