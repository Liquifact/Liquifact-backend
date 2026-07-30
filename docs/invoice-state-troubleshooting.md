# Invoice-State Troubleshooting Guide

Symptom-oriented companion to [`docs/invoice-state.md`](invoice-state.md)
(the API/error-code reference) and
[`docs/runbook-invoice-state.md`](runbook-invoice-state.md) (the operator
runbook for infra-level failure modes — auth, rate limiting, DB, KYC). This
doc is for "I made a request and got an error I don't understand" — API
integrators and on-call engineers diagnosing a specific invoice-state
response.

For the full, authoritative error-code table (code → HTTP status → which
endpoint(s) → meaning), see
[`docs/invoice-state.md` §6.2](invoice-state.md#62-complete-error-code-table).
This guide references that table rather than repeating it, and links
straight to the source line implementing each check where useful.

---

## How to read an invoice-state error

Every single-invoice endpoint (`/:id/state`, `/:id/transition`,
`/:id/approve`, `/:id/reject`, `/:id/link-escrow`, `/:id/history`) returns
errors with a machine-readable `error.code` field. **Always branch on
`code`, never on `error.message`** — messages are for humans and can change
without notice; codes are the stable contract.

```json
{
  "error": {
    "code": "TERMINAL_STATE",
    "message": "Invoice is in a terminal state and cannot transition.",
    "details": null
  }
}
```

`POST /bulk` is the one exception — see
[Bulk operations: per-item errors are always 200](#bulk-operations-per-item-errors-are-always-200)
below.

---

## Common scenarios

### "I got 404 INVOICE_NOT_FOUND, but I know the invoice exists"

**Cause:** invoice lookups are tenant-scoped
(`invoiceService.resolveInvoiceForTenant`, `src/services/invoiceService.js`)
— a real invoice belonging to a *different* tenant returns the exact same
404 as a genuinely missing one. This is intentional: it prevents an
attacker from distinguishing "wrong tenant" from "doesn't exist" via timing
or response-shape differences.

**Fix:** confirm the `x-tenant-id` header (or the authenticated JWT's
tenant claim) matches the tenant that actually owns the invoice. See
[`docs/runbook-invoice-state.md` §"Missing tenant context"](runbook-invoice-state.md#2-missing-tenant-context)
for how tenant context is resolved.

### "I got TERMINAL_STATE or INVALID_TRANSITION and I'm not sure why"

**Cause:** you're attempting a transition the state machine doesn't allow
from the invoice's *current* state. The valid transitions are:
`pending → approved | rejected | cancelled` and
`approved → linked_escrow | rejected | cancelled`; `linked_escrow`,
`rejected`, and `cancelled` are terminal (see
[`docs/invoice-states.md`](invoice-states.md) for the full diagram).

**Fix:** call `GET /api/invoices/:id/state` first — the response's
`allowedTransitions` array is the authoritative list of what you can do
*right now*. `INVALID_TRANSITION` errors additionally echo this same list
in `error.details.allowedTransitions`, so you don't need a second request
just to recover from the error.

### "I got MISSING_TRANSITION_REASON on approve, but not on reject"

**Cause:** a `reason` is required for transitions *into* the states listed
in `REASON_REQUIRED_TARGETS` (`src/services/invoiceStateMachine.js`) —
currently `rejected` and `cancelled`, not `approved`. `POST /:id/approve`
still accepts an optional `reason` (defaults to `'Invoice approved'` if
omitted); `POST /:id/reject` requires a non-empty one.

**Fix:** supply a non-empty `reason` string (max 1024 chars —
`TRANSITION_REASON_TOO_LONG` otherwise) when rejecting or cancelling.

### "I got CANNOT_LINK_TO_ESCROW"

**Cause:** `POST /:id/link-escrow` requires the invoice to currently be
`approved` — `canLinkToEscrow()` (`src/services/invoiceStateMachine.js`)
rejects any other state, including `pending` (approve it first) and
`linked_escrow` (already linked — this isn't idempotent).

**Fix:** check `GET /:id/state` for the current status; approve the
invoice first if it's still `pending`. If the KYC gate is also involved
(a `403 KYC_GATE_FAILED` or `MISSING_SME_ID`, not this code), see
[`docs/runbook-invoice-state.md` §"KYC gate rejection"](runbook-invoice-state.md#5-kyc-gate-rejection-on-link-escrow).

### "I got 409 TRANSITION_CONFLICT"

**Cause:** invoice-state writes use optimistic concurrency control — the
service reads the current status, validates the transition against it,
then writes conditionally on that status still being unchanged
(`invoiceService.transitionInvoice`'s `expectedStatus` check). If another
request wins the race and changes the status first, your write is
rejected with `409` instead of silently overwriting the winner's change or
producing a corrupted state.

**Fix:** this is expected, safe-to-retry behaviour under concurrent
writes to the same invoice, not a bug. Re-fetch `GET /:id/state` and
retry — your request will either succeed against the new state or surface
a state-specific error (e.g. `TERMINAL_STATE` if the winner's transition
made the invoice terminal). If you see this *without* concurrent callers,
that's a genuine signal worth investigating (a duplicate client retry
storm, or a stuck/looping caller).

### "My deployment doesn't emit TRANSITION_CONFLICT at all — is that a bug?"

No — it means nothing has raced yet in that environment. It's naturally
rare outside concurrent-load conditions, which is exactly why it's easy to
miss when first building an error-handling matrix for this API — call it
out explicitly if you're writing client-side retry logic.

---

## Bulk operations: per-item errors are always 200

`POST /api/invoices/bulk` processes a bounded array (max 25) of operations
sequentially and **never fails the whole batch because one item failed** —
by design, so one bad row doesn't block 24 good ones. This makes its error
model different enough from every other invoice-state endpoint that it
deserves its own section:

- **Batch-level validation** (checked before any item runs) still returns a
  real HTTP error status: `400 INVALID_BATCH_TYPE` (body isn't a JSON
  array), `400 EMPTY_BATCH` (empty array), `400 BATCH_OVER_CAP` (more than
  25 items).
- **Once processing starts, the HTTP response is always `200`** — even if
  *every* item failed. Success/failure lives entirely in the response
  body:

```json
{
  "data": {
    "results": [
      { "index": 0, "success": true, "action": "approve", "result": { "...": "..." } },
      { "index": 1, "success": false, "error": "Invoice not found", "code": "INVOICE_NOT_FOUND" }
    ],
    "summary": { "total": 2, "succeeded": 1, "failed": 1 }
  }
}
```

**If your integration only checks the HTTP status code, you will silently
miss per-item failures.** Always check `summary.failed` and inspect
`results[].success` / `results[].code` for each item.

Per-item `code` values include the batch-scoped validation codes
(`MISSING_INVOICE_ID`, `MISSING_ACTION`, `INVALID_ACTION`,
`MISSING_TARGET_STATE` for a `transition` item without `targetState`) and
any single-invoice code from the table above (`INVOICE_NOT_FOUND`,
`TERMINAL_STATE`, `TRANSITION_CONFLICT`, etc.) — the dispatch reuses the
exact same `approve`/`reject`/`linkEscrow`/`transition` service functions
as the single-invoice endpoints, so a `link-escrow` item can fail with
`CANNOT_LINK_TO_ESCROW` the same way a direct `POST /:id/link-escrow` call
would. `BULK_ITEM_ERROR` is a defensive fallback for the (should-not-happen)
case of a thrown error with no `.code` at all.

Note: `POST /bulk` isn't yet documented in `docs/invoice-state.md`'s
endpoint reference (§5) — flagging that as a known gap in this repo's docs
rather than silently working around it; out of scope to fix here since
this guide is specifically about errors, not the full request/response
schema.

---

## Cross-references

- [`docs/invoice-state.md`](invoice-state.md) — full API reference,
  including the complete error-code table this guide links into.
- [`docs/invoice-states.md`](invoice-states.md) — the state machine's
  diagram, transition matrix, and guards.
- [`docs/runbook-invoice-state.md`](runbook-invoice-state.md) — operator
  runbook for infra-level failures (auth, tenant resolution, rate
  limiting, KYC gating, DB/persistence errors) and recovery procedures.
- `src/services/invoiceStateMachine.js` — canonical transition rules and
  the `messageMap` every state-machine error code is drawn from.
- `src/services/invoiceStateService.js` — `processBulkOperations` (the
  bulk dispatch logic) and the single-invoice service functions it reuses.
- `src/middleware/invoiceStateErrorHandler.js` — how a thrown
  `StateTransitionError` becomes an HTTP response (`resolveStatus`).
