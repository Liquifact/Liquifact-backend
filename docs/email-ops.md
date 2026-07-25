# Email Operations for Settlement Reminders

The internal backend uses a customized background job worker architecture to send email notifications without holding up critical HTTP requests. It separates the presentation (template strings) from the logical workflow (job queueing).

## Configuration

By default, the worker runs in a **dry-run** logging mode to provide transparent observability during local development and CI test runs. It seamlessly switches to a production-grade SMTP transport when credentials are provided in the environment variables (e.g., via `.env`).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | No | unset | SMTP server hostname. When absent the system runs in dry-run mode. |
| `SMTP_PORT` | No | `587` | SMTP server port. |
| `SMTP_USER` | No | unset | SMTP authenticated username. |
| `SMTP_PASS` | No | unset | SMTP authenticated password. Never logged. |
| `SMTP_FROM` | No | `noreply@liquifact.com` | Sender address used in the `From` header. |
| `SMTP_MAX_RETRIES` | No | `3` | Maximum delivery attempts for transient failures. Clamped to 1–10. |

When `SMTP_HOST` is unset the system operates in **dry-run mode**: emails are logged to the console (to, subject, and text only) and no real SMTP connection is opened. SMTP credentials are never written to any log line in either mode.

## Delivery Resiliency

Maturity reminder emails include built-in resiliency to handle transient failures without losing messages or crashing the background worker.

### Exponential Backoff

Each transient failure triggers an automatic retry with exponential backoff:
- Base delay of ~1 second, doubling on each subsequent attempt.
- Maximum delay is capped at the `maxDelay` parameter of `withRetry` (60 s hard cap).
- ±20% jitter is added to each delay to prevent thundering-herd effects.
- The number of attempts is bounded by `SMTP_MAX_RETRIES` (default 3, clamped to 1–10).

### Error Classification

Before deciding whether to retry, each SMTP error is classified as **permanent** or **transient** by `isPermanentSmtpError` in `src/utils/retry.js`:

**Permanent errors (no retry — dead-lettered immediately):**
- SMTP 5xx responses (550–554): invalid recipient, policy rejection, quota exceeded.
- Error message patterns: "invalid recipient", "user unknown", "mailbox not found", "domain not found".
- Error codes: `EBADRQC`, `EDQUOT`.

**Transient errors (retried with backoff):**
- SMTP 4xx responses (421–429): temporary service unavailable.
- Network errors: `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`.
- Any error not matching a permanent pattern.

The raw SMTP error message is never written to logs or Prometheus labels; only the bounded `normalizeReminderReason` output is used.

### Dead-Lettering

When a reminder exhausts all retries or encounters a permanent error:
1. The Prometheus counter `maturity_reminder_dead_letter_total` is incremented with a bounded `reason` label.
2. A **sanitized** record is written asynchronously to `maturity_reminder_dead_letters` for durable operator inspection.
3. The write is fire-and-forget: a database outage writes a `warn` log but never stalls the reminder handler or crashes the worker.

Dead-letter records contain only operational metadata — **no PII**:

| Column | Value |
|--------|-------|
| `id` | Auto-generated primary key |
| `job_id` | Background job identifier |
| `invoice_id` | Invoice associated with the failed reminder |
| `reason` | Bounded failure category (`smtp_timeout`, `smtp_reject`, `template_error`, `unknown`) |
| `attempts` | Number of SMTP delivery attempts made |
| `payload_metadata` | `{"jobType":"maturity_reminder","targetDate":"..."}` only |
| `created_at` | Database insertion timestamp |

Recipient email, customer name, invoice amount, generated email body, and raw SMTP error text are **deliberately excluded**.

### Inspecting Dead Letters

```javascript
const { listReminderDeadLetters } = require('./src/jobs/maturityReminders');

// Newest failures first; limit is capped at 200.
const failures = await listReminderDeadLetters({ limit: 50 });

// Narrow an investigation to one bounded failure category.
const timeouts = await listReminderDeadLetters({
  reason: 'smtp_timeout',
  limit: 50,
});
```

Dead letters survive application restarts (stored in the database). An empty result is returned as `[]`.

## Metrics

Three Prometheus counters track reminder delivery:

| Metric | Labels | Description |
|--------|--------|-------------|
| `maturity_reminder_delivery_attempts_total` | `job_type=maturity_reminder` | Total delivery attempts (each retry counts) |
| `maturity_reminder_delivery_success_total` | `job_type=maturity_reminder` | Successfully delivered reminders |
| `maturity_reminder_dead_letter_total` | `job_type`, `reason` | Dead-lettered reminders (reason: `permanent_error` or `max_retries_exceeded`) |

Example queries:
```prometheus
# Success rate (%)
(rate(maturity_reminder_delivery_success_total[5m]) / rate(maturity_reminder_delivery_attempts_total[5m])) * 100

# Dead-letter rate
rate(maturity_reminder_dead_letter_total[5m])

# Permanent vs transient failures
sum by (reason) (rate(maturity_reminder_dead_letter_total[5m]))
```

## Memory Footprint of the Invoice Map
Our job execution manages `cancellable jobs`. E.g., if an invoice is settled well before the maturity date, we should refrain from bothering the end-user with a reminder. We achieve this with a localized map mapping `invoiceId`s to `jobId`s.
The localized map does not pose a significant memory constraint since successful deliveries cleanly evict mapped keys, keeping state extremely lightweight.

Dead letters are stored in the database and inspection queries are capped at 200 rows per call.

## Code Interactions

### `scheduleReminder(invoice, targetDate, email)`
Schedules the async delivery to the particular email at `targetDate` using our exponential backoff job queue underneath.
It handles deduplication seamlessly: re-scheduling a reminder manually drops the old intent from the queue instantly.

### `cancelReminder(invoiceId)`
A straightforward utility for the Express controller. Pass the invoice ID if the invoice is successfully settled entirely, which prunes it off the BackgroundWorker's waiting block.

### `listReminderDeadLetters(options)`
Queries durable dead letters, newest first. Supported options are `limit` (default 50, maximum 200) and `reason`.

## Testing manually using Node.js REPL

You can test this easily manually without triggering full test suites:
```javascript
const {
  scheduleReminder,
  startQueueProcessing,
  templates,
  listReminderDeadLetters
} = require('./src/jobs/maturityReminders');

startQueueProcessing();

const simulatedInvoice = { id: 'test_123', customer: 'Alice', amount: 50 };
// Schedules immediately (since it's in the past)
scheduleReminder(simulatedInvoice, new Date(), 'alice@example.com');

// After a few seconds, query durable dead letters (if delivery failed)
setTimeout(async () => {
  console.log('Dead letters:', await listReminderDeadLetters({ limit: 20 }));
}, 2000);
```

---

# SME Invoice Upload Security Hardening

## Overview

The SME invoice upload flow has been hardened to prevent abuse of presigned S3 URLs. The hardening covers MIME type validation, file size enforcement, tenant/invoice-scoped key generation, bounded URL expiry, and path traversal prevention.

## Accepted MIME Types

Only the following MIME types are accepted for invoice uploads:
- `application/pdf`
- `image/jpeg`
- `image/png`
- `image/tiff`

Any other MIME type is rejected with a `400 Bad Request` response.

## File Size Limit

Uploads are limited to **512 KB** (configurable via `BODY_LIMIT_INVOICE` environment variable), consistent with the existing body size guardrail.

## Key Scoping

Object keys are generated in the format:
```
tenants/{tenantId}/invoices/{invoiceId}/{uuid}-{sanitized-filename}
```

This ensures:
- Multi-tenant isolation: files from different tenants cannot collide
- Per-invoice scoping: all files for an invoice share a prefix
- Unpredictable naming: UUID prefix prevents enumeration

## Path Traversal Prevention

All filenames are sanitized before key generation:
- Only the basename is extracted (directory components are stripped)
- Null bytes (`\0`) are removed
- `..` sequences are removed
- Special characters (`<>:"|?*\/`) are replaced with `_`
- Filenames are truncated to 255 characters

## Presigned URL Expiry

- **Upload URLs**: 15 minutes TTL (short window reduces abuse surface)
- **Download URLs**: 1 hour default TTL, maximum 24 hours
- TTL is enforced server-side; credentials are never exposed to clients

## Security Considerations

1. **No credential leakage**: AWS credentials are never returned in API responses or logged
2. **Server-side validation**: MIME type and file size are validated before URL generation, not just at upload time
3. **Content-Type enforcement**: The presigned URL includes the Content-Type constraint, so S3 will reject mismatched types
4. **Content-Length enforcement**: The presigned URL includes the file size, so S3 will reject oversized uploads
5. **Error messages are safe**: Error responses do not leak internal state or stack traces

## Endpoints

### POST /api/sme/invoice/presigned-url
Request a presigned upload URL for direct-to-S3 upload.

Request body:
```json
{
  "fileName": "invoice.pdf",
  "mimeType": "application/pdf",
  "fileSize": 102400,
  "invoiceId": "optional-invoice-id"
}
```

### POST /api/sme/invoice
Direct upload via multipart form (multer), validated server-side.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | AWS region for S3 |
| `S3_ENDPOINT` | - | S3-compatible endpoint (e.g., MinIO) |
| `AWS_ACCESS_KEY_ID` | - | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | - | S3 secret key |
| `S3_BUCKET` | `liquifact-invoices` | S3 bucket name |
| `BODY_LIMIT_INVOICE` | `512kb` | Max invoice file size |

---

## Observability — Prometheus Metrics

Two counters are emitted per delivery attempt. Both carry **bounded** label sets to prevent Prometheus time-series cardinality explosion.

### `maturity_reminder_delivery_attempts_total`

Incremented once per attempt, regardless of outcome.

**Labels:**

| Label      | Allowed values                                          |
|------------|---------------------------------------------------------|
| `reason`   | `smtp_timeout`, `smtp_reject`, `template_error`, `unknown` |
| `job_type` | `maturity_reminder`, `unknown`                          |

On a successful send the `reason` label is `unknown` (no failure to categorise).

### `maturity_reminder_dead_letter_total`

Incremented only when the job handler throws (i.e. the message is dead-lettered).

**Labels:** same as above, with `reason` populated by the failure class.

### Reason normalisation

Raw SMTP error strings are **never** written directly to a label. The `normalizeReminderReason` helper (in `src/metrics.js`) maps them to one of the four bounded values:

| Raw error pattern                             | Label value      |
|-----------------------------------------------|------------------|
| "timeout", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "connect" | `smtp_timeout` |
| "reject", "550"–"554", "421"–"452", "EAUTH"  | `smtp_reject`    |
| "template"                                    | `template_error` |
| Everything else / non-string / empty          | `unknown`        |

**PII guarantee:** the raw error message is never stored in any label value. No recipient email address or invoice content can appear in Prometheus time series.

### Dashboard / alert queries

```promql
# Delivery failure rate (5 m window)
rate(maturity_reminder_dead_letter_total[5m])

# SMTP timeouts in the last hour
increase(maturity_reminder_dead_letter_total{reason="smtp_timeout"}[1h])

# Total attempts by job type
rate(maturity_reminder_delivery_attempts_total[5m])
```

