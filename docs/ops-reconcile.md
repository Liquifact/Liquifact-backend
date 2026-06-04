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

# Alerting Configuration (future enhancement)
ALERT_EMAIL_TO=ops@liquifact.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user
SMTP_PASS=password
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
- `mismatches`: Reconciliation found discrepancies
- `stale`: Last run more than 25 hours ago
- `not_run`: Reconciliation never executed
- `error`: Reconciliation failed

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

## Alerting

### Mismatch Detection

When `dbFundedTotal !== onChainAmount`, the system:

1. Emits a structured warning log: `Escrow mismatch for invoice <id>: DB=<n>, OnChain=<m>` with `{ invoiceId, dbFundedTotal, onChainAmount }`
2. Increments the `escrow_reconciliation_mismatches_total` Prometheus counter (scraped via `/metrics`)
3. Records the mismatch in the persisted run summary (`reconciliation_runs.mismatches` and `results`)

Suggested Prometheus alert (drift appearing between nightly runs):

```promql
increase(escrow_reconciliation_mismatches_total[26h]) > 0
```

### Error Handling

- Network failures are retried using the Soroban retry wrapper
- Individual invoice errors don't stop the entire reconciliation
- Errors are logged and counted in the summary

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

- `escrow_reconciliation_mismatches_total` (Prometheus counter) - cumulative mismatches detected; the primary drift signal
- Per-run counts (`total`, `matches`, `mismatches`, `errors`) persisted in `reconciliation_runs`
- Time to complete reconciliation
- Soroban RPC latency (via the shared Soroban call path)

### Logs

Key log messages:
```
INFO: Starting nightly escrow reconciliation
INFO: Escrow reconciliation completed: 148 matches, 2 mismatches, 0 errors
WARN: Escrow mismatch for invoice inv_123: DB=10000, OnChain=9500
ERROR: Error reconciling invoice inv_456: RPC timeout
```

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