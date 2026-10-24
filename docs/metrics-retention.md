# Metrics Data Retention

## Overview

This document describes what metrics and operational data are collected, where they are stored, how long they are retained, and how old data is purged. It also covers PII handling and the current state of retention implementation.

---

## 1. Prometheus Metrics (`GET /metrics`)

### What is collected

The application registers a Prometheus registry via `prom-client` in [`src/metrics.js`](../src/metrics.js). All metrics are **in-process counters, gauges, and histograms** — they are **not persisted** to any database.

| Category | Metrics | Type |
|---|---|---|
| **Job queue** | `liquifact_job_queue_depth`, `liquifact_job_retry_queue_size`, `liquifact_worker_inflight_count` | Gauge |
| **Escrow indexer** | `escrow_indexer_events_processed_total`, `escrow_indexer_events_skipped_total`, `escrow_indexer_cycle_failures_total`, `escrow_indexer_last_cursor_advance_timestamp_seconds` | Counter / Gauge |
| **Escrow reconciliation** | `escrow_reconciliation_mismatches_total`, `escrow_reconciliation_mismatched_invoices`, `escrow_reconciliation_drift_magnitude`, `escrow_reconciliation_drift_alerts_total` | Counter / Gauge |
| **Maturity reminders** | `maturity_reminder_delivery_attempts_total`, `maturity_reminder_delivery_success_total`, `maturity_reminder_dead_letter_total` | Counter |
| **Webhooks** | `webhook_replay_total`, `webhook_delivery_attempts_total`, `webhook_delivery_success_total`, `webhook_delivery_dead_letter_total` | Counter |
| **Soroban RPC** | `soroban_rpc_call_duration_seconds`, `soroban_rpc_retry_causes_total`, `soroban_circuit_breaker_state_transitions_total` | Histogram / Counter |
| **API key auth** | `api_key_auth_duration_seconds`, `api_key_auth_errors_total` | Histogram / Counter |
| **Caching** | `footprint_cache_hits_total`, `footprint_cache_misses_total`, `footprint_cache_evictions_total`, `escrow_read_cache_hits_total`, `escrow_read_cache_misses_total`, `escrow_read_cache_evictions_total`, `cache_store_errors_total`, `redis_cache_fail_open_total` | Counter |
| **Idempotency** | `idempotency_storage_failure_total`, `liquifact_idempotency_purge_rows_deleted_total`, `liquifact_idempotency_purge_runs_total`, `liquifact_idempotency_purge_duration_seconds` | Counter |
| **Health** | `health_request_duration_seconds`, `health_requests_total`, `health_request_errors_total`, `readiness_state` | Histogram / Counter / Gauge |
| **Metrics endpoint** | `metrics_request_duration_seconds`, `metrics_requests_total`, `metrics_request_errors_total` | Histogram / Counter |
| **KYC webhooks** | `kyc_webhook_request_duration_seconds`, `kyc_webhook_requests_total`, `kyc_webhook_errors_total` | Histogram / Counter |
| **Persistence** | `persistence_request_duration_seconds`, `persistence_requests_total`, `persistence_request_errors_total` | Histogram / Counter |
| **WASM contracts** | `contract_wasm_version_mismatch_alerts_total` | Counter |
| **Body size limits** | `body_size_limit_rejections_total` | Counter |

### Where they are stored

In-process memory only (the `prom-client` registry at `src/metrics.js:290`). Metrics are **never written to any database or file**.

### Retention

**No explicit retention mechanism exists.** Counter values accumulate monotonically from process start until restart. Gauge values are overwritten on each update. Histogram observations accumulate until restart.

- On **process restart**, all metric values reset to zero.
- `Node.js` default metrics (collected via `collectDefaultMetrics`) are also in-memory only.
- The periodic refresh (`METRIC_REFRESH_INTERVAL_MS` = 5 seconds) rereads queue/worker stats, but those values are ephemeral.

### Scheduled cleanup

None. There is no job or mechanism to purge Prometheus metrics within the lifetime of a process.

---

## 2. Per-Tenant SME Invoice Metrics (`GET /api/sme/metrics`)

### What is collected

Per-tenant invoice counts grouped by status, computed on-the-fly from the `invoices` database table.

### Where they are stored

**Not stored.** Computed at query time from the primary database via the `invoices` table.

### Retention

N/A — the data is ephemeral and reflects the current DB state.

---

## 3. Cache Metrics and Retention

### In-Memory Cache (`src/services/cacheStore.js`)

| Detail | Value |
|---|---|
| **Storage** | In-process `Map` with LRU eviction |
| **TTL** | Configurable per-key (caller-specified `ttlMs`) |
| **Max entries** | Default 5000, configurable via `maxEntries` |
| **Eviction** | LRU eviction when `size > maxEntries`; lazy expiry on `get()` / `keys()` |
| **Cleanup** | No background sweep — expired entries are cleaned lazily on access |
| **Persistence** | None — data is lost on process restart |

### Escrow Read Cache (`src/services/escrowReadCache.js`)

| Detail | Value |
|---|---|
| **Storage** | In-process bounded TTL cache (singleton) |
| **TTL** | Configurable via `ESCROW_CACHE_TTL_SECONDS` (default 30 s) |
| **Max entries** | Configurable via `ESCROW_CACHE_MAX_ENTRIES` (default 500) |
| **Eviction** | LRU eviction; lazy TTL expiry |
| **Cleanup** | No background sweep |

### Redis Escrow Summary Cache (`src/cache/redis.js`)

| Detail | Value |
|---|---|
| **Storage** | Redis (when `REDIS_ESCROW_CACHE_ENABLED=true`) |
| **TTL** | Configurable via `REDIS_ESCROW_CACHE_TTL_SECONDS` (default 30 s, clamped to 5–300 s) |
| **Eviction** | Redis `EX` flag on `SET`; ledger gap invalidation on `getSummary()` |
| **Cleanup** | Redis handles TTL expiry natively |
| **Circuit breaker** | Fail-open on Redis unavailability |

### KYC Status Cache (`src/services/kycService.js`)

- In-process TTL cache with configurable `KYC_STATUS_CACHE_TTL_MS`.
- No explicit cleanup; lazy eviction on access.

### Token Metadata Cache (`src/services/tokenMeta.js`)

- Uses `MemoryCacheStore` with `DEFAULT_CACHE_TTL_MS` of 30 minutes.
- Max 10 000 entries; LRU eviction.

---

## 4. Database Tables with Retention/Expiry Concerns

### 4.1 Idempotency Keys (`idempotency_keys`)

| Detail | Value |
|---|---|
| **Created by** | Idempotency middleware (`src/middleware/idempotency.js`) |
| **Expiry mechanism** | Each row has an `expires_at` timestamp |
| **Auto-deletion** | **No** — rows are never deleted by the application path |
| **Cleanup job** | `src/jobs/idempotencyPurge.js` — **auto-started** at boot in `src/index.js:98` |
| **Schedule** | Recurring timer via `schedulePurge()` (default interval: 1 hour) |
| **Purge query** | `DELETE ... WHERE expires_at < NOW()` in batches |
| **Batch size** | `IDEMPOTENCY_PURGE_BATCH_SIZE` (default 1000, max 10000) |
| **Max batches per run** | `IDEMPOTENCY_PURGE_MAX_BATCHES` (default 100, max 1000) |
| **Interval** | `IDEMPOTENCY_PURGE_INTERVAL_MS` (default 3600000 = 1 hour, min 60000) |
| **Metrics** | `liquifact_idempotency_purge_rows_deleted_total`, `liquifact_idempotency_purge_runs_total`, `liquifact_idempotency_purge_duration_seconds` |

### 4.2 Background Jobs (`background_jobs`)

| Detail | Value |
|---|---|
| **Persistence** | Opt-in via `JOB_QUEUE_PERSISTENCE_ENABLED=true` |
| **Cleanup** | `pruneCompleted(olderThanMs)` in `src/workers/jobPersistence.js:344` |
| **Usage** | Not called automatically — must be invoked explicitly |
| **Crash recovery** | `recoverUnackedJobs()` requeues `pending`/`processing`/`retrying` rows at startup |
| **Retention** | No automatic retention — completed/failed rows remain indefinitely unless `pruneCompleted` is called |

### 4.3 Webhook Dead Letters (`webhook_dead_letters`)

- **Created by** Webhook delivery system when all retries are exhausted.
- **No retention policy or cleanup job exists.**
- Rows accumulate indefinitely. There is no automated deletion.
- Migration: `20260602000000_create_webhook_dead_letters.sql`

### 4.4 Maturity Reminder Dead Letters (`maturity_reminder_dead_letters`)

- **Created by** Maturity reminder job when SMTP delivery fails after all retries.
- **No retention policy or cleanup job exists.**
- Rows accumulate indefinitely. There is no automated deletion.
- Migration: `20260628000000_create_maturity_reminder_dead_letters.sql`

### 4.5 Audit Logs (`audit_log_events`)

- **Created by** Audit middleware and business logic.
- **No retention policy or cleanup job exists.**
- The table is append-only (enforced by trigger).
- Rows accumulate indefinitely.

### 4.6 Retention System Tables

The following tables are part of the retention system (migration `20250425000000_create_retention_system.sql`):

#### `retention_policies`
- Defines per-tenant PII retention rules.
- No automatic cleanup; soft-delete via `deleted_at`.
- A default policy (7-year retention) is auto-created for new tenants via trigger.

#### `legal_holds`
- Prevents PII purging for invoices under legal investigation.
- Holds can have an `expires_at` — expired holds are filtered out at query time.
- **No automatic cleanup** of expired or released holds — rows remain indefinitely.

#### `retention_audit_log`
- Records every retention operation (purge, dry-run, hold placement/release).
- **No retention policy or cleanup job exists** — rows accumulate indefinitely.

#### `retention_job_executions`
- Records execution history of retention purge jobs.
- **No retention policy or cleanup job exists** — rows accumulate indefinitely.

---

## 5. PII Retention Purge Job

The PII retention purge job (`src/jobs/retentionPurge.js`) is the primary system for cleaning up Personally Identifiable Information from the `invoices` table.

### How it works

1. A retention policy defines a `retention_days` window and which PII fields to purge.
2. The job finds invoices where `created_at < NOW() - retention_days` and are not under legal hold.
3. PII fields are set to `NULL` in the `invoices` table.
4. Before purging, a hashed before-state is captured and stored in `retention_audit_log.old_values`.
5. Legal holds are checked both at query time and per-invoice just before purging.

### Supported PII fields

`customer_name`, `customer_email`, `customer_tax_id` (validated via `PiiFieldsSchema` in `src/jobs/retentionPurge.js:26`).

### Legal hold types

`litigation`, `investigation`, `audit`, `regulatory` (defined in migration and `legal_holds.hold_type` CHECK constraint).

### Execution model

- Dedicated `JobQueue` + `BackgroundWorker` with `maxConcurrency: 1`.
- Processing is started via `startQueueProcessing()` — **not auto-started** at boot.
- Jobs are scheduled by calling `scheduleRetentionPurge()` with a payload including `tenantId`, `policyId`, `dryRun`, etc.
- Supports dry-run mode for safe simulation.

### Current limitations

- The retention API route (`src/routes/retention.js`) is a stub — it returns **501 Not Implemented**.
- There is **no recurring cron/trigger** for automatic PII purging. The `purgeCron` field exists in the `retentionConfigSchema` (`src/schemas/config.js:214`) but is **not wired to any scheduler**.
- The retention purge worker must be started programmatically and jobs must be explicitly scheduled.

---

## 6. PII and Sensitive Data Handling

### PII stored in the `invoices` table

The following columns on the `invoices` table contain PII:
- `customer_name`
- `customer_email`
- `customer_tax_id`

These are the fields that the retention purge job sets to `NULL` after the retention period.

### Audit log redaction

`src/services/auditLogStore.js` redacts values matching these key patterns before storage:
`password`, `secret`, `token`, `api[-_]?key`, `authorization`, `private[-_]?key`, `seed`, `mnemonic`

Redacted value: `***REDACTED***`.

### Retention audit log hashing

Before destructive PII purging, original values are hashed with `sha256(invoiceId + ":" + JWT_SECRET + ":" + value)`. Clear text is **never** stored in the audit log.

### Sentry scrubbing

`src/observability/sentry.js` deep-scrubs all Sentry events for PII patterns including invoice IDs, JWTs, Stellar secrets, hex strings, and base64 payloads.

### Webhook secrets

- Stored in `tenants.settings` as `webhook_secret`.
- Never logged at info level.
- Job payloads are sanitized before DB persistence (keys matching `/(secret|token|password|api[_-]?key|authorization|credential)/i` are redacted in `src/workers/jobPersistence.js`).

### Job context allowlist

`src/workers/worker.js` extracts only `tenantId`, `invoiceId`, `correlationId`, `performedBy`, `policyId`, `batchSize` from payloads for error logs — all other fields (secrets, signing tokens, invoice bodies) are excluded.

---

## 7. Configuration Summary

| Variable / Config Field | Default | Affects |
|---|---|---|
| `METRICS_BEARER_TOKEN` | unset | Auth for `GET /metrics` |
| `ESCROW_CACHE_TTL_SECONDS` | 30 | In-memory escrow cache TTL (seconds) |
| `ESCROW_CACHE_MAX_ENTRIES` | 500 | In-memory escrow cache max entries |
| `REDIS_ESCROW_CACHE_ENABLED` | false | Enable Redis escrow summary cache |
| `REDIS_ESCROW_CACHE_TTL_SECONDS` | 30 | Redis cache TTL (clamped 5–300 s) |
| `REDIS_ESCROW_LEDGER_GAP_THRESHOLD` | 3 | Ledger gap for cache invalidation |
| `IDEMPOTENCY_PURGE_BATCH_SIZE` | 1000 | Idempotency key purge batch size |
| `IDEMPOTENCY_PURGE_INTERVAL_MS` | 3600000 | Idempotency purge interval (1 hour) |
| `IDEMPOTENCY_PURGE_MAX_BATCHES` | 100 | Max batches per idempotency purge run |
| `JOB_QUEUE_PERSISTENCE_ENABLED` | false | Enable DB-backed job persistence |
| `JOB_QUEUE_MAX_RECOVERY_ROWS` | 1000 | Max rows for crash recovery |
| Retention schema: `retentionDays` | 2555 (7 yr) | PII retention window (in db default policy) |
| Retention schema: `purgeEnabled` | (not set) | Enable automated purging (not wired) |
| Retention schema: `batchSize` | 100 | Rows per purge batch |
| Retention schema: `purgeCron` | (not set) | Cron expression (not wired to scheduler) |
| Retention schema: `legalHoldReasons` | (not set) | Allowlisted reason codes |
| `AUDIT_LOG_ENABLED` | true | Enable audit logging |
| `AUDIT_LOG_FAIL_CLOSED` | false | Fail closed on audit write failure |

---

## 8. Summary of Undocumented or Missing Implementation

| Item | Status |
|---|---|
| Prometheus metrics persistence | **Not persisted** — in-memory only; lost on restart |
| Webhook dead letter cleanup | **Not implemented** — rows accumulate indefinitely |
| Maturity reminder dead letter cleanup | **Not implemented** — rows accumulate indefinitely |
| Audit log retention/cleanup | **Not implemented** — rows accumulate indefinitely |
| Retention audit log cleanup | **Not implemented** — rows accumulate indefinitely |
| Retention job execution cleanup | **Not implemented** — rows accumulate indefinitely |
| Automatic scheduled PII purging | **Not wired** — `purgeCron` config exists but no scheduler attaches to it |
| Retention API CRUD endpoints | **Stub** — `POST /api/retention/legal-hold` returns 501 |
| Background job `pruneCompleted` auto-call | **Not wired** — function exists but is never called automatically |
| Legal hold row cleanup | **Not implemented** — expired/released holds remain in the table |
