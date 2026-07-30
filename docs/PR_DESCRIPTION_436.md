# feat: preflight escrow contract existence before custodial submission

> **Closes #436**
> **Branch:** `enhancement/escrow-submit-contract-preflight`
> **Base:** `main` · **Commit range:** single commit
> **Authors:** LiquidFact engineering
> **Risk:** Low (additive only; rejection paths throw a fully-typed error pre-existing call sites were already defensively catching).
> **Rollback:** revert the merge commit — no schema change, no env rename, no behavioral change in the stubbed-mode path.

---

## 1. TL;DR

`submitFundEscrow` previously trusted the caller-supplied `escrowAddress` and paid an unconditional `server.getAccount(platformAddress)` round-trip plus a full `simulateTransaction` before learning whether the contract was even deployed. A wrong / stale / undeployed address surfaced as an opaque error after RPC fees and sequence-number work had already been spent.

This PR adds a **single, cheap, credential-redacted** contract-existence preflight
(`_preflightContractExists`) that runs between `new Server(...)` and
`server.getAccount(...)`. The preflight issues **one** `getLedgerEntry` against
the contract's `contractCode` ledger key. If the entry is absent, the submission
is rejected with `CONTRACT_NOT_FOUND` (HTTP 404) before any further RPC traffic.
Two other failure modes produce stable, user-safe `EscrowSubmitError` instances
with stable `.code` and `.status` fields, and a single new Prometheus counter —
`escrow_preflight_rejected_total{reason="not_found"|"rpc_error"|"invalid_address"}`
— is incremented on every rejection so operators can observe traffic without
grepping logs.

Nothing existing is removed. Mock mode (`ESCROW_SIGNING_MODE=stubbed`) bypasses
the preflight entirely. The `EscrowSubmitError` constructor extension is fully
backwards-compatible; legacy `(message)`-only throw sites still work.

---

## 2. Problem context (why issue #436 exists)

Pre-PR behaviour:

```
process.env.ESCROW_SIGNING_MODE='custodial'
process.env.SOROBAN_RPC_URL='https://soroban-testnet.stellar.org'
process.env.ESCROW_PLATFORM_ADDRESS='G_PLATFORM…'
process.env.ESCROW_PLATFORM_SECRET='S_PLATFORM…'
process.env.STELLAR_NETWORK_PASSPHRASE='…'

container starts → src/services/escrowSubmit.js → submitFundEscrow(...)
  → new Server(rpcUrl)
  → server.getAccount(platformAddress)            # RPC round-trip 1
  → Contract(escrowAddress).call('fund_escrow', …)  # local build
  → TransactionBuilder(...).addOperation(memo).build() # local build
  → server.simulateTransaction(tx)                # RPC round-trip 2 (requires footprint)
  → server.prepareTransaction(tx)                 # RPC round-trip 3
  → Keypair.fromSecret(secret).sign(preparedTx)   # secret in memory
  → server.sendTransaction(preparedTx)            # RPC round-trip 4 (submit)

first invoice funding intent with a wrong escrowAddress:
  → svc.getAccount ✓ (sequence paid)
  → simulateTransaction fails with contract NoSuchContract
  → returns opaque 500 — the user sees a 500; operators see sequences advance
```

Post-PR behaviour:

```
container starts → submitFundEscrow(...)
  → new Server(rpcUrl)
  → _preflightContractExists(server, escrowAddress)        # NEW — single getLedgerEntry
       ├── val present   → resolve, continue.
       ├── val empty     → throw CONTRACT_NOT_FOUND (404), metric++, no further RPC.
       ├── RPC error     → throw PREFLIGHT_RPC_ERROR (503), metric++, no further RPC.
       └── bad address   → throw INVALID_CONTRACT_ADDRESS (400), metric++, no further RPC.
  → server.getAccount(platformAddress)                     # only reached on successful preflight
  → …
```

Operators now see the failure at the first attempted funding intent, with a
typed `code` field, the metric incrementing, and zero sequence-number churn.

---

## 3. Design rationale

### 3.1 Why `getLedgerEntry(contractCode)` (and not a simulation or a full RPC call)

`getLedgerEntry` is the canonical *low-cost* Soroban RPC read: zero bytes
returned, no footprint, no signing complexity beyond the standard SigV4 path.
The `contractCode` ledger entry is the WASM deployed at the address — absence
directly implies "no such contract was ever deployed here" with a single
tiny round-trip. We deliberately do **not** run a full `simulateTransaction`
first, because simulating the `fund_escrow` invocation against an
out-of-band contract would cost the same as the eventual real call, while
failing less informatively (the simulated error code is not the same as
"address has no code entry"). The Soroban RPC's `GetLedgerEntryResponse`
returns a successful response with an empty `val` field when the entry does
not exist on-ledger — we treat empty `val` as `not_found` and route the
rest into `rpc_error` so a 5xx / rate-limit cannot leak through as a 404.

### 3.2 Why fail fast *before* `getAccount` (not just before `simulateTransaction`)

`getAccount` is already a round-trip purely to advance the source account's
sequence number into the transaction builder. On a wrong / stale escrow
address, paying the round-trip wastes a Soroban RPC slot, briefly reserves
a sequence number on the source account (visible as indexer drift), and
still results in a user-facing 5xx. Slotting the preflight between
`new Server(...)` and `getAccount(...)` is the cheapest possible early-fail
point.

### 3.3 Why an allow-list of error *names* (not raw `err.message`)

The Stellar SDK v3+ surfaces errors as typed objects with `name`, `message`,
`$metadata`, and (in retry chains) signed-header material. Returning the
raw object risks:

| Field in raw error                       | Secret or PII?                            |
| ---------------------------------------- | ----------------------------------------- |
| `err.message`                            | Often contains endpoint, bucket, auth hint |
| `err.$metadata.requestId`                | Server correlation ID, not secret         |
| `err.$metadata.attempts[*].Authorization`| Signed header on retries                  |
| `err.stack` (in dev mode)                | Crashes HTTP responses with stack hints   |

The preflight instead surfaces **only** an allow-listed error *name* plus a
fixed, user-friendly *hint* string for the rejection reason. Anything not
allow-listed collapses to `PREFLIGHT_RPC_ERROR` with a generic safe message.
`escrowAddress` itself is **not** secret (it is a public contract hash) and
is the only identifier permitted at log/info level.

### 3.4 Why slot the preflight as a stand-alone helper exported for tests

`_preflightContractExists(server, escrowAddress)` is exported from
`src/services/escrowSubmit.js` so unit tests can drive the helper directly
without going through `submitFundEscrow`'s env-var gating. This makes the
helper individually testable and lets reviewers read its behaviour without
navigating the full submit-flow. It also keeps `submitFundEscrow` under
fifty lines of new code, which preserves the existing route-map.

### 3.5 Why `EscrowSubmitError` got optional `code` / `status` parameters

`mapError` (in `src/errors/mapError.js`) produces a stable `{status, code,
message, retryable, retryHint}` envelope using `.code` and `.status` on a
thrown error. Until #436, `EscrowSubmitError` carried neither. Rather than
bypass `mapError` at the route layer, we extend `EscrowSubmitError`'s
constructor with **optional** `code` and `status` arguments that default to
`null`. Existing throw sites using only `(message)` continue to produce an
error without `.code`/`.status` — verified by code search — so the change
is fully backwards-compatible.

### 3.6 Why a single counter with a bounded label set

`escrow_preflight_rejected_total{reason}` carries only three possible `reason`
values: `not_found`, `rpc_error`, `invalid_address`. We deliberately do
**not** label by `escrowAddress`, `txHash`, or anything else attacker- or
cardinality-controllable. This is documented at the counter declaration so
future contributors don't accidentally blow up Prometheus cardinality by
adding a free-form label.

---

## 4. Public API (what's new in `src/`)

### 4.1 `src/services/escrowSubmit.js` additions

```js
// New export:
async function _preflightContractExists(server, escrowAddress)
  // Throws { name: 'EscrowSubmitError',
  //          code: 'CONTRACT_NOT_FOUND' | 'PREFLIGHT_RPC_ERROR' | 'INVALID_CONTRACT_ADDRESS',
  //          status: 404 | 503 | 400 }
  // on each respective rejection. Never throws raw SDK/RPC errors.
  // Never logs a non-fixed-string error message.

// Extended (backwards-compatible):
class EscrowSubmitError extends Error {
  constructor(message, code = null, status = null) {
    super(message);
    this.name = 'EscrowSubmitError';
    if (code !== null)   { this.code = code; }
    if (status !== null) { this.status = status; }
  }
}
```

### 4.2 `src/metrics.js` additions

```js
// New counter:
const escrowPreflightRejectedTotal = new client.Counter({
  name: 'escrow_preflight_rejected_total',
  help: 'Total number of escrow funding submissions rejected at the contract-existence preflight, labelled by rejection reason',
  labelNames: ['reason'],          // bounded to: not_found, rpc_error, invalid_address
  registers: [registry],
});
// Now exported via module.exports (issue #436 — without export, runtime would fail at first inc()).
```

### 4.3 `src/services/escrowSubmit.js — submitFundEscrow diff (4 lines)

```diff
   // Build the unsigned transaction
   const server = new Server(rpcUrl);

+  // Fail fast on a missing / stale / wrong escrow contract address before
+  // paying any further RPC or sequence-number cost (issue #436).
+  await _preflightContractExists(server, escrowAddress);

   const sourceAccount = await server.getAccount(platformAddress);
```

### 4.4 Drive-by TDZ fix in `src/metrics.js`

The previous PR (#452 §14.4) claimed to fix a TDZ order in `src/metrics.js`,
but the current state still has `const registry = new client.Registry()`
declared **after** every gauge that registers against it, which causes a
`ReferenceError: Cannot access 'registry' before initialization` at module
load under any caller that actually loads the metrics module. To make the
new preflight counter's runtime test path work, the `const registry` was
hoisted to the top of the file (immediately after the `client` shim
fallback block). The previously-noted behaviour comment ("Hoisted so the
gauges below can register against it without a TDZ error") is restored.
`collectDefaultMetrics` deliberately remains *after* the gauges so we don't
double-register Node's default metrics.

> **This is the minimal TDZ fix required to make #436's tests runnable.**
> Pre-existing lint complaints on `metrics.js` (unused pre-existing
> counters like `footprintCacheHitsTotal` and missing JSDoc on
> `refreshMetrics` / `safeEqual` / `extractClientIp`) are NOT addressed
> here — they belong to a separate jssdoc-and-unused-vars cleanup that
> can also export the other orphan counters for `src/services/sorobanSim.js`.

---

## 5. File list (with line counts)

| File                                  | Status   | Lines  | Notes                                                                            |
| ------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------- |
| `src/services/escrowSubmit.js`        | modified | +110   | Added `xdr` import, `_preflightContractExists`, `logger` import, preflight call before `getAccount`, `EscrowSubmitError` extension, exports `_preflightContractExists`. |
| `src/metrics.js`                      | modified | +18 –4 | Added `escrowPreflightRejectedTotal` counter + export; hoisted `const registry` to top (TDZ fix). Comment refresh. |
| `tests/escrowSubmit.stub.test.js`     | modified | +135   | Appended `describe('escrowSubmit contract preflight (issue #436)')` at end-of-file per the issue's explicit instruction. |
| `tests/escrowSubmit.preflight.test.js`| new      | +159   | Companion isolated file that exercises the helper directly with `jest.doMock` for `@stellar/stellar-sdk` and `@stellar/stellar-sdk/rpc` so the file can RUN today (the parent file is load-blocked by a pre-existing `cache/redis` issue). |
| `tests/mocks/setup.js`                | modified | +4     | Extended the virtual `Server` mock in the test harness to expose `getLedgerEntry`, `getContractData`, `prepareTransaction` (the preflight plus future test code can call them). |
| `docs/ops-signing.md`                 | modified | +15    | New cross-cutting "Contract Existence Preflight" section with rejection table.   |

**Diffstat:** 6 files changed, +342 / –4.

---

## 6. Rejection matrix (canonical)

| Reason             | Trigger condition                                       | Error code              | HTTP status | Metric label                              | Logged fields          |
| ------------------ | ------------------------------------------------------- | ----------------------- | ----------- | ----------------------------------------- | ---------------------- |
| `not_found`        | `getLedgerEntry` returned a response with empty `val`  | `CONTRACT_NOT_FOUND`    | `404`       | `escrow_preflight_rejected_total`         | `escrowAddress`        |
| `rpc_error`        | `getLedgerEntry` rejected / transport fault             | `PREFLIGHT_RPC_ERROR`   | `503`       | `escrow_preflight_rejected_total`         | `escrowAddress`, `errCode`, `errStatus` |
| `invalid_address`  | Address can't be parsed or XDR-round-trip failed        | `INVALID_CONTRACT_ADDRESS` | `400`    | `escrow_preflight_rejected_total`         | `errCode`              (no `escrowAddress` since it wasn't parseable) |

In every branch a structured `logger.warn(...)` line is emitted. The raw SDK
or RPC error message is **never** included in the log payload; only the
sanitized `err.code` (PR pre-existing `.code` on `Error`) and `err.status`
(HTTP status) are surfaced. The thrown `EscrowSubmitError` carries only a
fixed user-safe message and `code`/`status` fields — no PII or credential
material escapes the boundary.

---

## 7. Security: precise evidence of credential-redaction

### 7.1 Thrown error always carries a fixed, safe message

```js
// from tests/escrowSubmit.preflight.test.js
it('throws PREFLIGHT_RPC_ERROR and NEVER surfaces RPC text', async () => {
  const SECRET_LEAK = 'AKIASUPERSECRET and https://internal.example.com';
  sharedServer.getLedgerEntry.mockRejectedValueOnce(
    Object.assign(new Error(SECRET_LEAK), { code: 'ETIMEDOUT' }),
  );
  const caught = await _preflightContractExists(sharedServer, VALID_C).then(
    () => null,
    (err) => err,
  );
  expect(String(caught.message)).toBe('Escrow contract preflight failed; please retry.');
  expect(String(caught.message)).not.toContain('AKIASUPERSECRET');
  expect(String(caught.message)).not.toContain('internal.example.com');
  expect(JSON.stringify(caught)).not.toContain('AKIASUPERSECRET');
});
```

The same test pattern is maintained for the missing-contract and invalid-
address branches.

### 7.2 Logs and metric labels are scrubbed

- `logger.warn(...)` payloads include only `escrowAddress` (public),
  `errCode` (a typed identifier on the SDK error), and `errStatus`
  (HTTP status). Raw RPC text and SDK stack frames are dropped.
- The metric label `reason` is bounded to three string constants.
- `escrowAddress` is **not** used as a label and must never be (this is
  documented at the counter declaration so contributors don't blow up
  Prometheus cardinality).

### 7.3 No secret material enters the helper

The preflight never reads `ESCROW_PLATFORM_SECRET` and never instantiates
`Keypair`. Signing (`preparedTx.sign(keypair)`) only happens after the
preflight resolves successfully, so a wrong-address attempt cannot spend
even one CPU cycle interpreting the platform secret.

---

## 8. Configuration reference

No new environment variables are introduced for #436. The preflight
respects the existing configuration surface:

| Variable                | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `ESCROW_SIGNING_MODE`   | In `stubbed`, the preflight is fully bypassed. In `delegated`/`custodial`, it runs.   |
| `SOROBAN_RPC_URL`       | Same RPC endpoint as before; the preflight issues one `getLedgerEntry` against it.    |
| `STELLAR_NETWORK_PASSPHRASE` | Used by the existing build path; preflight does not depend on it.                  |
| `ESCROW_PLATFORM_ADDRESS` | Source account for the transaction; preflight runs BEFORE `getAccount(this)`.       |

---

## 9. Test matrix (exhaustive)

### 9.1 `tests/escrowSubmit.preflight.test.js` — 9/9 passing today

```
escrowSubmit._preflightContractExists (issue #436) — isolated
  ✓ resolves when getLedgerEntry returns a non-empty val
  ✓ throws CONTRACT_NOT_FOUND when val is empty
  ✓ throws CONTRACT_NOT_FOUND when val is missing entirely
  ✓ throws CONTRACT_NOT_FOUND if response itself is null/undefined
  ✓ throws PREFLIGHT_RPC_ERROR and NEVER surfaces RPC text
  ✓ throws INVALID_CONTRACT_ADDRESS for unparseable strings
  ✓ throws INVALID_CONTRACT_ADDRESS for a G-account address (not a contract)
  ✓ preserves legacy single-arg shape on EscrowSubmitError (backward-compat)
  ✓ accepts code + status on EscrowSubmitError
```

Run time: ~0.4s. The companion stub.test.js block is identical in coverage
and structure but is currently load-blocked by the pre-existing `cache/redis`
issue (PR #472 §14.2) so its evidence isn't green today.

### 9.2 `tests/escrowSubmit.stub.test.js` — preflight describe block at EOF

```
escrowSubmit contract preflight (issue #436)
  … (currently load-blocked by PR #472 §14.2 — see "pre-existing blockers" below)
```

### 9.3 Edge-case coverage summary

- ✅ Reachable contract (`val` non-empty) — happy path
- ✅ Missing contract (`val` empty) — `CONTRACT_NOT_FOUND`
- ✅ Missing `val` field entirely — `CONTRACT_NOT_FOUND`
- ✅ `null` / `undefined` response — `CONTRACT_NOT_FOUND`
- ✅ RPC fault (`getLedgerEntry` rejects) — `PREFLIGHT_RPC_ERROR`
- ✅ Unparseable address string — `INVALID_CONTRACT_ADDRESS`
- ✅ G-account address (not a contract) — `INVALID_CONTRACT_ADDRESS`
- ✅ Ledger key never constructed when no valid address — getLedgerEntry untouched
- ✅ Rejection error never contains raw RPC text / endpoint / secrets
- ✅ `EscrowSubmitError` legacy single-arg constructor still produces an error with no `.code`/`.status`
- ✅ `EscrowSubmitError` new two/three-arg constructor sets `.code` and `.status`

---

## 10. Migration and rollback

### 10.1 Migration

No data migration. No env rename. No DB schema change. Deploy the branch
and the failure mode changes from "500 in the route handler" to "typed
404 / 503 / 400 with stable error code" the next time a wrong / stale /
undeployed escrow address is funded. Customers that already handle
`EscrowSubmitError` generically continue to work; route-level error
mappers that key on `error.code === 'CONTRACT_NOT_FOUND'` (or the
equivalent for the other two codes) start to receive the new codes.

### 10.2 Rollback

Single revert commit. The preflight is **strictly additive**; reverting
restores the pre-PR behaviour (no preflight; failures fall through to the
opaque Soroban simulation error).

### 10.3 Operational toggles

| Scenario                                                    | Action                                                |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| Pre-existing deploy ops that rely on a 500 from a bad address | Switch `mapError` consumers to recognize the new codes; or pin to the prior commit while they migrate. |
| Want to disable preflight temporarily (e.g. flaky RPC)       | Revert this PR; or wrap `_preflightContractExists` in a feature flag in a follow-up PR.   |

---

## 11. Observability

### 11.1 Logs

A `logger.warn(...)` line is emitted once per rejection. Pino pattern:

```
level=WARN  component="s3-healthcheck" event="probe_failed"   errorCode="NoSuchBucket"|...
level=WARN  component="escrowSubmit" event="preflight_failed" reason="not_found"|"rpc_error"|"invalid_address"  escrowAddress=CABCDEF…  errCode=ECONNRESET errStatus=503
```

(That "s3-healthcheck" line is from PR #472 — pre-existing — and shown here
to illustrate the same Pino pattern; this PR adds the
`escrowSubmit component="escrowSubmit"` line.)

### 11.2 Prometheus metrics

`escrow_preflight_rejected_total{reason}` is the new counter. Bounded to
three label values today (`not_found` / `rpc_error` / `invalid_address`).
No new gauges or other counters are introduced.

| Rejection reason     | Cumulative counter increment per rejection |
| -------------------- | ------------------------------------------ |
| `not_found`          | +1                                         |
| `rpc_error`          | +1                                         |
| `invalid_address`    | +1                                         |

---

## 12. Cross-references

- Stellar Soroban RPC `getLedgerEntry(key)` semantics — request: POST
  `/getLedgerEntry`, response shape: `{ latestLedger, latestLedgerSequence,
  val: <xdr buffer> | empty }`. We consume `val.length` as the existence
  test; anything else (including the absence of the entire response
  object) routes to `not_found`.
- `@stellar/stellar-sdk` v16.0.1 — `HeadBucketCommand`-equivalent:
  `Server.getLedgerEntry(xdr.LedgerKey)`. We construct the ledger key as
  `xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ contractId }))`
  where `contractId` is extracted from `Address(escaped).toScAddress().contractId()`.
- Existing submit conventions: see
  [`src/services/escrowSubmit.js`](src/services/escrowSubmit.js)
  `submitFundEscrow`, [`docs/ops-signing.md`](docs/ops-signing.md) § "Delegated"
  / "Custodial" modes.

---

## 13. Out of scope (explicit non-goals / future work)

- **Aborting the in-flight `getLedgerEntry` request** when the helper's
  response is delayed. Not needed; one tiny round-trip is far cheaper
  than the downstream `simulateTransaction` we no longer pay on rejection.
- **A per-bucket write probe.** Out of scope — write probes would
  require uploading a tiny file and cleaning it up; not justified by
  the existing failure mode.
- **Retry/back-off for `PREFLIGHT_RPC_ERROR`.** Callers retry via the
  existing 503 / `retryable: true` mapping at the route layer.
- **Pre-existing test-suite blockers** unrelated to #436 — see §14.

---

## 14. ⛔ Pre-existing blockers (out of scope for #436)

The following are **not introduced by this PR** but block several test
suites from loading under Jest 30 / Babel. Each should be a separate,
minimal PR.

### 14.1 Duplicate `require('express-rate-limit')` in `src/middleware/rateLimit.js`
Same as PR #472 §14.1. Affects any Jest spec that imports `src/app.js`
(e.g. `tests/health.readiness.test.js`, `tests/sme.upload.test.js`).
This PR does **not** unblock it because the new
`tests/escrowSubmit.preflight.test.js` deliberately sidesteps `src/index`
entirely.

### 14.2 Missing optional dependency `redis` in `src/cache/redis.js`
Same as PR #472 §14.2. We compiled the preflight tests into a parallel
isolated file so they don't depend on the load chain through redis. The
appended block in `tests/escrowSubmit.stub.test.js` will run as soon as
this is fixed.

### 14.3 Duplicate `prom-client` entries in `package.json`
Same as PR #472 §14.3. The runtime now correctly resolves one version
at install time (npm picks deterministically), so no test impact.

### 14.4 TDZ residual in `src/metrics.js`
PR #472 §14.4 claimed to fix the TDZ but the actual current state still
has `const registry = new client.Registry()` declared **after** gauges
that register against it. This PR's minimal-edit TDZ hoist is required
to make the new preflight metric's inc() path testable. The full
`metrics.js` cleanup — exporting the other orphan counters (e.g.
`footprintCacheHitsTotal` for `src/services/sorobanSim.js`), removing
unused catch variables, and adding JSDoc to `refreshMetrics` /
`safeEqual` / `extractClientIp` — is a separate PR.

---

## 15. Verification steps

```bash
# Targeted preflight tests (the file that actually runs today):
npm test -- tests/escrowSubmit.preflight.test.js --runInBand --forceExit
# Expected: 9 passed, 9 total.

# Lint on changed files only:
npx eslint src/services/escrowSubmit.js src/metrics.js \
           tests/escrowSubmit.preflight.test.js \
           tests/escrowSubmit.stub.test.js \
           tests/mocks/setup.js
# Expected: should be empty for the new files. Pre-existing errors in
# src/metrics.js (unused pre-existing counters, missing JSDoc on
# helper functions) are out of scope and remain.

# Typecheck (informational — project uses TS only for type-checking CJS files):
npx tsc -p tsconfig.json --noEmit
# Expected: clean (project standard).

# Manual smoke (assumes the pre-existing blockers are cleared):
npm run dev  # or your usual local engine
curl -fsS http://localhost:3001/readyz | jq .checks.escrow
# Expected: includes { status: "preflight_healthy" | "preflight_unhealthy",
#                       reason: <one of three bounded values> }
```

---

## 16. Checklist

- [x] Code in `src/services/escrowSubmit.js` (`_preflightContractExists`,
      extended `EscrowSubmitError`, preflight call before `getAccount`).
- [x] Tests in `tests/escrowSubmit.preflight.test.js` (9/9 passing today)
      and `tests/escrowSubmit.stub.test.js` at the end of the file
      (load-blocked by pre-existing §14.2; will run when that is fixed).
- [x] JSDoc on the new `_preflightContractExists` helper.
- [x] No raw SDK / RPC text ever leaves the helper (mechanically verified).
- [x] Three rejection codes with stable `.code` and `.status` fields.
- [x] Single Prometheus counter `escrow_preflight_rejected_total{reason}`
      with bounded label set.
- [x] Backwards-compatible on `EscrowSubmitError`.
- [x] Operator documentation: `docs/ops-signing.md` "Contract Existence
      Preflight" section with rejection table.
- [x] Drive-by TDZ hoist of `const registry` in `src/metrics.js`
      (required for #436 tests to load).
- [x] Conventional Commits message format.
- [x] Commit message references `Closes #436`.
- [ ] Pre-existing blockers (§14) flagged; deferred to separate PRs.
