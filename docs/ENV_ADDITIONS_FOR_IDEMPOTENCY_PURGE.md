# Environment Variable Additions for Idempotency Purge

## Instructions

Add the following environment variables to your `.env.example` and `.env` files.

## Variables to Add

```bash
# ============================================================================
# Idempotency Configuration
# ============================================================================

# How long idempotency keys remain valid (in hours)
# After this period, keys are eligible for purge
# Default: 24 hours
IDEMPOTENCY_KEY_TTL_HOURS=24

# ============================================================================
# Idempotency Purge Job Configuration
# ============================================================================

# Maximum number of rows to delete per batch
# Range: 1-10000, Default: 1000
# Higher values = faster purge, but longer transactions
IDEMPOTENCY_PURGE_BATCH_SIZE=1000

# How often the purge job runs (in milliseconds)
# Minimum: 60000 (1 minute), Default: 3600000 (1 hour)
# Lower values = more frequent purging, but higher database load
IDEMPOTENCY_PURGE_INTERVAL_MS=3600000

# Maximum number of batches to process per run
# Range: 1-1000, Default: 100
# Prevents runaway deletions if table has accumulated many expired keys
IDEMPOTENCY_PURGE_MAX_BATCHES=100
```

## Production Recommendations

### Low Traffic (< 1,000 keys/day)
```bash
# Use defaults - no changes needed
```

### Medium Traffic (1,000-10,000 keys/day)
```bash
IDEMPOTENCY_PURGE_BATCH_SIZE=2000
IDEMPOTENCY_PURGE_INTERVAL_MS=1800000  # 30 minutes
```

### High Traffic (> 10,000 keys/day)
```bash
IDEMPOTENCY_PURGE_BATCH_SIZE=5000
IDEMPOTENCY_PURGE_INTERVAL_MS=900000   # 15 minutes
IDEMPOTENCY_PURGE_MAX_BATCHES=200
```

## Notes

- The purge job starts automatically when the application boots (outside test environment)
- Monitor the `liquifact_idempotency_purge_*` Prometheus metrics to tune these values
- Ensure `IDEMPOTENCY_PURGE_INTERVAL_MS < (IDEMPOTENCY_KEY_TTL_HOURS × 3600000)` to prevent unbounded growth
- The job is safe to run under production traffic (uses WHERE expires_at < NOW())

## Verification

After adding these variables and restarting the application, verify the purge job is running:

```javascript
// In Node.js REPL or your app code
const { getStats } = require('./src/jobs/idempotencyPurge');
console.log(getStats());
// Should show: { worker: { isRunning: true, ... }, ... }
```

Check the logs for:
```
[INFO] Idempotency purge worker started
```

Monitor Prometheus metrics:
```promql
liquifact_idempotency_purge_runs_total
liquifact_idempotency_purge_rows_deleted_total
```

## Related Documentation

- [Operations Guide](./ops-idempotency-purge.md) - Comprehensive operational documentation
- [Configuration Reference](./configuration.md) - Full environment variable reference
- [Implementation Summary](./IDEMPOTENCY_PURGE_IMPLEMENTATION.md) - Technical implementation details
