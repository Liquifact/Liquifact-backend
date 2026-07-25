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
 *  - listJobs(opts)           — cursor-paginated listing of persisted jobs
 *
 * Security:
 *  - Payloads are stored as JSONB. On restore, each payload is re-validated
 *    through JSON.parse(JSON.stringify()) to strip any non-serialisable value
 *    that could have been injected between persist and restore.
 *  - Recovery is bounded by `maxRecoveryRows` (default 1 000) to prevent an
 *    unbounded DB scan from blocking startup.
 *  - All DB errors are caught and logged; they never crash the calling code.
 *  - listJobs cursors are opaque, HMAC-signed, and never expose raw DB values.
 *
 * @module workers/jobPersistence
 */

const crypto = require('crypto');
const logger = require('../logger');
const { validatePayloadRoundTrip } = require('./persistenceValidation');

/** Maximum rows fetched per recovery call (safety bound). */
const DEFAULT_MAX_RECOVERY_ROWS = 1_000;

/**
 * Default page size for {@link listJobs}.
 * @constant {number}
 */
const LIST_JOBS_DEFAULT_LIMIT = 20;

/**
 * Maximum page size for {@link listJobs}.
 * @constant {number}
 */
const LIST_JOBS_MAX_LIMIT = 100;

/**
 * Columns that the caller may sort by in {@link listJobs}.
 * Restricted to a known allowlist to prevent SQL injection via sort-field injection.
 * @constant {string[]}
 */
const LIST_JOBS_SORT_FIELDS = Object.freeze(['created_at', 'status', 'type', 'attempts']);

/**
 * Fallback HMAC secret used only in development / test environments.
 * Production must supply `CURSOR_SECRET` or `JWT_SECRET`.
 * @constant {string}
 */
const DEV_CURSOR_SECRET = 'dev-jobs-cursor-secret-change-in-prod';

// ── Cursor helpers ─────────────────────────────────────────────────────────

/**
 * Resolves the HMAC secret used to sign job listing cursors.
 * Uses `CURSOR_SECRET` or `JWT_SECRET` when set. Falls back to the public dev
 * constant only in `development` or `test` environments.
 *
 * @returns {string} HMAC secret.
 * @throws {Error} When no real secret is configured outside development/test.
 */
function _resolveJobCursorSecret() {
  const configured = process.env.CURSOR_SECRET || process.env.JWT_SECRET;
  if (configured) { return configured; }
  const env = process.env.NODE_ENV || 'development';
  if (env === 'development' || env === 'test') { return DEV_CURSOR_SECRET; }
  throw new Error('CURSOR_SECRET or JWT_SECRET must be configured for job cursor pagination outside development/test');
}

/**
 * Encodes an opaque, HMAC-signed cursor from a page-boundary row.
 *
 * The cursor payload captures the sort field value and row ID so the next
 * page query can use `>` / `<` keyset semantics rather than OFFSET.
 *
 * @param {object} params
 * @param {string} params.sortField  - The column being sorted by.
 * @param {*}      params.sortValue  - The sort-column value of the last row.
 * @param {string} params.id         - The primary key of the last row.
 * @param {string} params.order      - Sort direction ('asc' or 'desc').
 * @returns {string} base64url.sig opaque cursor string.
 */
function encodeJobCursor({ sortField, sortValue, id, order }) {
  const payload = JSON.stringify({
    sortField,
    sortValue,
    id,
    order,
    iat: Math.floor(Date.now() / 1000),
  });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig  = crypto.createHmac('sha256', _resolveJobCursorSecret()).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

/**
 * Decodes and verifies an opaque cursor produced by {@link encodeJobCursor}.
 *
 * @param {string} cursor - Cursor string from a previous response.
 * @returns {{ sortField: string, sortValue: *, id: string, order: string, iat: number }}
 * @throws {JobCursorError} When the cursor is malformed, tampered, or expired.
 */
function decodeJobCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.includes('.')) {
    throw new JobCursorError('Malformed cursor: expected base64url.signature format');
  }

  const dotIdx = cursor.lastIndexOf('.');
  const b64    = cursor.slice(0, dotIdx);
  const sig    = cursor.slice(dotIdx + 1);

  const expectedSig = crypto.createHmac('sha256', _resolveJobCursorSecret()).update(b64).digest('hex');

  // Constant-time comparison to prevent timing attacks.
  let sigBuf;
  let expectedBuf;
  try {
    sigBuf      = Buffer.from(sig, 'hex');
    expectedBuf = Buffer.from(expectedSig, 'hex');
  } catch {
    throw new JobCursorError('Malformed cursor: signature is not valid hex');
  }

  if (
    sigBuf.length !== expectedBuf.length ||
    sigBuf.length === 0 ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new JobCursorError('Invalid cursor signature');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw new JobCursorError('Malformed cursor: payload is not valid JSON');
  }

  const { sortField, sortValue, id, order, iat } = parsed;

  if (!LIST_JOBS_SORT_FIELDS.includes(sortField)) {
    throw new JobCursorError(`Cursor contains unknown sort field "${sortField}"`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new JobCursorError('Cursor is missing a valid id tiebreaker');
  }
  if (typeof iat !== 'number') {
    throw new JobCursorError('Cursor is missing issued-at timestamp');
  }
  if (order !== 'asc' && order !== 'desc') {
    throw new JobCursorError('Cursor contains invalid order direction');
  }

  return { sortField, sortValue, id, order, iat };
}

/**
 * Domain error for job cursor failures.
 * Callers should map this to an HTTP 400 response.
 */
class JobCursorError extends Error {
  /**
   * Creates a new JobCursorError with the given message.
   *
   * @param {string} message - Human-readable description of the cursor failure.
   */
  constructor(message) {
    super(message);
    this.name = 'JobCursorError';
  }
}

/**
 * Sanitises a job payload so it is safe to re-enqueue after recovery.
 * Strips non-serialisable values by round-tripping through JSON.
 *
 * Delegates to the shared {@link validatePayloadRoundTrip} helper so the
 * validation logic is defined in one place.
 *
 * @param {unknown} raw - The raw value read from the DB JSONB column.
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function sanitisePayload(raw) {
  return validatePayloadRoundTrip(raw);
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

  /**
   * Returns a cursor-paginated page of persisted background jobs.
   *
   * Pagination is keyset-based (no OFFSET): each page boundary is encoded as
   * an opaque HMAC-signed cursor.  The cursor captures the sort-column value
   * and row ID of the last item in the previous page.
   *
   * Supported sort fields: `created_at` (default), `status`, `type`, `attempts`.
   * Payload JSONB is intentionally excluded from the response to keep row sizes
   * small and to avoid leaking sensitive job arguments.
   *
   * @param {object}  [opts={}]
   * @param {number}  [opts.limit=20]          - Page size. Clamped to [1, 100].
   * @param {string}  [opts.cursor]            - Opaque cursor from previous page.
   * @param {string}  [opts.sortBy='created_at'] - Sort column.
   * @param {string}  [opts.order='desc']      - 'asc' or 'desc'.
   * @param {string}  [opts.status]            - Optional status filter.
   * @param {string}  [opts.type]              - Optional type filter.
   *
   * @returns {Promise<{
   *   data: object[],
   *   meta: {
   *     limit: number,
   *     hasMore: boolean,
   *     nextCursor: string|null,
   *   }
   * }>}
   *
   * @throws {JobCursorError} When the cursor string is invalid or tampered.
   */
  async function listJobs(opts = {}) {
    // ── Input normalisation & validation ────────────────────────────────────
    const rawLimit  = opts.limit;
    const rawSortBy = opts.sortBy;
    const rawOrder  = opts.order;

    // Clamp page size to [1, LIST_JOBS_MAX_LIMIT].
    const limit = Math.min(
      Math.max(1, Number.isInteger(rawLimit) ? rawLimit : parseInt(rawLimit ?? LIST_JOBS_DEFAULT_LIMIT, 10)),
      LIST_JOBS_MAX_LIMIT,
    );

    // Validate and default sort field.
    const sortBy = (typeof rawSortBy === 'string' && LIST_JOBS_SORT_FIELDS.includes(rawSortBy))
      ? rawSortBy
      : 'created_at';

    // Validate and default sort direction.
    const order = (rawOrder === 'asc' || rawOrder === 'desc') ? rawOrder : 'desc';

    // Optional equality filters (reject non-string to avoid prototype pollution).
    const statusFilter = typeof opts.status === 'string' ? opts.status : undefined;
    const typeFilter   = typeof opts.type   === 'string' ? opts.type   : undefined;

    // ── Cursor decoding ──────────────────────────────────────────────────────
    let decodedCursor = null;
    if (opts.cursor != null) {
      // throws JobCursorError on any tampering — propagate to caller
      decodedCursor = decodeJobCursor(opts.cursor);
    }

    // ── Build base query ─────────────────────────────────────────────────────
    // Fetch (limit + 1) rows to determine whether a next page exists without
    // an extra COUNT(*) round-trip.
    const query = db('background_jobs')
      .select(
        'id',
        'type',
        'status',
        'priority',
        'delay_ms',
        'created_at',
        'started_at',
        'completed_at',
        'attempts',
        'last_error',
        'acked_at',
        // payload intentionally excluded — may contain sensitive job arguments
      )
      .limit(limit + 1);

    if (statusFilter !== undefined) {
      query.where('status', statusFilter);
    }
    if (typeFilter !== undefined) {
      query.where('type', typeFilter);
    }

    // ── Keyset cursor predicate ───────────────────────────────────────────────
    // For (sortField, id) keyset navigation:
    //   asc:  next page = rows where (sortValue, id) > (cursor.sortValue, cursor.id)
    //   desc: next page = rows where (sortValue, id) < (cursor.sortValue, cursor.id)
    //
    // The tiebreaker on `id` ensures stable pagination even when multiple rows
    // share the same sort-column value.
    if (decodedCursor !== null) {
      const { sortField, sortValue, id: cursorId, order: cursorOrder } = decodedCursor;

      // Guard: cursor order must match the requested order.
      if (cursorOrder !== order) {
        throw new JobCursorError(
          `Cursor order "${cursorOrder}" does not match requested order "${order}"`,
        );
      }

      if (order === 'asc') {
        query.where(function () {
          this.where(sortField, '>', sortValue)
            .orWhere(function () {
              this.where(sortField, '=', sortValue).where('id', '>', cursorId);
            });
        });
      } else {
        query.where(function () {
          this.where(sortField, '<', sortValue)
            .orWhere(function () {
              this.where(sortField, '=', sortValue).where('id', '<', cursorId);
            });
        });
      }
    }

    // Primary sort on the requested column, secondary tiebreaker on id.
    query.orderBy(sortBy, order).orderBy('id', order);

    // ── Execute & build response ─────────────────────────────────────────────
    const rows    = await query;
    const hasMore = rows.length > limit;
    const data    = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1];
      nextCursor = encodeJobCursor({
        sortField: sortBy,
        sortValue: last[sortBy],
        id:        last.id,
        order,
      });
    }

    return {
      data,
      meta: {
        limit,
        hasMore,
        nextCursor,
      },
    };
  }

  return { persistJob, updateJobStatus, ackJob, recoverUnackedJobs, pruneCompleted, listJobs };
}

module.exports = {
  createJobPersistence,
  sanitisePayload,
  encodeJobCursor,
  decodeJobCursor,
  JobCursorError,
  LIST_JOBS_DEFAULT_LIMIT,
  LIST_JOBS_MAX_LIMIT,
  LIST_JOBS_SORT_FIELDS,
};
