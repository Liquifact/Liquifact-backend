'use strict';

/**
 * @fileoverview Durable persistence helpers for JobQueue.
 *
 * This module is only active when `JOB_QUEUE_PERSISTENCE_ENABLED=true`.
 * It wraps the `background_jobs` table (via knex) and exposes the minimal
 * surface needed by JobQueue:
 *
 *  - persistJob(job)          — INSERT on enqueue
 *  - updateJobStatus(job)     — UPDATE status / timestamps / error fields
 *  - ackJob(jobId)            — mark acked_at so crash-recovery skips the row
 *  - recoverUnackedJobs(opts) — SELECT rows that need requeuing after a crash
 *  - pruneCompleted(olderThanMs) — DELETE stale completed/failed rows
 *
 * Security:
 *  - Payloads are stored as JSONB. On restore, each payload is re-validated
 *    through JSON.parse(JSON.stringify()) to strip any non-serialisable value
 *    that could have been injected between persist and restore.
 *  - Recovery is bounded by `maxRecoveryRows` (default 1 000) to prevent an
 *    unbounded DB scan from blocking startup.
 *  - All DB errors are caught and logged; they never crash the calling code.
 *
 * @module workers/jobPersistence
 */

const logger = require('../logger');

/** Maximum rows fetched per recovery call (safety bound). */
const DEFAULT_MAX_RECOVERY_ROWS = 1_000;

/**
 * Sanitises a job payload so it is safe to re-enqueue after recovery.
 * Strips non-serialisable values by round-tripping through JSON.
 *
 * @param {unknown} raw - The raw value read from the DB JSONB column.
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function sanitisePayload(raw) {
  try {
    // JSONB is always valid JSON, but we defensively round-trip anyway.
    const serialised = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(serialised);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'payload must be a plain object' };
    }
    return { ok: true, payload: parsed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Maps a JobQueue job object to a `background_jobs` row.
 *
 * @param {object} job - JobQueue internal job object.
 * @returns {object} Knex insert/update-ready row.
 */
function toRow(job) {
  return {
    id:           job.id,
    type:         job.type,
    payload:      JSON.stringify(job.payload),
    status:       job.status,
    priority:     job.priority,
    delay_ms:     job.delayMs,
    created_at:   job.createdAt,
    started_at:   job.startedAt   ?? null,
    completed_at: job.completedAt ?? null,
    attempts:     job.attempts,
    last_error:   job.lastError   ?? null,
    acked_at:     null,
  };
}

/**
 * Creates a persistence adapter backed by the `background_jobs` table.
 *
 * @param {import('knex').Knex} db - Knex instance.
 * @param {object} [options]
 * @param {number} [options.maxRecoveryRows=1000] - Max rows fetched on recovery.
 * @returns {JobPersistence}
 */
function createJobPersistence(db, options = {}) {
  const maxRecoveryRows = options.maxRecoveryRows ?? DEFAULT_MAX_RECOVERY_ROWS;

  /**
   * Persists a newly enqueued job.
   * Fire-and-forget: errors are logged but never propagate to the caller.
   *
   * @param {object} job - The job returned by `JobQueue.enqueue`.
   * @returns {Promise<void>}
   */
  async function persistJob(job) {
    try {
      await db('background_jobs').insert(toRow(job));
    } catch (err) {
      logger.error({ err, jobId: job.id }, '[jobPersistence] Failed to persist job');
    }
  }

  /**
   * Updates mutable fields on an existing persisted job row.
   * Called after dequeue, retry, and failure transitions.
   *
   * @param {object} job - The job object after its state has changed.
   * @returns {Promise<void>}
   */
  async function updateJobStatus(job) {
    try {
      await db('background_jobs')
        .where({ id: job.id })
        .update({
          status:       job.status,
          delay_ms:     job.delayMs,
          started_at:   job.startedAt   ?? null,
          completed_at: job.completedAt ?? null,
          attempts:     job.attempts,
          last_error:   job.lastError   ?? null,
        });
    } catch (err) {
      logger.error({ err, jobId: job.id }, '[jobPersistence] Failed to update job status');
    }
  }

  /**
   * Stamps `acked_at` on the row so crash-recovery skips it.
   * Must be called after the in-memory ack succeeds.
   *
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async function ackJob(jobId) {
    try {
      await db('background_jobs')
        .where({ id: jobId })
        .update({ status: 'completed', acked_at: Date.now() });
    } catch (err) {
      logger.error({ err, jobId }, '[jobPersistence] Failed to ack job');
    }
  }

  /**
   * Returns unacked jobs that were PENDING, PROCESSING, or RETRYING when the
   * process last crashed.  Rows already having `acked_at` set are excluded.
   *
   * The result is bounded by `maxRecoveryRows` to prevent an unbounded scan.
   *
   * @returns {Promise<object[]>} Array of plain job objects ready for re-enqueue.
   */
  async function recoverUnackedJobs() {
    try {
      const rows = await db('background_jobs')
        .whereIn('status', ['pending', 'processing', 'retrying'])
        .whereNull('acked_at')
        .orderBy('created_at', 'asc')
        .limit(maxRecoveryRows)
        .select('*');

      const recovered = [];
      for (const row of rows) {
        const result = sanitisePayload(row.payload);
        if (!result.ok) {
          logger.warn(
            { jobId: row.id, reason: result.error },
            '[jobPersistence] Skipping job with invalid payload during recovery'
          );
          continue;
        }

        recovered.push({
          id:           row.id,
          type:         row.type,
          payload:      result.payload,
          status:       'pending',        // reset; will be set to PROCESSING on next dequeue
          priority:     row.priority,
          delayMs:      row.delay_ms,
          createdAt:    row.created_at,
          startedAt:    null,             // clear in-flight marker
          completedAt:  null,
          attempts:     row.attempts,
          lastError:    row.last_error ?? null,
        });
      }

      return recovered;
    } catch (err) {
      logger.error({ err }, '[jobPersistence] Recovery query failed; starting with empty queue');
      return [];
    }
  }

  /**
   * Deletes completed and failed rows older than `olderThanMs` milliseconds.
   * Safe to call periodically; errors are swallowed.
   *
   * @param {number} olderThanMs - Age threshold in milliseconds (e.g. 86_400_000 for 24 h).
   * @returns {Promise<number>} Number of rows deleted.
   */
  async function pruneCompleted(olderThanMs) {
    try {
      const cutoff = Date.now() - olderThanMs;
      const deleted = await db('background_jobs')
        .whereIn('status', ['completed', 'failed'])
        .where('completed_at', '<', cutoff)
        .del();
      return deleted;
    } catch (err) {
      logger.error({ err }, '[jobPersistence] Prune query failed');
      return 0;
    }
  }

  return { persistJob, updateJobStatus, ackJob, recoverUnackedJobs, pruneCompleted };
}

module.exports = { createJobPersistence, sanitisePayload };
