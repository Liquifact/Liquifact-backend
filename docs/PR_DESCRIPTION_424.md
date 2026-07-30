# security: fail closed on unknown legal-hold read instead of defaulting to false

Closes #424

## Why

`src/services/escrowRead.js#fetchLegalHold` used to swallow any read-time
exception (RPC outage, timeout, circuit breaker open) and return `false`.
The gate then read `false` as "not held" and called `next()` — which meant
funding could silently proceed against an actually-held invoice during any
Soroban outage. A legal-hold read is a **compliance gate**, not a
best-effort status: the previous behaviour was equivalent to a transient
outage window in which the compliance contract was wide open.

This change introduces a tri-state contract (`held | not_held | unknown`)
across the read service, the gating middleware, and the metrics surface,
and treats `unknown` as fail-closed everywhere it can be observed.

## What changed

### `src/services/escrowRead.js`

- New public constant `LEGAL_HOLD_STATUS = { HELD, NOT_HELD, UNKNOWN }`
  and `LEGAL_HOLD_UNKNOWN_REASONS = { RPC_ERROR, ADAPTER_ERROR }`.
- New canonical coercion helper `coerceLegalHoldStatus(raw)`
  (boolean / numeric 1 / string 'true' → `held`, everything else →
  `not_held`). Exported for reuse.
- New function `fetchLegalHoldStatus(invoiceId, adapter)` returning
  `Promise<LegalHoldEnvelope>` where envelope is
  `{ status, reason?, errorCode? }` and the function **NEVER throws**.
  Reads go through `callSorobanContract` (with retry + circuit breaker).
- `fetchLegalHold` (legacy boolean) is retained for back-compat and
  delegates to `fetchLegalHoldStatus`; documented `@deprecated`.
- `readEscrowState`, `readEscrowStateWithAttestations`, and
  `getEscrowStateWithProjection` now:
  - expose the full tri-state as `state.legalHoldStatus`
  - expose failure context as `state.legalHoldReason` and
    `state.legalHoldErrorCode` so operators can investigate 'unknown'
    outcomes without re-reading service logs
  - **fail closed at the boolean layer**: `state.legal_hold === true`
    for BOTH `held` AND `unknown`. Any downstream consumer that
    branches on `if (!state.legal_hold)` cannot accidentally fund an
    unreadable invoice.

### `src/middleware/legalHoldGate.js`

Tri-state aware. Routing:

| `fetchLegalHoldStatus(...)` | HTTP outcome                | Counter / log |
|-----------------------------|-----------------------------|---------------|
| `held`                      | `423 Locked` RFC 7807       | `legal_hold_blocks_total{outcome="held"}++` |
| `not_held`                  | `next()` (fundable)         | — |
| `unknown` (RPC error)       | `503 Service Unavailable`   | `legal_hold_unknown_blocks_total{reason="rpc_error"}++` + structured warn |
| `unknown` (adapter throw)   | `503 Service Unavailable`   | `legal_hold_unknown_blocks_total{reason="adapter_error"}++` + structured error log |

The 503 response uses problem-type
`https://liquifact.com/probs/legal-hold-status-unavailable` with a
detail that explicitly mentions "fail-closed" so on-call can grep for
the policy in Grafana / log search.

Production path with no adapter goes through `fetchLegalHoldStatus`.
For pre-existing tests that mock only `fetchLegalHold`, the gate falls
back through `fetchLegalHold` wrapped in try/catch — `true → held`,
`false → not_held`, `throw → unknown`. This is documented inline and is
the LESS strict fallback (the production path is stricter).

Module-level fallback constants
(`FALLBACK_LEGAL_HOLD_STATUS`, `FALLBACK_LEGAL_HOLD_UNKNOWN_REASONS`,
`_fallbackCoerceLegalHoldStatus`) guarantee the gate still loads when
`jest.mock`'d test surfaces strip the canonical exports.

### `src/metrics.js`

- New counter `legal_hold_unknown_blocks_total{reason}` — single
  source of truth for unknown-blocks. `reason` labels stay
  low-cardinality (`rpc_error` / `adapter_error` /
  `service_unavailable`) so dashboards remain cheap.
- New counter `legal_hold_blocks_total{invoiceId, outcome}` for
  verified-hold blocks; the per-invoiceId label is debug-only.
- Helpers `incrementLegalHoldUnknownBlocks` and
  `incrementLegalHoldBlocks` exported alongside a backwards-compat
  shim `incrementMetric('legal_hold_blocked_attempts', labels)` that
  routes the pre-existing call site through to the new counter.
- The `CounterShim` / `GaugeShim` test shims expose `hashMap` so tests
  can `counter.get({reason: ...})` deterministically without parsing
  internal key formats.
- Hoisted `const registry = new client.Registry()` to BEFORE the first
  counter construction, fixing a pre-existing TDZ ReferenceError that
  was masked because every consumer of the module was `jest.mock`'d.

### `tests/escrow.legalhold.test.js`

Rewritten jest-only (no mocha/chai/sinon — none are in
`package.json` devDependencies). 5 describe blocks:

- `escrowRead.validateInvoiceId` — input validation.
- `fetchLegalHold (legacy boolean projection)` — back-compat surface.
- `fetchLegalHoldStatus (tri-state)` — held, not_held, RPC error,
  generic error, no-throw contract, canonical enum exposure.
- `readEscrowState — fail-closed at the data layer` — `legal_hold`
  fails closed (`true`) on `unknown`, `legalHoldStatus` exposes
  tri-state, `INVALID_INVOICE_ID` surfaces for empty / traversal.
- `legalHoldGate() — tri-state routing` — 423 / 200 / 503 verify,
  problem+json content type, dedicated unknown-blocks counter
  increments, structured `legal_hold_status_unavailable` warn log,
  throwing adapter falls closed, 400 on missing invoiceId, legacy
  boolean adapter coerced.

`beforeEach` calls `.reset()` on the counter shims so the strict
`expect(after - before).toBe(1)` assertion is deterministic across
test orderings.

Plus:
- Drift guard test "canon LEGAL_HOLD_STATUS strings match the
  documented tri-state" so future renames fail loudly.
- New describe "legalHoldGate() — fallback when service module is
  unconfigured" exercises the `service_unavailable` early-exit branch
  using `jest.resetModules + jest.doMock`.

### `docs/compliance.md`

Added a "Legal-Hold Compliance Gate — Fail-Closed Policy (issue
#424)" section documenting:

- Tri-state semantics (`held` / `not_held` / `unknown`).
- Read-side fail-closed behaviour of `state.legal_hold === true` on
  both `held` AND `unknown`.
- Operational runbook: alert on
  `rate(legal_hold_unknown_blocks_total[5m]) > 0`, group by `reason`
  (`rpc_error` / `adapter_error` / `service_unavailable`), per-invoiceId
  triage via the structured warn log or
  `state.legalHoldErrorCode`, sum both `legal_hold_blocks_total` and
  `legal_hold_unknown_blocks_total` for total blocked counts. Explicit
  "no manual override" rule — operators do NOT have a "skip gate"
  knob; the only safe remediation is waiting for upstream and retrying.

## Validation

- `npx jest tests/escrow.legalhold.test.js` — passes the new tri-state
  suite, the drift guard, and the `service_unavailable` fallback.
- `npx eslint src/services/escrowRead.js src/middleware/legalHoldGate.js
  src/metrics.js tests/escrow.legalhold.test.js` — clean on touched
  lines.
- `npx tsc -p tsconfig.json --noEmit` — clean.

Pre-existing baseline issues (`redis` pkg missing, retention.js Babel
parse) are unrelated to this branch and were left untouched.

## Backwards compatibility

- `readEscrowState(...)` consumers: existing fields preserved,
  `state.legal_hold` continues to be a boolean. `state.legalHoldStatus`
  and `state.legalHoldReason` are additive.
- `legalHoldGate()` callers: factory signature unchanged. The 423
  behaviour on a verified hold is identical. The 200 behaviour on a
  verified not-held is identical. The 503 behaviour on an unreadable
  read is NEW and is the whole point of the change.
- Existing tests (`tests/invest.list.test.js`,
  `tests/invest.batched_list.test.js`,
  `tests/health.readiness.test.js`,
  `tests/app.routes.test.js`) that mock only `fetchLegalHold` work
  through the new `fetchLegalHold` fallback path — no mock surface
  change required.

## Risk and migration notes

- No schema changes.
- No DB migrations.
- Metrics ARE new; dashboards/alerts referencing the pre-existing
  `legal_hold_blocked_attempts` (which was never registered) are now
  served by `legal_hold_blocks_total{outcome="held"}` and
  `legal_hold_unknown_blocks_total{reason}`.
- Operations must add a Grafana alert on
  `rate(legal_hold_unknown_blocks_total[5m]) > 0` so Soroban outages
  are visible immediately rather than only at reconciliation time.
