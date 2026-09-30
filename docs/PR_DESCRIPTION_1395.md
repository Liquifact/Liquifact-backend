# Harden concurrent execution around `src/jobs/escrowIndexer.js`

Closes #1395

## Summary

The escrow indexer persists on-chain escrow events into `escrow_events` and a
per-invoice `escrow_event_projection`, advancing a durable Horizon cursor as it
goes. It can run from multiple pollers (and from a scheduler plus a manual
invocation), so a cycle can overlap with another cycle in the same process, in
another process, or with a retry of a batch that partially failed.

Prior to this change the indexer treated **every** per-event error as
"skipped" and still advanced the cursor. A transient database/transaction
failure was therefore indistinguishable from a permanently malformed payload:
the cursor moved past an event that was never written, and that event was lost
silently. Two smaller defects compounded the problem: the configured lease
duration was computed but never used, and a cycle that yielded the lease to
another worker was mis-reported as a failure (and dereferenced a `null`
summary).

This change makes the cycle **fail closed** and closes two race windows, without
changing any public interface.

## Affected modules

- `src/jobs/escrowIndexer.js` (only production file changed)
- `tests/unit/escrowIndexer.concurrency.test.js` (new focused regression suite)
- `docs/PR_DESCRIPTION_1395.md` (this document)

No callers needed changes: `createEscrowIndexer`, `runEscrowIndexerCycle`,
`createKnexEscrowEventStore`, and the existing exports keep their signatures and
return shapes. `runEscrowIndexerCycle` already documented that it may resolve
`null` when the lease is held; that behaviour is now correct and tested.

## State / invariant changes

The persisted state model is unchanged (`escrow_events`, `escrow_event_projection`,
`escrow_indexer_state`). What changes is *when* the cursor may advance:

1. **Single-writer invariant (unchanged, now fully honoured).** A cycle must hold
   the `worker_lease` row in `escrow_indexer_state` to do any work. If another
   worker holds a live lease the cycle is a no-op and resolves `null`.
2. **Fail-closed checkpoint invariant (new).** The cursor advances only after
   every event in the fetched batch has either:
   - been persisted idempotently (new `event_id`), or
   - been **permanently** rejected as structurally invalid (`ValidationError`).
   Any other (transient) failure aborts the cycle with the cursor unmoved, so
   the same batch is re-fetched and retried next cycle. Event writes are
   idempotent, so replay is safe.
3. **Fenced-checkpoint invariant (strengthened).** A cursor write is committed
   in the same transaction as the lease assertion, so a worker whose lease
   expired between the assertion and the write can no longer regress the
   checkpoint (TOCTOU).

These invariants are documented inline in the module's JSDoc.

## Changes

### 1. Fail-closed per-event error handling (`runEscrowIndexerCycle`)

New `isSkippableEventError(error)` classifies a failure as permanent only when it
is a structured `ValidationError` (checked by `instanceof` with a `name`
fallback so dependency-injected error types still classify correctly). In the
event loop:

- `LeaseLostError` → abort (unchanged).
- permanent validation error → count as `skipped`, log at `warn` with the
  stable error `code`, continue, and allow the cursor to advance past it.
- any other error → log at `error` with the `eventId`, then abort the cycle
  **before** the cursor is saved.

The abort propagates to `createEscrowIndexer.runCycle`, which records one
`escrowIndexerCycleFailuresTotal` increment and returns `null`. Because the
cursor was not advanced, the batch is retried — no silent loss.

### 2. Lease duration is actually applied

`createEscrowIndexer` computed `leaseDurationMs` from
`options.leaseDurationMs || ESCROW_INDEXER_LEASE_DURATION_MS` but never passed it
to `runEscrowIndexerCycle`, so leases always used the 30 s default and the
"unused variable" was masked by lint noise. It is now threaded through to
`acquireLease`/`renewLease`.

### 3. Lease contention is not a failure

`runEscrowIndexerCycle` legitimately resolves `null` when another worker holds
the lease. `runCycle` now returns early on `null` instead of feeding it to the
metrics block (which dereferenced `summary.processed`/`summary.skipped` and
incremented `escrowIndexerCycleFailuresTotal`, turning normal contention into
false alarms).

### 4. Atomic, fenced cursor write (`createKnexEscrowEventStore.saveCursor`)

`saveCursor` now performs the lease assertion and the cursor upsert inside a
single `knex.transaction` when a fence token is supplied. A stale worker's write
is rejected by `assertLease` within the transaction and never commits. Unfenced
writes keep their previous behaviour.

## Compatibility

- Public function signatures and return shapes are unchanged.
- `runEscrowIndexerCycle` still resolves `null` for a held lease.
- Validation errors are still skipped; only non-validation failures changed from
  "skipped" to "abort + retry", which is the safe direction.
- No schema migration is required.
- New export `isSkippableEventError` is additive.

## Security and failure-mode handling

- **No silent data loss.** Transient failures cannot advance the cursor past
  unpersisted events.
- **No stale writes.** Cursor writes are fenced by the lease token and committed
  atomically with the lease assertion.
- **No cross-worker interleaving.** The database-clock lease remains the single
  writer gate; the in-process `running` flag additionally prevents overlapping
  timers in one process.
- **Safe retries.** Event upserts are idempotent (`onConflict('event_id')
  .ignore()`), and projection replacement is ordered by
  `(ledger_sequence, paging_token)`, so replaying a batch cannot regress or
  duplicate state.
- **Diagnosable, non-sensitive logs.** Aborts log the error object and the
  `eventId`/error `code`; no payload contents are logged by this change.
- **No `process.exit`.** Failures surface as returned `null` plus a cycle-failure
  metric.

## Observability

- `escrowIndexerEventsProcessedTotal` — events persisted.
- `escrowIndexerEventsSkippedTotal` — permanently invalid events skipped.
- `escrowIndexerCycleFailuresTotal` — aborted cycles (transient failures, lease
  loss, metric emission errors). A lease-held skip is **not** counted here.
- `escrowIndexerLastCursorAdvanceTimestampSeconds` — set only on real cursor
  advancement.

## Tests

New focused suite: `tests/unit/escrowIndexer.concurrency.test.js` (14 tests).

| Scenario | Test |
| --- | --- |
| Racing / duplicate work | `cross-worker exclusion` — a cycle is a no-op while another worker holds the lease |
| Duplicate work | `runCycle does not count a lease-held skip as a failure` |
| Re-entrancy | `re-entrancy guard rejects overlapping runCycle calls` |
| Duplicate / idempotent replay | `replaying a duplicate event is idempotent` |
| Partial failure + retry | `a batch aborted by a transient failure is safely retried and fully persisted` |
| Transient failure aborts, cursor unmoved | `transient persistence failure aborts the cycle and does not advance the cursor` |
| Permanent invalid event is skipped | `validation failure is skipped and the cursor advances past it` |
| Classification boundary | `isSkippableEventError treats only structured validation errors as permanent` |
| Timing boundary / lease loss | `lease loss mid-batch aborts without advancing the cursor` |
| Config wiring | `leaseDurationMs is forwarded to lease acquisition` |
| Fenced atomic cursor write | `asserts the lease inside the write transaction, before the upsert` |
| Stale fence rejected | `a stale fence token prevents the cursor write entirely` |
| Unfenced path unchanged | `an unfenced cursor write does not open a transaction` |

Existing suites (`tests/unit/escrowIndexer.test.js`, `tests/escrowIndexer.test.js`)
were run before and after the change with an identical pass/fail profile; no new
failures were introduced. The pre-existing failures in those suites are caused by
the global test metrics mock omitting the escrow-indexer counters (unrelated to
this change); the new suite restores the real registry for its own assertions.

## Validation performed

- `npx jest tests/unit/escrowIndexer.concurrency.test.js` → 14/14 pass.
- `npx jest tests/unit/escrowIndexer.test.js tests/escrowIndexer.test.js` →
  unchanged 67 pass / 30 pre-existing fail (identical with the source change
  stashed).
- `npx eslint src/jobs/escrowIndexer.js tests/unit/escrowIndexer.concurrency.test.js`
  → clean (this change also fixes the two lint errors the file previously had:
  an undocumented helper and the unused `leaseDurationMs`).
- `npm run typecheck` → clean.

## Non-goals honoured

No formatting-only or cosmetic changes, no dependency upgrades, no broad
refactor, and no relaxation of validation. The only behavioural change makes
failures safer (abort + retry instead of skip + lose).
