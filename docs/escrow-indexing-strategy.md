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

## Why This Over Captive Core
- Lower operational overhead for current Express service footprint.
- Faster delivery for production-ready MVP.
- Can be upgraded later to Captive Core without schema changes.

## Security Notes
- Indexer is read-only and does not require Stellar secret keys.
- Input validation enforces `invoiceId` format and required event fields.
- Duplicate event IDs are safely ignored by primary-key conflict handling.
- No signing keys or secrets are logged.

## Failure and Recovery
- Cursor is updated only after batch processing.
- On restart, indexer resumes from persisted cursor.
- Invalid events are skipped with warning logs to avoid deadlocking ingestion.

## Upgrade Path
When throughput or deterministic replay needs exceed Horizon polling limits:
1. Deploy Captive Core feeder.
2. Keep writing to `escrow_events` and `escrow_event_projection`.
3. Reuse existing projection semantics and API readers.
