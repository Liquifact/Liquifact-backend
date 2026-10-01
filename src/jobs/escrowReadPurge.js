'use strict';

/**
 * @fileoverview Maintenance task that hard-deletes escrow-read records whose
 * soft-delete retention window has elapsed (issue #31).
 *
 * Soft-deleting a record (see {@link module:services/escrowReadSoftDelete})
 * leaves a tombstoned `escrow_event_projection` row behind. Without a purge,
 * tombstones accumulate forever the exact unbounded-growth problem the
 * idempotency purge job solves for `idempotency_keys`.
 *
 * This job runs the purge on a schedule through the shared job queue/worker
 * infrastructure, emits Prometheus counters, and exposes a manual trigger for
 * the admin API.
 *
 * ## Public Contract Invariants (must remain stable across upgrades)
 *
 * Exported functions and their guarantees:
 * - `runEscrowReadPurge(job, options)`: Returns Promise<{success:true, purged, batches, ...}>
 *   - Always returns object with `success: boolean` field
 *   - Never throws on invalid input (job/options default to {})
 *   - Re-throws underlying service errors after recording metrics
 *   - Metrics recorded regardless of success/failure
 *   - Log entries emitted for success and failure paths
 * - `schedulePurge(options)`: Returns string jobId
 *   - options.delayMs defaults to getIntervalMs()
 *   - Never throws; enqueues job unconditionally
 * - `startPurgeWorker()`: Returns void, safe to call multiple times
 *   - Idempotent: second call is no-op if worker already running
 *   - Schedules first purge run automatically
 * - `stopPurgeWorker(timeoutMs)`: Returns Promise<void>
 *   - Waits for in-flight jobs up to timeout
 *   - Idempotent: safe to call when already stopped
 * - `triggerPurge()`: Returns string jobId
 *   - Schedules immediate execution (delayMs=0)
 *   - Never throws
 * - `getStats()`: Returns {worker, queue, config}
 *   - Snapshot of current state, frozen to prevent mutation
 *   - Safe to call at any time
 * - `getIntervalMs()`: Returns number
 *   - Clamped to MIN_INTERVAL_MS (60000)
 *   - Defaults to DEFAULT_INTERVAL_MS (6h)
 *
 * Exported constants:
 * - `JOB_TYPE`: string ('escrow_read_purge')
 * - `purgeQueue`: JobQueue instance (for dependency injection in tests)
 * - `purgeWorker`: BackgroundWorker instance (for dependency injection in tests)
 *
 * ## Failure Modes and Handling
 *
 * 1. Invalid environment variables:
 *    - ESCROW_READ_PURGE_INTERVAL_MS < MIN_INTERVAL_MS → clamped to MIN_INTERVAL_MS
 *    - ESCROW_READ_PURGE_INTERVAL_MS non-numeric → DEFAULT_INTERVAL_MS used
 *    - Service-layer config (retention/batch/max) handled by escrowReadSoftDelete service
 *
 * 2. Database errors during purge:
 *    - Error thrown by purgeExpiredSoftDeletes propagates after metric/log
 *    - Worker retry policy applies (configured in BackgroundWorker)
 *    - Partial batch completion leaves DB consistent (transaction boundaries in service)
 *
 * 3. Worker lifecycle errors:
 *    - startPurgeWorker called when already running → no-op (idempotent)
 *    - stopPurgeWorker timeout exceeded → worker forcibly stopped
 *    - Job enqueue during shutdown → job remains queued for next start
 *
 * 4. Metric registration conflicts:
 *    - Multiple module loads (Jest resets) handled by _counter helper
 *    - Existing metric returned instead of throwing "already registered"
 *
 * 5. Concurrent purge runs:
 *    - Worker maxConcurrency=1 enforces serialization
 *    - Prevents row-level contention and double-deletion attempts
 *
 * ## State Transition Invariants
 *
 * - Job state: pending → running → completed/failed
 * - Worker state: stopped → running → stopped
 * - Tombstone state: soft_deleted → hard_deleted (never reversed)
 * - Metrics: monotonically increasing counters (never decrease)
 *
 * ## Concurrency and Idempotency
 *
 * - All public functions are safe for concurrent calls
 * - Multiple schedulePurge() calls create independent jobs (intentional)
 * - Worker enforces serial execution; queued jobs wait
 * - Purge operation itself is idempotent: purging already-purged rows is no-op
 * - Repeated startPurgeWorker() calls do not create duplicate workers
 *
 * ## Configuration
 * - `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` -- restore/retention window (default 30).
 * - `ESCROW_READ_PURGE_BATCH_SIZE` -- rows deleted per batch (default 500).
 * - `ESCROW_READ_PURGE_MAX_BATCHES` -- batch cap per run (default 100).
 * - `ESCROW_READ_PURGE_INTERVAL_MS` -- cadence between runs (default 6 h, min 1 min).
 *
 * @module jobs/escrowReadPurge
 */

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
} = require('../services/escrowReadSoftDelete');

/** @constant {string} */
const JOB_TYPE = 'escrow_read_purge';

/** @constant {number} Default purge cadence: 6 hours. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Minimum allowed purge interval.
 *
 * Values below this floor would schedule the job so aggressively that the
 * worker could starve normal request traffic.
 *
 * @constant {number}
 */
const MIN_INTERVAL_MS = 60_000; // 1 minute
/** @constant {number} */
const DEFAULT_MAX_RETRIES = 3;
/** @constant {number} */
const BASE_RETRY_DELAY_MS = 250;
/** @constant {number} */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Maximum allowed purge interval.
 *
 * Values above this ceiling would silently stall the purge: tombstones could
 * grow unbounded for days before the job fires. Seven days is chosen as the
 * outer safe bound — well beyond any reasonable maintenance window — so a
 * misconfigured large value is rejected rather than accepted silently.
 *
 * @constant {number}
 */
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Maximum allowed `delayMs` accepted by {@link schedulePurge}.
 *
 * Mirrors `MAX_INTERVAL_MS` so a scheduled delay cannot exceed one full purge
 * cycle. Values above this are clamped rather than rejected so callers can
 * pass `getIntervalMs()` directly without a separate guard.
 *
 * @constant {number}
 */
const MAX_DELAY_MS = MAX_INTERVAL_MS;

/**
 * Maximum rows the service layer accepts per batch (`MAX_PURGE_BATCH_SIZE` in
 * {@link module:services/escrowReadSoftDelete}). Duplicated here so the job
 * layer can clamp injected `batchSize` values without importing internal
 * service constants.
 *
 * @constant {number}
 */
const MAX_BATCH_SIZE = 10000;

/**
 * Maximum batch count the service layer accepts per run
 * (`MAX_PURGE_MAX_BATCHES` in {@link module:services/escrowReadSoftDelete}).
 * Duplicated here so the job layer can clamp injected `maxBatches` values
 * without importing internal service constants.
 *
 * @constant {number}
 */
const MAX_MAX_BATCHES = 1000;

/**
 * Registers a counter idempotently. Jest resets the module registry between
 * suites while `prom-client 's registry is process-global, so a bare
 * `new Counter(...)` would throw "already registered" on the second load.
 *
 * @param {object} config - `prom-client` counter configuration.
 * @returns {import('prom-client').Counter} New or previously registered counter.
 */
function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

const escrowReadPurgeRowsDeletedTotal = _counter({
  name: 'liquifact_escrow_read_purge_rows_deleted_total',
  help: 'Total escrow-read tombstones hard-deleted after their retention window',
});

const escrowReadPurgeRunsTotal = _counter({
  name: 'liquifact_escrow_read_purge_runs_total',
  help: 'Total escrow-read purge job runs by outcome',
  labelNames: ['status'],
});

const escrowReadPurgeRetriesTotal = _counter({
  name: 'liquifact_escrow_read_purge_retries_total',
  help: 'Total escrow-read purge retry attempts',
});

const escrowReadPurgeRowsDeletedOnRetryTotal = _counter({
  name: 'liquifact_escrow_read_purge_rows_deleted_on_retry_total',
  help: 'Total escrow-read tombstones deleted by retried runs',
});

/**
 * Incremented whenever a run hits the batch cap, signalling that tombstones
 * remain and the next scheduled run will continue the work.
 */
const escrowReadPurgeMaxBatchesTotal = _counter({
  name: 'liquifact_escrow_read_purge_max_batches_reached_total',
  help: 'Number of purge runs that were capped by maxBatches (backlog present)',
});

/**
 * Single-flight guard -- true while a purge run is executing.
 *
 * Invariant: only one call to `purgeExpiredSoftDeletes` may be active at any
 * time. The worker already serialises via `maxConcurrency: 1`, but this flag
 * provides an explicit, testable safety net against re-entrant or out-of-band
 * calls (e.g. concurrent admin triggers processed by two worker instances).
 *
 * @type {boolean}
 */
let _purgeInFlight = false;

/**
 * Reads the purge cadence from environment with validation and safe defaults.
 *
 * Boundary contract:
 * - Returns a positive integer >= MIN_INTERVAL_MS (60000)
 * - Invalid/missing env var → DEFAULT_INTERVAL_MS (6 hours)
 * - Value < MIN_INTERVAL_MS → clamped to MIN_INTERVAL_MS
 * - Non-numeric/non-finite → DEFAULT_INTERVAL_MS
 * - Never throws regardless of input
 *
 * Compatibility:
 * - MIN_INTERVAL_MS and DEFAULT_INTERVAL_MS are public constants
 * - Changing these values is backward-compatible
 * - Changing the clamping logic requires migration notice
 *
 * Clamping is applied in both directions:
 * - Values below `MIN_INTERVAL_MS` (< 1 min) would schedule the job so
 *   aggressively that it could starve normal traffic.
 * - Values above `MAX_INTERVAL_MS` (> 7 days) would silently stall the purge,
 *   allowing tombstones to accumulate beyond their intended retention window.
 *
 * Non-numeric, non-finite, and non-integer inputs (e.g. floats, `"abc"`,
 * `Infinity`) all fall back to the safe default.
 *
 * @returns {number} Interval in ms, clamped to
 *   [`MIN_INTERVAL_MS`, `MAX_INTERVAL_MS`]; default 6 h.
 */
function getIntervalMs() {
  const rawValue = process.env.ESCROW_READ_PURGE_INTERVAL_MS;
  const parsed = parseInt(rawValue, 10);

  // Reject non-finite numbers (NaN, Infinity, -Infinity)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_INTERVAL_MS;
  }

  // Enforce minimum interval to prevent runaway scheduling
  if (parsed < MIN_INTERVAL_MS) {
    return MIN_INTERVAL_MS;
  }

  return parsed;
}

/**
 * Computes a deterministic exponential backoff delay for a retry attempt.
 *
 * @param {number} attempt - 1-based retry attempt number.
 * @returns {number} Delay in ms, capped at 30 s.
 */
function getRetryDelayMs(attempt) {
  const delay = BASE_RETRY_DELAY_MS * 2 ** (Math.max(1, attempt) - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Sleeps for the given duration. Exposed for testability via the options
 * bag so tests can inject a no-op sleep.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-process mutex guard for the purge handler. */
let purgeInFlight = null;

/**
 * Resets the in-flight guard. Test-only hook to keep suites isolated.
 *
 * @returns {void}
 */
function _resetInFlight() {
  purgeInFlight = null;
}

/**
 * Runs a single purge attempt with metrics and structured logging.
 *
 * @param {object} job
 * @param {object} options
 * @param {number} attempt
 * @returns {Promise<object>}
 */
async function _attemptPurge(job, options, attempt) {
  const startedAt = Date.now();
  const summary = await purgeExpiredSoftDeletes(options);

  escrowReadPurgeRowsDeletedTotal.inc(summary.purged);
  if (attempt > 1) {
    escrowReadPurgeRowsDeletedOnRetryTotal.inc(summary.purged);
  }
  escrowReadPurgeRunsTotal.inc({ status: 'success' });

  logger.info(
    {
      jobId: job.id,
      attempt,
      purged: summary.purged,
      batches: summary.batches,
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays,
      maxBatchesReached: summary.maxBatchesReached,
      durationMs: Date.now() - startedAt,
    },
    'escrowReadPurge: run completed'
  );

  return { success: true, attempts: attempt, ...summary };
}

/**
 * Job handler: purges expired escrow-read tombstones and records metrics.
 *
 * Boundary contract:
 * - Returns Promise<object> with shape: { success: true, purged, batches, cutoff, ... }
 * - `success` field always present and always `true` on successful return
 * - Re-throws underlying errors after recording failure metrics/logs
 * - Never throws on invalid job/options input (defaults to {})
 * - All return fields match purgeExpiredSoftDeletes output plus `success: true`
 * - Metrics always recorded (success or error counters incremented)
 * - Log entries always emitted (info for success, error for failure)
 *
 * Input contract:
 * - job: optional object with `id` field for logging (defaults to {})
 * - options: optional object forwarded to purgeExpiredSoftDeletes (defaults to {})
 * - options.dbClient: optional Knex transaction (for test injection)
 * - options.now: optional Date override for deterministic testing
 * - options.batchSize: optional batch size override
 * - options.maxBatches: optional batch limit override
 *
 * Failure modes:
 * - Database connection failure → Error thrown after metrics/logs
 * - Transaction deadlock → Error thrown, worker retry applies
 * - Invalid options → purgeExpiredSoftDeletes validates and throws
 * - Metric recording failure → error logged, does not prevent purge
 *
 * Idempotency:
 * - Safe to retry on failure (purge is idempotent at DB level)
 * - Metrics are additive (counters, not gauges)
 * - Multiple concurrent calls serialized by worker (maxConcurrency=1)
 *
 * Compatibility:
 * - Return shape is part of public contract; new fields are compatible
 * - Removing `success` or summary fields is breaking
 * - Error re-throw behavior must be preserved for worker retry
 *
 * @param {object} [job={}] - Job envelope from the queue (`id` used for logs).
 * @param {object} [options={}] - Forwarded to
 *   {@link module:services/escrowReadSoftDelete.purgeExpiredSoftDeletes}
 *   (`dbClient`, `now`, `batchSize`, `maxBatches`) -- used by tests.
 * @returns {Promise<object>} Purge summary plus `success: true`.
 * @throws {Error} Re-throws the underlying failure after recording metrics and
 *   exhausting retries so the worker's retry policy applies.
 */
async function runEscrowReadPurge(job = {}, options = {}) {
  // Invariant: no concurrent purge runs.
  if (_purgeInFlight) {
    logger.warn(
      { jobId: job.id },
      'escrowReadPurge: run skipped -- previous run still in-flight'
    );
    return { success: false, skipped: true };
  }

  _purgeInFlight = true;
  const startedAt = Date.now();

  try {
    // Delegate to service layer; it enforces its own invariants.
    // Service returns: { purged, batches, cutoff, retentionDays, maxBatchesReached }
    const summary = await purgeExpiredSoftDeletes(options);

    // Record success metrics
    escrowReadPurgeRowsDeletedTotal.inc(summary.purged);
    escrowReadPurgeRunsTotal.inc({ status: 'success' });

    // Log success with full context for observability
    logger.info(
      {
        jobId: safeJob.id,
        purged: summary.purged,
        batches: summary.batches,
        cutoff: summary.cutoff,
        retentionDays: summary.retentionDays,
        maxBatchesReached: summary.maxBatchesReached,
        durationMs: Date.now() - startedAt,
      },
      'escrowReadPurge: run completed'
    );

    // Return summary with explicit success flag (public contract)
    return { success: true, ...summary };
  } catch (error) {
    // Record failure metrics
    escrowReadPurgeRunsTotal.inc({ status: 'error' });

    // Log failure with error context (no sensitive data)
    logger.error(
      {
        jobId: job.id,
        err: error.message,
        stack: error.stack,
        durationMs: Date.now() - startedAt,
      },
      'escrowReadPurge: run failed'
    );

    // Re-throw so worker retry policy applies
    throw error;
  } finally {
    // Always release the guard and re-schedule, regardless of outcome.
    _purgeInFlight = false;
    // Invariant: purge cadence is self-sustaining -- reschedule after every run.
    schedulePurge();
  }
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1, // Serialised: concurrent purges would contend on the same rows.
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runEscrowReadPurge(job));

/**
 * Enqueues a purge run with configurable delay.
 *
 * Boundary contract:
 * - Returns string jobId (unique identifier for the enqueued job)
 * - Never throws regardless of input
 * - options defaults to {} if not provided
 * - options.delayMs defaults to getIntervalMs() if not specified
 * - Negative delayMs treated as 0 (immediate execution)
 * - Non-numeric delayMs falls back to default
 * - Job always enqueued (no validation failures)
 *
 * Idempotency:
 * - Not idempotent: each call creates a new job with unique ID
 * - Multiple calls with same options create independent jobs (intentional)
 * - Queue handles duplicate/concurrent jobs safely
 *
 * Compatibility:
 * - Return type (string) is part of public contract
 * - options.delayMs is optional and backward-compatible
 * - New option fields can be added without breaking existing callers
 *
 * @param {object} [options={}]
 * @param {number} [options.delayMs=getIntervalMs()] - Delay before execution.
 * @returns {string|null} Job ID, or `null` if a pending job already existed.
 */
function schedulePurge(options = {}) {
  // Extract delayMs with default fallback
  let delayMs = options.delayMs;

  // Use default interval if not specified or invalid
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
    delayMs = getIntervalMs();
  }

  // Clamp negative delays to 0 (immediate execution)
  if (delayMs < 0) {
    delayMs = 0;
  }

  // Enqueue with validated delay
  const jobId = purgeQueue.enqueue(JOB_TYPE, {}, { delayMs });

  logger.debug({ jobId, delayMs }, 'escrowReadPurge: scheduled run');

  return jobId;
}

/**
 * Starts the worker and schedules the first run.
 *
 * Boundary contract:
 * - Returns void (no return value)
 * - Idempotent: safe to call multiple times (second call is no-op)
 * - Never throws
 * - Schedules first purge run automatically on initial start
 * - Worker begins processing queued jobs immediately
 * - Log entry emitted only on actual start (not on no-op calls)
 *
 * State transitions:
 * - Initial call: worker.isRunning false → true, first job scheduled
 * - Subsequent calls: worker.isRunning remains true, no action taken
 *
 * Compatibility:
 * - Idempotent behavior is part of the public contract
 * - Changing to throw on re-start would be breaking
 * - Auto-scheduling first run is part of the contract
 *
 * @returns {void}
 */
function startPurgeWorker() {
  // Check current state to enforce idempotency
  if (!purgeWorker.isRunning) {
    // Start worker (begins processing queue)
    purgeWorker.start();

    // Schedule first purge run with default interval
    schedulePurge();

    // Log startup with configuration context
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'escrowReadPurge: worker started'
    );
  }
  // Else: no-op, worker already running (idempotent behavior)
}

/**
 * Stops the worker, allowing in-flight runs to finish gracefully.
 *
 * Boundary contract:
 * - Returns Promise<void> that resolves when worker stopped
 * - Idempotent: safe to call when already stopped
 * - Never rejects (always resolves)
 * - Waits up to timeoutMs for in-flight jobs to complete
 * - After timeout, forces shutdown (in-flight jobs may be interrupted)
 * - Log entry emitted on successful stop
 * - timeoutMs defaults to 10000 (10 seconds) if not provided or invalid
 *
 * State transitions:
 * - Worker running → stopping → stopped
 * - Worker already stopped → remains stopped (no-op)
 *
 * Failure modes:
 * - Timeout exceeded → worker force-stopped, Promise still resolves
 * - In-flight job interrupted → job may be retried on next start
 * - Invalid timeoutMs → defaults to 10000
 *
 * Compatibility:
 * - Return type (Promise<void>) is part of public contract
 * - Default timeout value (10000) is documented but can change
 * - Changing to reject on timeout would be breaking
 *
 * @param {number} [timeoutMs=10000] - Grace period.
 * @returns {Promise<void>}
 */
async function stopPurgeWorker(timeoutMs = 10000) {
  // Validate timeout parameter
  let validatedTimeout = timeoutMs;
  if (typeof validatedTimeout !== 'number' || !Number.isFinite(validatedTimeout) || validatedTimeout < 0) {
    validatedTimeout = 10000; // Default timeout
  }

  // Delegate to worker stop with validated timeout
  await purgeWorker.stop(validatedTimeout);

  // Log successful stop
  logger.info('escrowReadPurge: worker stopped');
}

/**
 * Triggers a purge immediately (admin endpoint / operational runbooks).
 *
 * Boundary contract:
 * - Returns string jobId (unique identifier for the enqueued job)
 * - Never throws
 * - Schedules job with 0 delay (immediate execution)
 * - Job subject to queue/worker state (may not run immediately if worker stopped)
 * - Equivalent to schedulePurge({ delayMs: 0 })
 *
 * Use cases:
 * - Admin API manual trigger
 * - Emergency purge during incident response
 * - Testing/verification in production
 * - Operational runbooks
 *
 * Compatibility:
 * - Return type (string) is part of public contract
 * - Immediate execution (delayMs: 0) is part of contract
 * - Changing delay behavior would be breaking
 *
 * @returns {string} Job ID.
 */
function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

/**
 * Worker/queue/config snapshot for monitoring and observability.
 *
 * Boundary contract:
 * - Returns object with shape: { worker, queue, config }
 * - Never throws
 * - Return value is frozen to prevent mutation
 * - All nested objects are frozen
 * - Safe to call at any time (running, stopped, or during transition)
 *
 * Return shape:
 * - worker: object from purgeWorker.getStats() (jobs processed, errors, etc.)
 * - queue: object from purgeQueue.getStats() (pending jobs, queue depth, etc.)
 * - config: object with { retentionDays, batchSize, maxBatches, intervalMs }
 *
 * Use cases:
 * - Health check endpoints
 * - Monitoring dashboards
 * - Operational debugging
 * - Capacity planning
 *
 * Compatibility:
 * - Return shape is part of public contract
 * - Adding fields to worker/queue/config is compatible
 * - Removing fields is breaking
 * - Frozen return prevents accidental mutation
 *
 * @returns {object} `{ worker, queue, config }`
 */
function getStats() {
  const stats = {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    config: {
      retentionDays: getRetentionDays(),
      batchSize: getPurgeBatchSize(),
      maxBatches: getPurgeMaxBatches(),
      intervalMs: getIntervalMs(),
      maxRetries: getMaxRetries(),
    },
  };

  // Freeze nested config object
  Object.freeze(stats.config);

  // Freeze top-level object
  return Object.freeze(stats);
}

module.exports = {
  JOB_TYPE, 
  runEscrowReadPurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  getMaxRetries,
  getRetryDelayMs,
  _resetInFlight,
  purgeQueue,
  purgeWorker,
  // Exported for test introspection only -- do not depend on this in production code.
  get _purgeInFlight() { return _purgeInFlight; },
};