# Escrow Indexer Subsystem Operations Runbook

Operator runbook for the LiquiFact backend escrow indexer subsystem: the background process responsible for indexing on-chain escrow events from Soroban and syncing them into the relational persistence layer.

> **Scope note.** This runbook covers the indexer pipeline implemented in [src/services/indexerService.js](../src/services/indexerService.js) and [src/services/escrowIndexer.js](../src/services/escrowIndexer.js). It applies to all background indexing cycles, RPC synchronization, and state reconciliation operations.

---

## Architecture Overview

```text
Soroban RPC Node
  │
  ▼ (poll on-chain events)
Escrow Indexer Cycle
  ├─ process events → update Database & Cache
  └─ advance cursor → update escrow_indexer_last_cursor_advance_timestamp_seconds
```

The indexer continually polls Soroban RPC endpoints for smart contract events emitted by the escrow contracts. When events are discovered, they are parsed, validated against schema definitions, and applied to local invoice state records.

---

## Configuration

All indexer settings are controlled via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `INDEXER_POLL_INTERVAL_MS` | `5000` | Polling frequency in milliseconds for checking new on-chain events. |
| `INDEXER_BATCH_SIZE` | `100` | Maximum number of events to process in a single batch. |
| `SOROBAN_RPC_URL` | unset | Primary Soroban RPC node endpoint URL. |
| `INDEXER_START_CURSOR` | `0` | Initial ledger sequence cursor when bootstrapping from clean database. |

---

## Metrics & Monitoring

The indexer exposes Prometheus telemetry on `/metrics` to track operational health:

- `escrow_indexer_events_processed_total` (Counter): Total number of on-chain escrow events successfully processed and stored.
- `escrow_indexer_events_skipped_total` (Counter): Events skipped due to schema mismatch or unrecognized invoice IDs.
- `escrow_indexer_cycle_failures_total` (Counter): Total number of failed indexing polling cycles.
- `escrow_indexer_last_cursor_advance_timestamp_seconds` (Gauge): Unix timestamp of the last successful cursor advancement. Used to trigger staleness alerts.

---

## Common Failures

### 1. RPC Timeout / Node Unavailability
- **Symptom**: `escrow_indexer_cycle_failures_total` spikes; logs show `SorobanRpcError` or connection timeout.
- **Cause**: The primary Soroban node is unresponsive, rate-limiting requests, or undergoing maintenance.
- **Resolution**: Verify RPC node status. Switch `SOROBAN_RPC_URL` to a fallback node if necessary. Check circuit breaker state transitions in Grafana.

### 2. Cursor Stall
- **Symptom**: `escrow_indexer_last_cursor_advance_timestamp_seconds` stops advancing while on-chain activity is occurring.
- **Cause**: An unparseable event or persistent database serialization failure is blocking cursor progression.
- **Resolution**: Inspect logs for specific event ID rejection. If an event is malformed, use the administrative override tool or check dead-letter queue metrics.

### 3. Database Connection Failure
- **Symptom**: Indexer cycles fail with connection pool timeout errors.
- **Cause**: Relational database under heavy load or unreachable.
- **Resolution**: Check database connection pool metrics and scaling tier. Verify network connectivity between worker nodes and database instance.

---

## Recovery Procedures

### Restarting the Indexer
To safely restart the indexer without losing events:
1. Ensure the database connection pool is healthy.
2. Restart the worker process or container. The indexer will automatically resume from the last persisted ledger cursor.

### Manual Cursor Reset / Replay
If state drift is identified and a historical replay is required:
1. Stop the active indexer worker.
2. Update the stored cursor in the database or set `INDEXER_START_CURSOR` to the desired target ledger sequence.
3. Restart the worker. Monitor `escrow_indexer_events_processed_total` to confirm replay progression.

### Reconciling State Drift
To resolve discrepancies between on-chain contract state and local database state:
1. Invoke the reconciliation utility: run the administrative endpoint `/api/admin/reconcile` or trigger the background reconciliation script.
2. Monitor `escrow_reconciliation_mismatches_total` and `escrow_reconciliation_drift_alerts_total` to verify that state converges to zero mismatches.
