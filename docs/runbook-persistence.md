# Persistence Subsystem Operations Runbook

Operator runbook for the LiquiFact backend **persistence subsystem**: the
durable background-job persistence layer that lets the in-process job queue
survive restarts and crashes. It covers configuration, common failure modes,
alerts, and recovery steps.

> **Scope note.** "Persistence" in this codebase refers to the durable job-queue
> contract in [`src/workers/jobPersistence.js`](../src/workers/jobPersistence.js),
> **not** an HTTP route. Invoice *file* persistence (S3 uploads) is a separate
> concern documented in [`storage-ops.md`](./storage-ops.md); the persistence
> module contract itself is specified in [`persistence.md`](./persistence.md).
> This runbook is the operational companion to those two documents.

---

## Architecture Overview

```
worker.start()
      |
      v
isPersistenceEnabled()            JOB_QUEUE_PERSISTENCE_ENABLED === "true"
      |                                   |
      | (enabled)                         | (unset/false)
      v                                   v
JobQueue.restoreFromPersistence()   in-memory only
      |                             (no DB, no recovery)
      v
recoverUnackedJobs()  -- bounded by maxRecoveryRows
      |
      v
background_jobs table (knex; sqlite3 dev/test, PostgreSQL prod)
```

The persistence adapter is created in
[`src/workers/worker.js`](../src/workers/worker.js) via
`createJobPersistence(db, { maxRecoveryRows })` and attached to the `JobQueue`.
On `start()`, if a persistence adapter is present, the queue restores unacked
jobs before the processing loop begins. When persistence is disabled the queue
runs purely in memory and none of the adapter functions are called.

---

## Configuration

All variables are read from the process environment. Only the persistence- and
job-queue-relevant ones are listed here; see [`configuration.md`](./configuration.md)
for the full inventory.

| Variable | Default | Purpose |
|----------|---------|---------|
| `JOB_QUEUE_PERSISTENCE_ENABLED` | unset (in-memory only) | Master switch. Must be exactly `true` (case-insensitive) to enable durable persistence and crash recovery. |
| `DATABASE_URL` | knexfile per-env | Connection string for the backing store holding `background_jobs`. sqlite3 in dev/test, PostgreSQL in production. |
| `CURSOR_SECRET` / `JWT_SECRET` | dev/test fallback | HMAC secret for signing job-list pagination cursors. Outside `development`/`test`, startup **throws** if neither is set. |
| `LOG_LEVEL` | `info` | pino log level for the structured logs emitted around persistence operations. |

Backing table: `background_jobs`, created by
[`migrations/20260625000000_create_background_jobs.sql`](../migrations/20260625000000_create_background_jobs.sql).
Run pending migrations with the project's standard migration command before
enabling persistence for the first time.

---

## Failure Modes

### 1. Persistence silently inactive

**Symptom:** jobs do not survive a restart; no rows ever appear in
`background_jobs`.

**Cause:** `JOB_QUEUE_PERSISTENCE_ENABLED` is unset or not exactly `true`.
`isPersistenceEnabled()` compares the lowercased value against `"true"`, so
values like `1`, `yes`, or `TRUE ` (with whitespace) leave the queue in-memory.

**Check:** confirm the effective env value; verify the adapter is attached by
checking startup logs for the restore step.

### 2. Startup throws on cursor secret

**Symptom:** process exits at boot with
`CURSOR_SECRET or JWT_SECRET must be configured for job cursor pagination
outside development/test`.

**Cause:** neither `CURSOR_SECRET` nor `JWT_SECRET` is set in a non-dev/test
environment.

**Fix:** provide one of the two secrets. They are also used elsewhere for auth,
so reuse the existing `JWT_SECRET` unless you need cursor-signing isolation.

### 3. Malformed / tampered pagination cursor

**Symptom:** job-list requests fail with a `JobCursorError` ("Malformed
cursor...", "Invalid cursor signature", "Cursor contains unknown sort field...").

**Cause:** a hand-edited, expired, or cross-environment cursor (signed with a
different secret) was supplied.

**Fix:** this is client-side and self-correcting — restart pagination from the
first page (omit the cursor). A sudden spike across many clients suggests a
rotated `CURSOR_SECRET`/`JWT_SECRET` invalidating in-flight cursors.

### 4. Backing-store unavailable

**Symptom:** persistence writes/reads throw; jobs process in memory but are not
durably recorded; recovery on the next restart is incomplete.

**Cause:** `DATABASE_URL` misconfigured, DB unreachable, or migrations not run
(`background_jobs` missing).

**Check:** verify DB connectivity and that the `background_jobs` migration has
been applied.

### 5. Bounded recovery truncation

**Symptom:** after a crash with a very large backlog, not all unacked jobs are
restored.

**Cause:** recovery is intentionally bounded by `maxRecoveryRows` (see
`getMaxRecoveryRows()` in `worker.js`) to avoid unbounded startup work.

**Fix:** this is by design. If the backlog legitimately exceeds the bound, raise
the limit deliberately and restart, or drain in batches.

---

## Alerts

Persistence-adjacent Prometheus alerts live in
[`prometheus-rules.yml`](./prometheus-rules.yml). The upload path that feeds
file persistence is guarded by body-size-limit alerts:

| Alert | Condition | Meaning |
|-------|-----------|---------|
| `BodySizeLimitRejectionRateHigh` | `sum(rate(body_size_limit_rejections_total[5m])) > 0.167` | Elevated 413 rejections across all limit types. |
| `BodySizeLimitRejectionRateCritical` | `sum(rate(body_size_limit_rejections_total[5m])) > 0.5` | Critical rejection rate; likely abuse or a misconfigured client. |
| `BodySizeLimitRejectionInvoiceHigh` | `rate(body_size_limit_rejections_total{type="invoice"}[5m]) > 0.167` | Sustained rejections on the invoice upload endpoint (limit ~512 KB). |
| `BodySizeLimitRejectionSustained` | `sum(increase(body_size_limit_rejections_total[1h])) > 3600` | Rejections sustained over an hour. |

Request-level telemetry for the persistence endpoints (duration, status class,
error cause) is exported by the instrumentation described in
[`observability-request-context.md`](./observability-request-context.md) via the
`persistence_request_duration_seconds`, `persistence_requests_total`, and
`persistence_request_errors_total` series on the `/metrics` endpoint. A rising
`persistence_request_errors_total{cause="storage"}` points at the object-storage
path ([`storage-ops.md`](./storage-ops.md)); `cause="internal"` points at
application logic.

---

## Recovery Steps

### Restore jobs after a crash or restart

1. Confirm `JOB_QUEUE_PERSISTENCE_ENABLED=true` in the environment.
2. Confirm the backing store is reachable and migrated (`background_jobs` exists).
3. Start the worker. On `start()`, `restoreFromPersistence()` runs automatically
   and calls `recoverUnackedJobs()` to re-enqueue jobs whose `acked_at` is null.
4. Verify from logs that the restore step reported the expected restored count.

### Recover from a wrong-store / missing-migration boot

1. Stop the process.
2. Fix `DATABASE_URL` and/or run pending migrations so `background_jobs` exists.
3. Restart; recovery re-runs on the next `start()`.

### Disable persistence for triage

Set `JOB_QUEUE_PERSISTENCE_ENABLED` to anything other than `true` (or unset it)
and restart. The queue runs in memory only — useful to isolate whether an
incident originates in the persistence layer or the job logic itself. Durability
and crash recovery are lost while disabled.

---

## Cross-References

- [`persistence.md`](./persistence.md) — full module contract: function
  signatures, params, return/failure shapes, invocation points.
- [`storage-ops.md`](./storage-ops.md) — object-storage (S3) operations for
  invoice file persistence.
- [`observability-request-context.md`](./observability-request-context.md) —
  request-scoped logging and correlation IDs.
- [`configuration.md`](./configuration.md) — complete environment-variable
  inventory.
- [`prometheus-rules.yml`](./prometheus-rules.yml) — alert definitions.