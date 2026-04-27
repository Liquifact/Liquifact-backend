# Escrow Reconciliation Operations

## Overview

The escrow reconciliation job performs nightly reconciliation between on-chain funded amounts and database funded totals for all invoices. This critical operation detects drift between the blockchain state and internal records, ensuring data consistency and triggering alerts for mismatches.

## Architecture

### Components

- **Job Scheduler**: `src/jobs/reconcileEscrow.js` - Core reconciliation logic
- **Health Integration**: `src/services/health.js` - Health check integration
- **Background Processing**: Uses the existing job queue and worker infrastructure

### Data Flow

1. **Trigger**: Nightly cron job or manual execution
2. **Data Collection**: Query all invoices from database with `fundedTotal`
3. **On-Chain Verification**: Call Soroban contract to get `funded_amount` for each invoice
4. **Comparison**: Compare DB and on-chain values
5. **Alerting**: Log mismatches and send notifications
6. **Health Update**: Update health check status

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
    "database": { "status": "not_implemented" },
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

1. Logs a warning: `Escrow mismatch for invoice inv_123: DB=10000, OnChain=9500`
2. Increments mismatch counter in health status
3. TODO: Send email alert to operations team

### Error Handling

- Network failures are retried using the Soroban retry wrapper
- Individual invoice errors don't stop the entire reconciliation
- Errors are logged and counted in the summary

## Security Considerations

- **Authentication**: Internal routes require admin authentication
- **Rate Limiting**: Soroban calls use exponential backoff
- **Input Validation**: Invoice IDs are validated
- **Secrets**: No secrets stored in code, use environment variables

## Monitoring

### Metrics

- Reconciliation success/failure rate
- Number of mismatches over time
- Time to complete reconciliation
- Soroban RPC latency

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