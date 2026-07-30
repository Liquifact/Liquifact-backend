# Idempotency Key Purge Operations

The idempotency middleware (`src/middleware/idempotency.js`) writes rows into the `idempotency_keys` table with an `expires_at` timestamp to enable safe retry of funding submissions. Over time, expired keys accumulate, causing unbounded table growth that degrades lookup performance and consumes storage unnecessarily.

The **idempotency purge job** (`src/jobs/idempotencyPurge.js`) runs periodically to delete expired keys in bounded batches, maintaining table health without impacting application performance.

---

## How It Works

### Purge Logic

1. **Batch Processing**: The job deletes expired keys in configurable batches (default: 1000 rows per batch) to prevent long-running transactions
2. **Safety Constraint**: Only keys where `expires_at < NOW()` are deleted, ensuring still-valid keys are never removed
3. **Oldest-First Ordering**: Expired keys are deleted in ascending order of `expires_at` to prioritize the oldest data
4. **Max Batch Limit**: The job stops after a configurable number of batches (default: 100) to prevent runaway deletions

### SQL Query

The purge uses a parameterized subquery to ensure safety and performance:

```sql
DELETE FROM idempotency_keys
WHERE id IN (
  SELECT id
  FROM idempotency_keys
  WHERE expires_at < NOW()
  ORDER BY expires_at ASC
  LIMIT ?
)
```

This approach:
- Prevents accidental deletion of valid keys (even under concurrent inserts)
- Uses the `idx_idempotency_keys_expires_at` index for fast lookups
- Bounds the transaction size to avoid lock contention

---

## Configuration

All configuration is managed via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `IDEMPOTENCY_PURGE_BATCH_SIZE` | `1000` | Maximum rows to delete per batch (min: 1, max: 10000) |
| `IDEMPOTENCY_PURGE_INTERVAL_MS` | `3600000` | Cadence between purge runs in milliseconds (default: 1 hour, min: 60000) |
| `IDEMPOTENCY_PURGE_MAX_BATCHES` | `100` | Maximum batches per run to prevent runaway deletes (min: 1, max: 1000) |

### Example Configuration

```bash
# Purge 500 rows per batch, every 30 minutes, up to 50 batches per run
IDEMPOTENCY_PURGE_BATCH_SIZE=500
IDEMPOTENCY_PURGE_INTERVAL_MS=1800000
IDEMPOTENCY_PURGE_MAX_BATCHES=50
```

---

## Metrics

The purge job emits Prometheus metrics for monitoring and alerting:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `liquifact_idempotency_purge_rows_deleted_total` | Counter | - | Total number of expired keys deleted across all runs |
| `liquifact_idempotency_purge_runs_total` | Counter | `status` | Total purge job runs (status: `success` or `error`) |
| `liquifact_idempotency_purge_duration_seconds` | Counter | - | Total time spent in purge job execution |

### Example Queries

```prometheus
# Average rows deleted per run (last 1 hour)
rate(liquifact_idempotency_purge_rows_deleted_total[1h]) 
  / rate(liquifact_idempotency_purge_runs_total{status="success"}[1h])

# Purge job success rate
rate(liquifact_idempotency_purge_runs_total{status="success"}[5m]) 
  / rate(liquifact_idempotency_purge_runs_total[5m])

# Average purge duration (seconds per run)
rate(liquifact_idempotency_purge_duration_seconds[1h]) 
  / rate(liquifact_idempotency_purge_runs_total{status="success"}[1h])
```

### Recommended Alerts

```yaml
# Alert if purge job hasn't run successfully in 2 hours
- alert: IdempotencyPurgeStalled
  expr: time() - liquifact_idempotency_purge_runs_total{status="success"} > 7200
  annotations:
    summary: "Idempotency purge job hasn't run in 2 hours"

# Alert if purge job error rate exceeds 10%
- alert: IdempotencyPurgeHighErrorRate
  expr: |
    rate(liquifact_idempotency_purge_runs_total{status="error"}[5m]) 
      / rate(liquifact_idempotency_purge_runs_total[5m]) > 0.1
  annotations:
    summary: "Idempotency purge job error rate > 10%"
```

---

## Worker Lifecycle

### Starting the Worker

The purge worker is started automatically when the application boots (typically in `src/app.js` or `src/index.js`):

```javascript
const { startPurgeWorker } = require('./jobs/idempotencyPurge');

// Start the purge worker during application initialization
startPurgeWorker();
```

This:
1. Starts the background worker queue processor
2. Schedules the first purge job based on `IDEMPOTENCY_PURGE_INTERVAL_MS`
3. Logs: `Idempotency purge worker started`

### Graceful Shutdown

The worker supports graceful shutdown with a configurable timeout:

```javascript
const { stopPurgeWorker } = require('./jobs/idempotencyPurge');

// Allow 10 seconds for in-flight jobs to complete
await stopPurgeWorker(10000);
```

---

## Manual Operations

### Triggering a Purge Manually

For administrative tasks or immediate cleanup:

```javascript
const { triggerPurge } = require('./src/jobs/idempotencyPurge');

// Trigger immediate purge
const jobId = triggerPurge();
console.log(`Purge job scheduled: ${jobId}`);
```

### Checking Worker Status

```javascript
const { getStats } = require('./src/jobs/idempotencyPurge');

const stats = getStats();
console.log('Worker Stats:', stats.worker);
console.log('Queue Stats:', stats.queue);
console.log('Config:', stats.config);
```

Example output:
```json
{
  "worker": {
    "isRunning": true,
    "processingCount": 0,
    "handlerCount": 1
  },
  "queue": {
    "queueLength": 1,
    "retryQueueLength": 0
  },
  "config": {
    "batchSize": 1000,
    "intervalMs": 3600000,
    "maxBatches": 100
  }
}
```

---

## Safety Guarantees

### Concurrent Insert Safety

The purge job is designed to be safe under concurrent inserts:

1. **Time-Based Filter**: Only keys where `expires_at < NOW()` are eligible for deletion
2. **Snapshot Isolation**: The DELETE operates on a snapshot from the subquery execution time
3. **Primary Key Selection**: The subquery selects by `id`, ensuring deterministic row targeting

**Example**: If a new key is inserted with `expires_at = NOW() + 24h` during a purge run, it will never be included in the deletion set because it doesn't match the `expires_at < NOW()` filter.

### Batch Bounding

The `MAX_BATCHES` limit prevents runaway deletions:

- If the table contains 1 million expired keys, the job will delete at most `BATCH_SIZE × MAX_BATCHES` keys per run
- Subsequent runs will continue purging until the table is clean
- This prevents a single job from holding database locks for extended periods

### Transaction Safety

Each batch deletion is a single atomic transaction:
- Either all rows in the batch are deleted, or none are
- No partial deletes can occur due to interruptions
- The `WHERE id IN (SELECT ...)` pattern ensures deterministic batch targeting

---

## Performance Considerations

### Index Usage

The purge job relies on the `idx_idempotency_keys_expires_at` index (created in `migrations/20260601000000_create_idempotency_keys.sql`):

```sql
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
    ON idempotency_keys (expires_at);
```

This index ensures:
- Fast identification of expired keys (`WHERE expires_at < NOW()`)
- Efficient ordering for oldest-first processing
- Minimal table scan overhead

### Tuning Recommendations

| Scenario | Recommended Settings |
|----------|---------------------|
| **Low traffic** (< 1K keys/day) | Default settings |
| **Medium traffic** (1K-10K keys/day) | `BATCH_SIZE=2000`, `INTERVAL_MS=1800000` (30 min) |
| **High traffic** (> 10K keys/day) | `BATCH_SIZE=5000`, `INTERVAL_MS=900000` (15 min), `MAX_BATCHES=200` |

Monitor the `liquifact_idempotency_purge_rows_deleted_total` metric to adjust settings based on actual purge volume.

---

## Debugging

### Common Issues

#### 1. Purge Job Not Running

**Symptom**: `liquifact_idempotency_purge_runs_total` metric hasn't incremented

**Diagnosis**:
```javascript
const { getStats } = require('./src/jobs/idempotencyPurge');
console.log(getStats().worker.isRunning); // Should be true
```

**Solution**: Ensure `startPurgeWorker()` is called during application initialization

#### 2. High Error Rate

**Symptom**: `liquifact_idempotency_purge_runs_total{status="error"}` is increasing

**Diagnosis**: Check application logs for error details:
```
[ERROR] Idempotency purge job failed: Database connection lost
```

**Common Causes**:
- Database connection pool exhaustion
- Long-running transactions blocking the purge
- Insufficient database permissions

**Solution**: Verify database connectivity and ensure the application user has `DELETE` permission on `idempotency_keys`

#### 3. Table Still Growing

**Symptom**: `idempotency_keys` table size continues to increase despite purge running

**Diagnosis**: Check if purge is hitting the max batch limit:
```sql
SELECT COUNT(*) FROM idempotency_keys WHERE expires_at < NOW();
```

**Solution**: 
- Increase `IDEMPOTENCY_PURGE_MAX_BATCHES` or `IDEMPOTENCY_PURGE_BATCH_SIZE`
- Decrease `IDEMPOTENCY_PURGE_INTERVAL_MS` to run more frequently
- Manually trigger additional purge runs during off-peak hours

---

## Testing Manually

You can test the purge job manually using Node.js REPL:

```javascript
const db = require('./src/db/knex');
const { 
  triggerPurge, 
  startPurgeWorker,
  getStats 
} = require('./src/jobs/idempotencyPurge');

// Insert test data (expired key)
await db('idempotency_keys').insert({
  idempotency_key: 'test_key_123',
  request_fingerprint: 'abc123',
  response_status: 201,
  response_body: JSON.stringify({ success: true }),
  expires_at: new Date(Date.now() - 86400000), // 1 day ago
});

// Start the worker
startPurgeWorker();

// Trigger immediate purge
const jobId = triggerPurge();
console.log(`Purge job ID: ${jobId}`);

// Wait a few seconds, then check stats
setTimeout(async () => {
  const stats = getStats();
  console.log('Stats:', stats);
  
  // Verify the test key was deleted
  const remaining = await db('idempotency_keys')
    .where({ idempotency_key: 'test_key_123' })
    .first();
  console.log('Test key remaining:', remaining ? 'YES (ERROR)' : 'NO (SUCCESS)');
}, 3000);
```

---

## Integration with Idempotency Middleware

The purge job is designed to work seamlessly with the idempotency middleware:

1. **Middleware writes keys** with `expires_at = NOW() + TTL_HOURS` (default: 24 hours)
2. **Keys remain valid** for the configured TTL, enabling safe retries
3. **Purge job deletes expired keys** after the TTL has elapsed
4. **Table remains bounded** without manual intervention

### TTL Configuration

The idempotency middleware TTL is controlled by:
```bash
IDEMPOTENCY_KEY_TTL_HOURS=24  # Default: 24 hours
```

Ensure the purge job interval is shorter than the TTL to prevent unbounded growth:
```
IDEMPOTENCY_PURGE_INTERVAL_MS < (IDEMPOTENCY_KEY_TTL_HOURS × 3600000)
```

---

## Operational Checklist

- [ ] Purge worker is started during application initialization
- [ ] `idx_idempotency_keys_expires_at` index exists in the database
- [ ] Prometheus metrics are being scraped and visualized
- [ ] Alerts are configured for stalled or failing purge jobs
- [ ] Batch size and interval are tuned for your traffic volume
- [ ] Database user has `DELETE` permission on `idempotency_keys`
- [ ] Logs are being collected and searchable for debugging

---

## Related Documentation

- [Idempotency Middleware](../src/middleware/idempotency.js) - The middleware that creates idempotency keys
- [Background Workers](../src/workers/worker.js) - The job queue and worker infrastructure
- [Database Migrations](../migrations/20260601000000_create_idempotency_keys.sql) - The `idempotency_keys` table schema
- [Metrics](../src/metrics.js) - Prometheus metrics collection

---

## Code References

- **Job Implementation**: `src/jobs/idempotencyPurge.js`
- **Tests**: `tests/idempotencyPurge.test.js`
- **Middleware**: `src/middleware/idempotency.js`
- **Migration**: `migrations/20260601000000_create_idempotency_keys.sql`
