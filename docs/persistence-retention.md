# Persistence Data Retention

## Overview

This document describes what data the persistence system stores, where it is stored, retention windows, purge behavior, and how PII is handled. The persistence system encompasses SME invoice uploads, job queue persistence, and related infrastructure.

---

## 1. SME Invoice Uploads (`POST /api/sme/invoice/...`)

### What is stored

SME invoice uploads store file metadata and the uploaded file itself:

| Data | Storage Location | Description |
|---|---|---|
| **File metadata** | `invoice_files` table (PostgreSQL) | `tenant_id`, `invoice_id`, `s3_key`, `sha256`, `mime_type`, `size`, `created_at` |
| **File body** | S3-compatible object storage | The raw file bytes, keyed by `tenants/{tenantId}/invoices/{invoiceId}/{uuid}-{sanitizedName}` |
| **Presigned upload URL** | Ephemeral | Generated on demand; not persisted after the response is sent |

### Retention

| Detail | Value |
|---|---|
| **Metadata (invoice_files rows)** | No automatic retention policy. Rows accumulate indefinitely. |
| **File body (S3)** | No automatic lifecycle policy in the current application — S3 bucket lifecycle rules must be configured separately. |
| **Presigned URL** | Expires after 15 minutes (`DEFAULT_UPLOAD_URL_EXPIRY_SEC`). No server-side persistence. |

### PII handling

The uploaded file body may contain PII (e.g., customer names, tax IDs embedded in PDFs). The persistence layer does **not** inspect, redact, or purge file contents. PII management for invoice data is handled through the separate retention purge system (`src/jobs/retentionPurge.js`) which targets the `invoices` table.

### Purging

There is **no automated purging** of:
- `invoice_files` table rows
- S3 file objects

Administrators must implement external lifecycle policies (e.g., S3 lifecycle rules, manual database cleanup).

---

## 2. Job Queue Persistence (`JOB_QUEUE_PERSISTENCE_ENABLED=true`)

### What is stored

The `background_jobs` table stores job metadata:

| Column | Description |
|---|---|
| `id` | Unique job identifier |
| `type` | Job type string |
| `payload` | JSONB — job arguments (PII-sensitive fields are redacted before storage) |
| `status` | One of: `pending`, `processing`, `completed`, `failed`, `retrying` |
| `priority` | Job priority |
| `delay_ms` | Delay before job becomes available |
| `created_at` | When the job was created |
| `started_at` | When processing began |
| `completed_at` | When processing finished |
| `attempts` | Number of processing attempts |
| `last_error` | Last error message |
| `acked_at` | When the job was acknowledged (set on completion) |

### Retention

| Detail | Value |
|---|---|
| **Default** | No automatic retention — completed/failed rows remain indefinitely |
| **Prune function** | `pruneCompleted(olderThanMs)` in `src/workers/jobPersistence.js` deletes completed/failed rows older than the given threshold |
| **Auto-invocation** | **Not wired** to any scheduler or recurring timer |
| **Crash recovery** | `recoverUnackedJobs()` requeues `pending`/`processing`/`retrying` rows at startup |

### PII handling

Job payloads contain the `payload` JSONB column which may hold job arguments. Before storage, payloads are sanitized via `validatePayloadRoundTrip()` in `src/workers/persistenceValidation.js` which strips non-serialisable values. The `assertJobStructure()` helper in the same module validates required fields.

Job payload redaction: Keys matching `/(secret|token|password|api[_-]?key|authorization|credential)/i` are redacted in log output (see `src/workers/jobPersistence.js`).

### Purging

The `pruneCompleted()` function exists but is **never called automatically**. To enable purging, one of the following must be done:
1. Wire `pruneCompleted()` into a recurring scheduled job
2. Call it manually via an admin script or maintenance window
3. Configure an external database cleanup policy

---

## 3. Configuration Storage (Runtime Config)

### What is stored

| Data | Storage Location | Description |
|---|---|---|
| **Runtime configs** | Database (via `runtimeConfigSchema`) | Section-based configuration values (webhook, reconciliation, kyc, retention, fraud thresholds, CORS) |

### Retention

| Detail | Value |
|---|---|
| **Active records** | Retained until explicitly updated or deleted |
| **Soft-deleted records** | Retained for the retention window (configurable). After the window expires, the record is eligible for permanent deletion via the purge endpoint. |
| **Retention purge** | `POST /api/admin/config/purge` runs on-demand; not automatically scheduled |

### PII handling

Config values are application-level settings and should not contain PII. No PII-specific handling is applied.

---

## 4. Rate Limiting State (Persistence Rate Limiter)

### What is stored

| Data | Storage Location | Description |
|---|---|---|
| **Rate limit state** | In-memory (`persistence-ratelimit:` prefixed keys in the configured store) | Per-client request counts for the persistence rate limiter |

### Retention

| Detail | Value |
|---|---|
| **Storage** | In-memory store (resets on process restart) |
| **TTL** | Configurable via the rate limiter's `windowMs` (default: 60 seconds) |
| **Expiry** | Entries are automatically evicted by the rate limiter after the window expires |

### PII handling

Rate limit keys are derived from the client's API key or IP address. These are not stored beyond the rate limit window.

---

## 5. Persistence Metrics

### What is collected

The persistence system records Prometheus metrics via `src/middleware/persistenceMetrics.js`:

| Metric | Type | Description |
|---|---|---|
| `persistence_request_duration_seconds` | Histogram | Wall-clock duration of persistence requests |
| `persistence_requests_total` | Counter | Total persistence request count |
| `persistence_request_errors_total` | Counter | Persistence error count by cause |

### Retention

| Detail | Value |
|---|---|
| **Storage** | In-process Prometheus registry (in-memory only) |
| **Retention** | Metrics are ephemeral — reset on process restart |
| **Purging** | None — metrics accumulate from process start until restart |

### PII handling

Metric labels are bounded enums (endpoint, status class, cause). No raw input data is exposed in metric labels.

---

## 6. Configuration Summary

| Variable / Config Field | Default | Affects |
|---|---|---|
| `JOB_QUEUE_PERSISTENCE_ENABLED` | `false` | Enable DB-backed job persistence |
| `JOB_QUEUE_MAX_RECOVERY_ROWS` | 1000 | Max rows for crash recovery |
| `BODY_LIMIT_INVOICE` | `512kb` | Max upload size for invoice files |
| `S3_BUCKET` | `liquifact-invoices` | S3 bucket for file storage |
| `STORAGE_IN_MEMORY` | (test only) | Use in-memory fallback instead of S3 |
| `DEFAULT_UPLOAD_URL_EXPIRY_SEC` | 900 (15 min) | Presigned URL expiry |
| `LIST_JOBS_DEFAULT_LIMIT` | 20 | Default page size for job listing |
| `LIST_JOBS_MAX_LIMIT` | 100 | Maximum page size for job listing |

---

## 7. Undocumented or Missing Implementation

| Item | Status |
|---|---|
| `invoice_files` row cleanup | **Not implemented** — rows accumulate indefinitely |
| S3 object lifecycle policy | **Not configured** — must be set up externally |
| `pruneCompleted()` auto-invocation | **Not wired** — function exists but never called automatically |
| Config soft-delete auto-purge | **Not scheduled** — must be triggered manually via `POST /api/admin/config/purge` |
| Job payload automatic redaction | **Partial** — secrets are redacted in logs but full payloads are stored in JSONB |
| Persistence metrics persistence | **Not persisted** — in-memory only, lost on restart |
