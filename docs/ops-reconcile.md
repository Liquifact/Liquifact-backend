# Escrow Reconciliation Operations

## Overview

The escrow reconciliation job performs nightly reconciliation between on-chain funded amounts and database funded totals for all invoices. This critical operation detects drift between the blockchain state and internal records, ensuring data consistency and triggering alerts for mismatches.

## Architecture

### Components

- **Job Scheduler**: `src/jobs/reconcileEscrow.js` - Core reconciliation logic
- **DB Source**: `src/db/knex.js` - Paginated `invoices` query joined to `escrow_summaries` for the DB `fundedTotal`
- **On-Chain Source**: `src/services/escrowRead.js` (`readFundedAmount`) - Reads `funded_amount` via `callSorobanContract`
- **Persistence**: `reconciliation_runs` table - One row per run (replaces the former `global.reconciliationSummary`)
- **Metrics**: `src/metrics.js` - `escrow_reconciliation_mismatches_total` Prometheus counter
- **Health Integration**: `src/services/health.js` - Reads the latest persisted run
- **Background Processing**: Uses the existing job queue and worker infrastructure

### Data Flow

1. **Trigger**: Nightly cron job or manual execution
2. **Data Collection**: Paginate the `invoices` table (keyset on `id`) for rows in `linked_escrow` / `funded` / `partially_funded` states that are not soft-deleted, joining `escrow_summaries.total_funded` as `fundedTotal`
3. **On-Chain Verification**: Call `readFundedAmount(invoiceId)` for each invoice, which routes through `callSorobanContract` (retry + error mapping) to read the contract `funded_amount`
4. **Comparison**: Classify each invoice as `match`, `mismatch`, or `error`
5. **Alerting**: On `mismatch`, emit a structured warning log (`invoiceId`, `dbFundedTotal`, `onChainAmount`) and increment `escrow_reconciliation_mismatches_total`
6. **Persistence**: Insert the run summary into `reconciliation_runs`
7. **Health Update**: `/health` reads the most recent run row

## Configuration

### Environment Variables

```bash
# Soroban RPC Configuration (inherited from main app)
SOROBAN_RPC_URL=https://soroban-rpc.example.com
SOROBAN_MAX_RETRIES=3
SOROBAN_BASE_DELAY=200
SOROBAN_MAX_DELAY=5000

# Database Configuration (inherited from main app)
DATABASE_URL=postgresql://user:pass@localhost:5432/liquifact

# Reconciliation Alerting Configuration
RECONCILIATION_DRIFT_THRESHOLD=1  # Default: 1. Minimum mismatch count per run before drift alert is raised.
RECONCILIATION_MISMATCH_ALERT_CHANNEL=sentry+log  # 'log' | 'sentry' | 'sentry+log'. Default: 'sentry+log'.
RECONCILIATION_MISMATCH_ALERT_THRESHOLD=1  # Default: 1. Minimum mismatches per run before per-invoice alerts fire.

# Email Alerting Configuration (future enhancement)
ALERT_EMAIL_TO=ops@liquifact.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user
SMTP_PASS=password
```

### Alerting Thresholds

The reconciliation job includes two independent alerting thresholds:

#### 1. Run-Level Drift Alert (`RECONCILIATION_DRIFT_THRESHOLD`)

- **Default:** `1` (any mismatch triggers a run-level alert)
- **Purpose:** Controls when a full reconciliation run is flagged as breached.
- **Behaviour:** When the total number of mismatches in a single run meets or exceeds this threshold:
  - The `escrow_reconciliation_drift_alerts_total` Prometheus counter is incremented.
  - An **error-level** log is emitted with `mismatches`, `threshold`, `totalDrift`, and `reconciledAt` fields.
  - Per-invoice alerts are raised for each mismatched invoice (see below).
  - The health check degrades to `mismatch_threshold_breached`, which degrades the `/ready` probe.
- **When to raise:** Set this above `1` in environments where occasional single-invoice drift is expected and only widespread drift should trigger escalation (e.g., staging, development).
- **Production recommendation:** Keep at `1` to alert on any drift immediately.

#### 2. Per-Invoice Alert Threshold (`RECONCILIATION_MISMATCH_ALERT_THRESHOLD`)

- **Default:** `1` (per-invoice alerts fire for every mismatch)
- **Purpose:** Controls when individual invoice mismatches are escalated to the configured alert channel.
- **Behaviour:** When the total number of mismatches in a run meets or exceeds this threshold, structured per-invoice alerts are raised for **each mismatched invoice** via the configured `RECONCILIATION_MISMATCH_ALERT_CHANNEL`.
- **When to raise:** Set this above `1` to suppress per-invoice alert noise when you only want a summary run-level alert for low-drift runs. For example, setting `RECONCILIATION_DRIFT_THRESHOLD=5` and `RECONCILIATION_MISMATCH_ALERT_THRESHOLD=5` means:
  - No alerts until 5+ mismatches are detected in a single run.
  - Once breached, a run-level error log is emitted AND per-invoice structured alerts fire for all 5+ mismatched invoices.
- **Production recommendation:** Keep at `1` for immediate per-invoice visibility.

### Alert Channels

The `RECONCILIATION_MISMATCH_ALERT_CHANNEL` variable controls where structured per-invoice alerts are sent:

| Value | Behaviour |
| --- | --- |
| `log` | Emit a structured `warn` log for each mismatched invoice (when threshold is breached). |
| `sentry` | Capture each mismatched invoice as a Sentry exception (only when Sentry is enabled via `SENTRY_DSN`). |
| `sentry+log` | **Default.** Both log and Sentry capture. |
| *(other)* | Falls back to `sentry+log` for any unknown value. |

**Structured alert payload (per invoice):**

```javascript
{
  alert: 'reconciliation_mismatch',
  invoiceId: 'inv_abc',
  expected: 10000,        // DB funded total
  actual: 9500,           // On-chain funded amount
  driftMagnitude: 500,    // |expected - actual|
  runMismatches: 2,       // Total mismatches in this run
  threshold: 1            // Current RECONCILIATION_MISMATCH_ALERT_THRESHOLD
}
```

**Security:**
- Only non-sensitive, minimal fields are sent to external channels.
- No raw invoice bodies, contract addresses, XDR, or private keys are included.
- Sentry capture goes through the application's `beforeSend` scrubber which applies an additional sanitization pass before transmission.
- When Sentry is disabled (no `SENTRY_DSN`), Sentry channel selection is a no-op; only the log channel fires.

**Example configurations:**

```bash
# Production: Alert immediately on any mismatch, send to both log and Sentry
RECONCILIATION_DRIFT_THRESHOLD=1
RECONCILIATION_MISMATCH_ALERT_CHANNEL=sentry+log
RECONCILIATION_MISMATCH_ALERT_THRESHOLD=1

# Staging: Alert only on widespread drift (3+ mismatches), log only
RECONCILIATION_DRIFT_THRESHOLD=3
RECONCILIATION_MISMATCH_ALERT_CHANNEL=log
RECONCILIATION_MISMATCH_ALERT_THRESHOLD=3

# Development: Alert on any mismatch, log only (no Sentry noise)
RECONCILIATION_DRIFT_THRESHOLD=1
RECONCILIATION_MISMATCH_ALERT_CHANNEL=log
RECONCILIATION_MISMATCH_ALERT_THRESHOLD=1
```


### Scheduling

The reconciliation runs nightly. In production, configure a cron job:

```bash
# Cron job for nightly reconciliation at 2 AM
0 2 * * * /path/to/node /path/to/liquifact-backend/src/jobs/reconcileEscrow.js
```

Or integrate with a job scheduler like Agenda.js or Bull.

## API Endpoints

### Health Check Integration

The reconciliation status is included in the `/health` endpoint:

```json
{
  "status": "ok",
  "service": "liquifact-api",
  "checks": {
    "soroban": { "status": "healthy" },
    "database": { "status": "healthy" },
    "reconciliation": {
      "status": "healthy",
      "lastRun": "2026-04-25T02:00:00.000Z"
    }
  }
}
```

Possible reconciliation statuses:
- `healthy`: Last run successful, no mismatches
- `degraded`: Mismatches detected but count is below the configured drift threshold
- `mismatch_threshold_breached`: Mismatch count meets or exceeds `RECONCILIATION_DRIFT_THRESHOLD` — degrades `/ready`
- `stale`: Last run more than 25 hours ago
- `not_run`: Reconciliation never executed
- `error`: Reconciliation status lookup failed

The `healthy`, `degraded`, and `mismatch_threshold_breached` statuses also include:
- `mismatches`: Count of mismatched invoices in the latest run
- `totalDrift`: Sum of `|DB − on-chain|` across all mismatches in the latest run
- `threshold`: The current value of `RECONCILIATION_DRIFT_THRESHOLD`
- `thresholdBreached`: Boolean indicating whether the drift threshold was exceeded

### Optional Internal Route

For detailed reconciliation data behind authentication:

```
GET /internal/reconcile
Authorization: Bearer <admin-token>
```

Response:
```json
{
  "total": 150,
  "matches": 148,
  "mismatches": 2,
  "errors": 0,
  "reconciledAt": "2026-04-25T02:00:00.000Z",
  "results": [
    {
      "invoiceId": "inv_123",
      "status": "mismatch",
      "dbFundedTotal": 10000,
      "onChainAmount": 9500,
      "reconciledAt": "2026-04-25T02:00:00.000Z"
    }
  ]
}
```

### Reconciliation Runs History

A paginated list of recent escrow reconciliation run summaries is exposed to authorized admin callers:

```
GET /api/admin/reconciliation/runs?limit=20&page=1
Authorization: Bearer <admin-token>
```

- **Tenant Scoped**: Only rows belonging to the authenticated tenant are returned.
- **Pagination**: Supports `limit` (clamped to 1-100) and `page` parameters.
- **Data Privacy**: Per-invoice results (including contract addresses, XDR, or ledger keys) are intentionally excluded from this endpoint to prevent leaking on-chain data in bulk list responses.


## Alerting

### Mismatch Detection

When `dbFundedTotal !== onChainAmount`, the system:

1. Emits a structured **warning** log: `Escrow mismatch for invoice <id>: DB=<n>, OnChain=<m>` with `{ invoiceId, dbFundedTotal, onChainAmount }`. This fires for every mismatch regardless of thresholds.
2. Increments the `escrow_reconciliation_mismatches_total` Prometheus counter (scraped via `/metrics`). This fires for every mismatch regardless of thresholds.
3. Records the mismatch in the persisted run summary (`reconciliation_runs.mismatches` and `results`).

**After the run completes**, if the total mismatch count meets or exceeds `RECONCILIATION_DRIFT_THRESHOLD`:

4. Increments the `escrow_reconciliation_drift_alerts_total` Prometheus counter.
5. Emits a structured **error** log: `Reconciliation drift alert: <n> mismatches exceed threshold of <t>` with `{ mismatches, threshold, totalDrift, reconciledAt }`.
6. Raises a structured **per-invoice alert** for each mismatched invoice via the configured `RECONCILIATION_MISMATCH_ALERT_CHANNEL` (see [Alert Channels](#alert-channels) above). Each alert carries `{ alert, invoiceId, expected, actual, driftMagnitude, runMismatches, threshold }` — no sensitive fields.
7. The `/ready` health probe degrades to `mismatch_threshold_breached` until the next clean run.

### Run-Level Drift Threshold

See [`RECONCILIATION_DRIFT_THRESHOLD`](#alerting-thresholds) above.

Suggested Prometheus alert rules:

```promql
# Alert on any drift detected in the last 26 hours:
increase(escrow_reconciliation_mismatches_total[26h]) > 0

# Alert when a run explicitly exceeded the configured threshold:
increase(escrow_reconciliation_drift_alerts_total[26h]) > 0
```

### Reconciliation Health Check Integration

The `/ready` probe now includes a `reconciliation` check that degrades readiness when drift is too high:

| Reconciliation status | `/ready` effect |
| --- | --- |
| `healthy` | No effect on readiness. |
| `degraded` | Readiness gauge set to `0.5` (degraded, not blocking). |
| `mismatch_threshold_breached` | `healthy: false` returned; service not ready. |
| `stale` | Informational only; does not block readiness. |
| `not_run` | Non-blocking (fresh deployment). |
| `error` | Non-blocking (lookup failure does not prevent startup). |

**Example `/ready` response with threshold breach:**
```json
{
  "healthy": false,
  "checks": {
    "database": { "status": "healthy" },
    "soroban":  { "status": "healthy" },
    "storage":  { "status": "in_memory" },
    "reconciliation": {
      "status": "mismatch_threshold_breached",
      "lastRun": "2026-07-21T02:00:00.000Z",
      "mismatches": 3,
      "totalDrift": 1500,
      "threshold": 1,
      "thresholdBreached": true
    }
  }
}
```

### Error Handling

- Network failures are retried using the Soroban retry wrapper.
- Individual invoice errors (`RECONCILE_STATUS.ERROR`) never fire mismatch alerts; they are counted separately.
- Errors do not stop the entire reconciliation run — each invoice is processed independently.
- Errors are logged at `error` level and counted in the summary `errors` field.

## Persistence

Each run is written as one row to the `reconciliation_runs` table (migration `migrations/20260429000000_create_reconciliation_runs.js`):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key |
| `total` / `matches` / `mismatches` / `errors` | integer | Per-run counts |
| `results` | jsonb | Full per-invoice results array |
| `reconciled_at` | timestamptz | Run timestamp (indexed; health reads the latest) |
| `created_at` | timestamptz | Insert timestamp |

`getReconciliationSummary()` returns the most recent row (or `null` if none). This replaces the previous in-process `global.reconciliationSummary`, so the latest summary survives restarts and a run history is queryable. Persistence failures are logged and swallowed — they never mask a detected mismatch (the metric and warning log fire first).

Apply the migration with:

```bash
npm run db:migrate
```

## Security Considerations

- **Authentication**: Internal routes require admin authentication
- **Rate Limiting**: Soroban calls use exponential backoff
- **Input Validation**: Invoice IDs are validated against the shared `INVOICE_ID_RE` before any contract call; page size is clamped to `[1, 1000]`
- **Secrets**: No secrets stored in code, use environment variables
- **Idempotency**: Reads are side-effect-free; each run appends exactly one summary row

## Monitoring

### Metrics

| Metric | Type | Description |
| --- | --- | --- |
| `escrow_reconciliation_mismatches_total` | Counter | Cumulative per-invoice mismatch count (fires for every mismatch, regardless of threshold). Use with `increase()` in alerts. |
| `escrow_reconciliation_mismatched_invoices` | Gauge | Mismatch count in the most recent run. |
| `escrow_reconciliation_drift_magnitude` | Gauge | Sum of `|DB − on-chain|` across all mismatches in the most recent run. |
| `escrow_reconciliation_drift_alerts_total` | Counter | Runs that breached `RECONCILIATION_DRIFT_THRESHOLD`. |

Per-run counts (`total`, `matches`, `mismatches`, `errors`) are also persisted in `reconciliation_runs` for historical querying.

### Logs

Key log messages:
```
INFO:  Starting nightly escrow reconciliation
INFO:  Escrow reconciliation completed: 148 matches, 2 mismatches, 0 errors
WARN:  Escrow mismatch for invoice inv_123: DB=10000, OnChain=9500
WARN:  Escrow mismatch alert: funded-amount drift detected  { alert: 'reconciliation_mismatch', invoiceId, expected, actual, driftMagnitude, runMismatches, threshold }
ERROR: Reconciliation drift alert: 2 mismatches exceed threshold of 1  { mismatches, threshold, totalDrift, reconciledAt }
ERROR: Error reconciling invoice inv_456: RPC timeout
```

Structured alert log fields (present in `WARN` per-invoice alert):

| Field | Type | Description |
| --- | --- | --- |
| `alert` | `'reconciliation_mismatch'` | Stable event type identifier for log routing and alerting rules. |
| `invoiceId` | string | Invoice identifier (non-secret). |
| `expected` | number | DB funded total at reconciliation time. |
| `actual` | number | On-chain funded amount. |
| `driftMagnitude` | number | `|expected − actual|`. |
| `runMismatches` | number | Total mismatches in this run (for correlation). |
| `threshold` | number | Current `RECONCILIATION_MISMATCH_ALERT_THRESHOLD` value. |

No sensitive fields (invoice body, XDR, contract address, private key, wallet address) are included in any alert log or Sentry capture.

## Testing

Run the test suite:

```bash
npm test -- tests/reconcileEscrow.test.js
```

Test coverage includes:
- Happy path reconciliation
- Mismatch detection
- Error handling
- Health check integration

## Troubleshooting

### Common Issues

1. **Stale Reconciliation**: Check cron job configuration
2. **RPC Errors**: Verify Soroban RPC endpoint connectivity
3. **Database Errors**: Check database connection and schema
4. **High Mismatch Count**: Investigate recent transactions or contract updates

### Manual Execution

To run reconciliation manually:

```javascript
const { performReconciliation } = require('./src/jobs/reconcileEscrow');
performReconciliation().then(console.log);
```

## Future Enhancements

- Email/SMS alerting for mismatches
- Dashboard for reconciliation history
- Automated remediation for certain mismatch types
- Real-time reconciliation triggers on funding events