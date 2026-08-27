# Invoice funding reconciliation

`runInvoiceFundingReconciliation` is a read-only job for finding drift inside invoice funding projections. It complements the existing escrow reconciliation job: escrow reconciliation compares a projection with the chain, while this job checks that the invoice total, funding rows, aggregate funded amount, currency, and lifecycle status agree with each other.

## Invariants

- Every funding record has a non-empty stable id and a valid non-negative fixed-point amount.
- Funding record amounts sum exactly to `fundedAmount`; comparison uses integer nanounits rather than JavaScript floating-point arithmetic.
- `fundedAmount` cannot exceed the invoice amount.
- A `funded` or `completed` invoice is funded exactly to its total.
- A `partially_funded` invoice is greater than zero and less than its total.
- `pending_verification` and `verified` invoices have no funding amount.
- A record currency, when present, matches the invoice currency.
- Duplicate funding record ids are reported rather than silently collapsed.

## Source and bounds

The caller supplies a source with `readBatch(cursor, limit)`. A production adapter should use keyset pagination on an immutable ordering and return a stable `nextCursor`. The job requests at most 1000 rows per batch and defaults to 100. `maxRecords` is an additional safety ceiling; reaching it returns `complete: false` and the cursor for an operator-controlled continuation. The source is never written.

## Report contract

The result contains the run id, status (`clean`, `drift`, or `incomplete`), scanned row and batch counts, `nextCursor`, deterministic violation counts, sorted offending ids, and each violation's stable code, message, and minimal details. The report is suitable for persistence or metrics by the caller, but the job itself does not auto-remediate: a financial mismatch requires an explicit reviewed correction.

Source failures become `SOURCE_UNAVAILABLE`; malformed adapter batches become `INVALID_SOURCE_BATCH`; invalid options become `INVALID_OPTIONS`. These typed errors avoid leaking database credentials or provider internals while allowing job infrastructure to classify failures.

## Operational use

Run the job as a bounded read-only task, persist the report with its run id, alert on `status=drift`, and retain the offending ids for investigation. Repeating the same snapshot produces the same ordering and reason counts. If data changes while scanning, use a source snapshot or a stable version boundary so that a report can be compared meaningfully across runs.
