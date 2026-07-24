# Persistence (Job Queue)

This document covers the durable persistence contract for the background job queue: `createJobPersistence()` in `src/workers/jobPersistence.js`, and how `JobQueue` (`src/workers/jobQueue.js`) calls into it.

There is no HTTP-facing `persistence` route in this codebase — persistence is an internal module contract used by the in-process job queue to survive restarts/crashes. This document describes that contract in full: function signatures, params, return/failure shapes, and exactly when each function is invoked.

## Overview

- **Module:** `src/workers/jobPersistence.js`
- **Backing table:** `background_jobs` (see `migrations/20260625000000_create_background_jobs.sql`)
- **Enabled via:** `JOB_QUEUE_PERSISTENCE_ENABLED=true` (checked in `src/workers/worker.js`). When unset/false, `JobQueue` runs in-memory only and none of this module's functions are called.
- **Consumers:** `src/workers/jobQueue.js` (calls all five functions) and `src/workers/worker.js` (triggers `restoreFromPersistence()` on `start()`, which internally calls `recoverUnackedJobs()`).

## `createJobPersistence(db, options)`

Factory that returns a persistence adapter bound to a given knex instance.

| Param | Type | Required | Description |
|-------|------|----------|--------------|
| `db` | `import('knex').Knex` | Yes | Knex instance used for all queries against `background_jobs`. |
| `options.maxRecoveryRows` | `number` | No | Max rows fetched per recovery call. Defaults to `1000`. Bounds the crash-recovery scan so startup is never blocked indefinitely. |

Returns an object with five methods: `persistJob`, `updateJobStatus`, `ackJob`, `recoverUnackedJobs`, `pruneCompleted`.

## Methods

### `persistJob(job)`

Inserts a newly enqueued job as a row.

- **Called from:** `JobQueue.enqueue()`, immediately after the job is pushed onto the in-memory queue.
- **Params:** `job` — the in-memory job object (`id`, `type`, `payload`, `status`, `priority`, `delayMs`, `createdAt`, `attempts`, etc).
- **Returns:** `Promise<void>`.
- **Failure behavior:** Fire-and-forget. Errors are caught, logged via `logger.error`, and never thrown or propagated to the caller — a DB failure here does not block enqueueing.

### `updateJobStatus(job)`

Updates the mutable fields of an existing row.

- **Called from three places in `JobQueue`:**
  - `dequeue()` — after a job transitions to `processing` (from both the retry queue and the main queue).
  - `retry(jobId, error)` — after a job transitions to `retrying` (with backoff `delayMs`) or `failed` (once `maxRetries` is exceeded).
- **Params:** `job` — the job object with its current `status`, `delayMs`, `startedAt`, `completedAt`, `attempts`, `lastError`.
- **Returns:** `Promise<void>`.
- **Failure behavior:** Same as `persistJob` — caught, logged, never thrown.

### `ackJob(jobId)`

Marks a row as completed and stamps `acked_at`, so crash-recovery will not replay it.

- **Called from:** `JobQueue.ack(jobId)`, after the job successfully completes and its in-memory status is set to `completed`.
- **Params:** `jobId` — `string`.
- **Returns:** `Promise<void>`.
- **Failure behavior:** Caught and logged, never thrown. Note: `JobQueue.ack()` itself throws synchronously (before this call) if the job doesn't exist or isn't in `processing` status — see [Error conditions](#error-conditions) below.

### `recoverUnackedJobs()`

Fetches jobs that were `pending`, `processing`, or `retrying` when the process last stopped (i.e. never acked), for re-enqueueing.

- **Called from:** `JobQueue.restoreFromPersistence()`, which itself runs when `BackgroundWorker.start()` is called and a persistence adapter is configured.
- **Params:** none.
- **Query behavior:** Selects rows where `status IN ('pending','processing','retrying')` and `acked_at IS NULL`, ordered by `created_at ASC`, bounded by `maxRecoveryRows`.
- **Returns:** `Promise<object[]>` — an array of job objects shaped for re-enqueue. Each recovered job has its `status` reset to `pending` and `startedAt`/`completedAt` cleared, regardless of what status it had before the crash — so an interrupted `processing` job is retried from scratch (at-least-once delivery, not exactly-once).
- **Payload sanitization:** Each row's `payload` is round-tripped through `JSON.parse(JSON.stringify())`. If a payload fails to sanitize (not valid JSON, or not a plain object), that job is skipped with a `logger.warn` and excluded from the returned array — it is not retried and not deleted from the table.
- **Failure behavior:** If the query itself fails, the error is logged and an empty array (`[]`) is returned — recovery never throws, so a DB outage at startup results in starting with an empty queue rather than blocking startup.

### `pruneCompleted(olderThanMs)`

Deletes old `completed`/`failed` rows to bound table growth.

- **Called from:** not currently called anywhere in `worker.js` or `jobQueue.js` — it's a maintenance function intended for a scheduled job (e.g. a cron-style cleanup), not wired into the request/processing path.
- **Params:** `olderThanMs` — `number`, age threshold in milliseconds (e.g. `86_400_000` for 24 hours).
- **Query behavior:** Deletes rows where `status IN ('completed','failed')` and `completed_at < (now - olderThanMs)`.
- **Returns:** `Promise<number>` — count of rows deleted. Returns `0` on failure as well as on a genuine zero-row match, so a `0` result alone doesn't distinguish "nothing to prune" from "the query failed."
- **Failure behavior:** Caught, logged, returns `0`.

## Error conditions

None of `jobPersistence.js`'s own functions throw — every DB error is caught and logged internally (see each method above). The observable failure modes are:

| Condition | Behavior |
|-----------|----------|
| DB insert/update/delete fails (`persistJob`, `updateJobStatus`, `ackJob`, `pruneCompleted`) | Logged via `logger.error`; function resolves normally with no return value / `0` for `pruneCompleted`. Caller is never blocked or rejected. |
| Recovery query fails (`recoverUnackedJobs`) | Logged; resolves to `[]`. |
| A recovered row's payload isn't valid JSON / not a plain object | Logged via `logger.warn`; that row is skipped and excluded from the returned array — it stays in the table, unacked, and will be picked up again on the next recovery attempt. |

Callers in `JobQueue` (`enqueue`, `ack`, `retry`, `dequeue`) can still throw their own synchronous errors independent of persistence — e.g. `ack(jobId)` throws `Job ${jobId} not found` or a status-mismatch error if called out of order. Those are `JobQueue` contract errors, not persistence errors, and occur regardless of whether persistence is enabled.

## Example: enqueue → process → ack lifecycle

```js
const { createJobPersistence } = require('./workers/jobPersistence');
const JobQueue = require('./workers/jobQueue');
const db = require('./db/knex');

const persistence = createJobPersistence(db, { maxRecoveryRows: 500 });
const queue = new JobQueue({ persistence });

// 1. Enqueue — INSERT via persistJob(job)
const jobId = queue.enqueue('webhook_delivery', { url: 'https://example.com/hook' });

// 2. Dequeue — UPDATE via updateJobStatus(job), status: 'processing'
const job = queue.dequeue();

// 3a. Success — UPDATE via ackJob(jobId), sets acked_at + status: 'completed'
queue.ack(job.id);

// 3b. Failure — UPDATE via updateJobStatus(job), status: 'retrying' or 'failed'
// queue.retry(job.id, new Error('delivery failed'));
```

## Example: crash recovery on startup

```js
const BackgroundWorker = require('./workers/worker');

const worker = new BackgroundWorker({ /* jobQueue with persistence configured */ });
worker.registerHandler('webhook_delivery', async (job) => { /* ... */ });

// Internally calls jobQueue.restoreFromPersistence() → persistence.recoverUnackedJobs()
// before the poll loop starts. Unacked jobs from before the crash are re-enqueued
// with status reset to 'pending'.
await worker.start();
```

## Example: scheduled cleanup

```js
// Not currently wired into any job or route — call manually or from a cron entrypoint.
const deletedCount = await persistence.pruneCompleted(24 * 60 * 60 * 1000); // 24h
```

## Schema reference

See `migrations/20260625000000_create_background_jobs.sql` for the full `background_jobs` table definition, including the `status` check constraint (`pending`, `processing`, `completed`, `failed`, `retrying`) and the recovery/cleanup indexes.

## Testing

There is currently no dedicated test file for `src/workers/jobPersistence.js`. Coverage for the surrounding `JobQueue`/`BackgroundWorker` call sites should be checked in the existing worker/queue test suites before relying on this contract in new code.
