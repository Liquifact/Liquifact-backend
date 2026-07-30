# Escrow Event Ingest Strategy (Issue #102)

> **See also:** [Escrow Integration Overview](./escrow-integration-overview.md) — end-to-end flow from chain events through projection tables to the API.

## Goal
Persist a durable, replayable feed of latest Liquifact escrow contract events by `invoiceId`.

## Selected Approach
Use a Horizon-driven poller with cursor checkpointing and projection tables.

- Source: Horizon events API (cursor + ascending order)
- Cursor durability: `escrow_indexer_state`
- Raw immutable event log: `escrow_events`
- Latest per-invoice projection: `escrow_event_projection`

## InvoiceId vs ContractId Resolution
Horizon contract event records are keyed on-chain by the emitting contract
address (`contract_id`), not by the business `invoiceId` the projection is
queried by (`GET /api/escrow/:invoiceId`). The mapper must therefore derive a
real `invoiceId` for each event and keep the contract address as a separate
field (`escrow_events.contract_id`, which the schema already supports).

`deriveInvoiceId(record)` resolves the invoice in priority order:

1. An explicit `invoice_id` / `invoiceId` field on the record.
2. The LiquifactEscrow event payload — the event `value` body, or a topic
   entry explicitly labelled with an invoice field. Bare topic symbols (e.g.
   the leading event-name symbol such as `escrow_funded`) and unlabelled
   scalars are **not** treated as invoice IDs to avoid false positives.
3. Reverse lookup of the emitting contract address via
   `config/escrowMap.resolveInvoiceByAddress`, which maps an active escrow
   contract address back to its invoice ID for the current environment. The
   reverse index is built once from `ESCROW_ADDR_BY_INVOICE` mappings (respecting
   `cacheEnabled` / `cacheTtlSeconds`) and only includes active, environment-
   scoped entries — unknown addresses return `null` and the event is skipped.

Every candidate is validated against `INVOICE_ID_REGEX`
(`/^[a-zA-Z0-9_-]{1,128}$/`). Any record that does not yield a valid invoice —
including contract-only events with no resolvable mapping — is **skipped**
(filtered out before persistence) rather than mis-keyed by contract address.
This guarantees the projection is keyed only by real invoice IDs and remains
usable for invoice-scoped lookups.

Skipping a record does not stall ingestion: the Horizon cursor (`nextCursor`)
is derived from the last *record* in the batch, so the cursor advances past
skipped events on the next cycle.

## Event Identifier Validation & Quarantine

To guarantee database integrity and prevent malformed data injection, the indexer strictly validates two key event identifiers before persistence:

1. **`contractId`**:
   - Must start with 'C' (Stellar StrKey contract address format).
   - Must be exactly 56 base32 characters.
   - Must carry a valid CRC16-XMODEM checksum (checked using `@stellar/stellar-sdk`'s `StrKey.isValidContractId`).
2. **`txHash`**:
   - Must be exactly 64 hexadecimal characters.
   - Must be case-insensitive.
   - Must not contain prefix like `0x` or other non-hexadecimal characters.

### Rejection and Quarantine Behavior

When an incoming event contains an invalid `contractId` or `txHash` identifier:
- The `normalizeEvent` function throws an error, causing the persistence transaction to be skipped for that specific event.
- The malformed event is **not** persisted to the `escrow_events` table or projected to the `escrow_event_projection` table, preventing database pollution.
- Instead of terminating the cycle, the error is caught at the batch loop level in `runEscrowIndexerCycle`. The cycle increments the skipped counter (`skipped`) and emits a warning log including the error message and event identifier.
- The `escrow_indexer_events_skipped_total` Prometheus counter is incremented, and the remaining valid events in the batch are processed normally.

## Why This Over Captive Core
- Lower operational overhead for current Express service footprint.
- Faster delivery for production-ready MVP.
- Can be upgraded later to Captive Core without schema changes.

## Security Notes
- Indexer is read-only and does not require Stellar secret keys.
- Input validation enforces `invoiceId` format and required event fields.
- InvoiceId is never inferred from the raw contract address; only an
  allowlisted, environment-scoped `escrowMap` reverse lookup or an explicit
  payload field may resolve it, so unmapped contracts cannot inject rows.
- Contract-only / unresolvable events are skipped, never mis-keyed.
- Duplicate event IDs are safely ignored by primary-key conflict handling
  (idempotent upserts on `event_id` and `invoice_id`).
- No signing keys or secrets are logged; configuration comes from `.env`
  (`ESCROW_ADDR_BY_INVOICE`, `STELLAR_HORIZON_URL`) and deployment secrets.

## Failure and Recovery
- Cursor is updated only after batch processing.
- On restart, indexer resumes from persisted cursor.
- Invalid events are skipped with warning logs to avoid deadlocking ingestion.
- Cursor is saved only when it changes to keep writes idempotent across repeated cycles.

## Upgrade Path
When throughput or deterministic replay needs exceed Horizon polling limits:
1. Deploy Captive Core feeder.
2. Keep writing to `escrow_events` and `escrow_event_projection`.
3. Reuse existing projection semantics and API readers.

## Observability: Metrics and Health Checks

### Prometheus Metrics

The escrow indexer emits four Prometheus metrics per cycle. All metrics are reset to zero on service startup.

| Metric Name | Type | Description |
|-------------|------|-------------|
| `escrow_indexer_events_processed_total` | Counter | Total number of escrow events successfully processed and persisted by the indexer. Incremented by the count of valid events in each cycle. |
| `escrow_indexer_events_skipped_total` | Counter | Total number of escrow events skipped due to validation or persistence errors. Incremented when an event fails normalization or database constraints. |
| `escrow_indexer_cycle_failures_total` | Counter | Total number of indexer cycles that failed with an unhandled exception. Incremented once per failed cycle, even if multiple events fail within that cycle. |
| `escrow_indexer_last_cursor_advance_timestamp_seconds` | Gauge | Unix timestamp (seconds) of the last cycle where the cursor advanced (`cursorAfter !== cursorBefore`). Used by the health check to detect staleness. |

#### Metric Semantics

- **Counters** accumulate indefinitely across the lifetime of the service. Use `rate(metric[5m])` to compute per-second rates over time windows.
- **Gauge** stores a Unix timestamp in seconds. The health check computes elapsed time as `Date.now() / 1000 - gaugeValue`.
- **Gauge initialization**: The gauge is not initialized on startup and is only set when a cursor advance occurs. This avoids false positives in the health check immediately after service startup. See [Health Check: Staleness](#health-check-staleness).

#### Metric Emission and Validation

Metrics are emitted **after** each cycle completes, regardless of whether it processed zero or multiple events:

```javascript
// Pseudocode
result = runEscrowIndexerCycle(...)
if (Number.isInteger(result.processed) && result.processed >= 0) {
  escrowIndexerEventsProcessedTotal.inc(result.processed)
} else {
  escrowIndexerCycleFailuresTotal.inc()
  log.error('Invalid processed count')
}
// ... similar for skipped ...
if (result.cursorAfter !== result.cursorBefore) {
  escrowIndexerLastCursorAdvanceTimestampSeconds.set(Date.now() / 1000)
}
```

If `result.processed` or `result.skipped` are not valid non-negative integers, the failure counter is incremented and the invalid count is **not** passed to the counter's `.inc()` method.

### Health Check: Staleness

The `/ready` endpoint includes an `indexerStaleness` check that signals whether the indexer has stalled.

#### Check Behavior

The check returns:

- **`status: "disabled"`** when `ESCROW_INDEXER_ENABLED` is not `"true"` (case-sensitive).
- **`status: "healthy"`** when:
  - The indexer is enabled and the gauge has never been set (initial startup state), or
  - The elapsed time since the last cursor advance is within the `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` threshold.
- **`status: "stale"`** when the elapsed time exceeds the threshold.
- **`status: "error"`** if an exception occurs while reading the configuration or gauge.

#### Staleness Threshold

The staleness threshold is configurable via the `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` environment variable:

```bash
# Default: 300 seconds (5 minutes)
ESCROW_INDEXER_STALE_THRESHOLD_SECONDS=300
```

At query time, the health check computes:

```javascript
elapsedSeconds = Math.floor(Date.now() / 1000) - lastAdvanceTimestamp
isStale = elapsedSeconds > threshold
```

#### Example: Detecting a Stalled Indexer

```bash
# Assume ESCROW_INDEXER_ENABLED=true and threshold=300

# Recently advanced cursor → healthy
GET /ready
HTTP/1.1 200 OK
{
  "ready": true,
  "checks": {
    "indexerStaleness": {
      "status": "healthy",
      "elapsedSeconds": 45,
      "lastAdvanceTimestamp": 1748610000,
      "threshold": 300
    }
  }
}

# Cursor has not advanced in 400 seconds → degraded
GET /ready
HTTP/1.1 503 Service Unavailable
{
  "ready": false,
  "checks": {
    "indexerStaleness": {
      "status": "stale",
      "elapsedSeconds": 400,
      "lastAdvanceTimestamp": 1748609600,
      "threshold": 300,
      "error": "Cursor has not advanced for 400 seconds (threshold: 300)"
    }
  }
}
```

#### Startup Behavior

On service startup, the gauge is unset (no value). The health check treats an unset gauge as **healthy** to avoid false positives:

```javascript
if (lastAdvanceTimestamp === undefined || lastAdvanceTimestamp === 0) {
  return { status: 'healthy' }; // No false positive on startup
}
```

This design allows the service to report `/ready: true` even if the indexer hasn't advanced yet, provided other dependencies (Soroban, KYC) are healthy.

### Prometheus Query Examples

#### Detect Indexer Never Started

```promql
escrow_indexer_last_cursor_advance_timestamp_seconds == 0
```

#### Detect Stalled Indexer

```promql
# Cursor has not advanced in more than 5 minutes (300 seconds)
(time() - escrow_indexer_last_cursor_advance_timestamp_seconds) > 300
```

#### Event Processing Rate

```promql
rate(escrow_indexer_events_processed_total[5m])
```

#### Cycle Success Rate

```promql
# Percentage of cycles without failures (requires cycle counter — not yet implemented)
(rate(escrow_indexer_events_processed_total[5m])) /
(rate(escrow_indexer_events_processed_total[5m]) + rate(escrow_indexer_cycle_failures_total[5m]))
```

## Configuration Reference

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ESCROW_INDEXER_ENABLED` | String (`"true"` or `"false"`) | `"false"` | Enable/disable the escrow indexer job. Case-sensitive. |
| `ESCROW_INDEXER_POLL_INTERVAL_MS` | Integer | `15000` | Milliseconds between indexer cycles. |
| `ESCROW_INDEXER_BATCH_SIZE` | Integer | `100` | Maximum events to fetch and process per cycle. |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | Integer | `300` | Seconds allowed without cursor advance before `/ready` reports degraded. |
| `STELLAR_HORIZON_URL` | URL | `https://horizon-testnet.stellar.org` | Horizon API endpoint for event streaming. |

#### Example `.env` Configuration

```dotenv
ESCROW_INDEXER_ENABLED=true
ESCROW_INDEXER_POLL_INTERVAL_MS=15000
ESCROW_INDEXER_BATCH_SIZE=100
ESCROW_INDEXER_STALE_THRESHOLD_SECONDS=300
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

### Feature Flag Validation

At service startup, `src/config/index.js` validates `ESCROW_INDEXER_ENABLED` using Zod:

```javascript
z.enum(['true', 'false']).default('false')
```

Any other value (including `"True"`, `1`, or truthy strings) will fail validation and prevent service startup.

## Security Considerations

### No PII in Metrics

- Metric names contain only job names, status identifiers, and standard fields (`total`, `timestamp`).
- Metric label values (if any were added in future) must never contain user addresses, transaction IDs, or other personally identifiable information.
- Each metric is designed to support horizontal scaling: counters measure service-level throughput; gauges measure time-based staleness only.

### Input Validation Before Metric Increment

Before emitting metrics, the cycle validates:

- `result.processed` is a non-negative integer (not a string, not negative).
- `result.skipped` is a non-negative integer.
- `result.cursorBefore` and `result.cursorAfter` are strings or null.

If validation fails, the cycle failure counter is incremented and a warning is logged.

### No Secrets in Logs or Metrics

- Metrics never include Stellar secret keys, Horizon API keys, or other credentials.
- Logs include event IDs and cycle summary counts, but never private keys or contract data.
- The Horizon URL is a public endpoint (testnet or mainnet); API keys are not required for Horizon event streaming.

## Monitoring and Alerting Recommendations

### Prometheus Alert Rules (Example)

```yaml
groups:
  - name: escrow-indexer
    rules:
      - alert: EscrowIndexerStalled
        expr: (time() - escrow_indexer_last_cursor_advance_timestamp_seconds) > 600
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Escrow indexer cursor has not advanced for 10 minutes"
          description: "Last cursor advance: {{ $value | humanizeTimestamp }}"

      - alert: EscrowIndexerHighFailureRate
        expr: rate(escrow_indexer_cycle_failures_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Escrow indexer experiencing high failure rate"
          description: "Failure rate: {{ $value | humanizePercentage }}"
```

## Testing

All metrics and health checks are tested in `tests/unit/escrowIndexer.metrics.test.js`:

- Metric increment correctness (processed, skipped, failures, cursor advance).
- Health check staleness detection (threshold, disabled flag, startup state).
- Security validation (invalid input, feature flag parsing).
- Integration with `/ready` and `/metrics` endpoints.
- Vacuousness checks confirm conditions are correctly implemented.

See [Coverage Report](./Test-Coverage-Analysis.md) for full test coverage.
