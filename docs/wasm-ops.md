# LiquifactEscrow Wasm Deployment Operations

Operational guide for detecting a new `LiquifactEscrow` wasm version on-chain
and triggering a contract list refresh.

---

## 1. Detecting a New Wasm Version On-Chain

Every deployed `LiquifactEscrow` contract exposes a `SCHEMA_VERSION` storage
entry (a `u32`) that is incremented with each breaking wasm upgrade.  The
version registry in `src/config/escrowVersions.js` maps known semver release
tags to their expected `SCHEMA_VERSION` values.

Detection flow:

1. Call `getOnChainSchemaVersion(contractId)` — reads `SCHEMA_VERSION` from the
   contract's persistent storage via the Soroban RPC.
2. Compare the returned integer against `REGISTRY` entries using
   `compareVersions(onChainVersion)`.
3. If the on-chain value is **higher** than every registry entry, a new wasm
   has been deployed and a contract list refresh is required.
4. If the on-chain value matches a known entry, the deployment is already
   tracked; no refresh is needed.
5. If the RPC call fails, the function rejects with a structured error — the
   caller must handle this and must **not** proceed with a refresh.

Semver ordering follows the `semver` npm package (`semver.gt` / `semver.lt`).
The registry key with the highest semver is treated as the current known
version.

### RPC implementation detail

`getOnChainSchemaVersion` uses `@stellar/stellar-sdk`'s `SorobanRpc.Server` to
read the persistent `SCHEMA_VERSION` Symbol key directly from contract storage:

```js
const server = new SorobanRpc.Server(process.env.SOROBAN_RPC_URL);
const key = xdr.ScVal.scvSymbol('SCHEMA_VERSION');
const ledgerKey = xdr.LedgerKey.contractData({ contract, key, durability: 'persistent' });
const { entries } = await server.getLedgerEntries(ledgerKey);
return entries[0].val.contractData().val().u32();
```

The call is wrapped in `callSorobanContract` for automatic exponential-backoff
retry on transient errors (429, 502, 503, 504, ECONNRESET).  Contract-ID
validation (`^C[A-Z2-7]{55}$`) runs before any network call.

---

## 2. Contract List Refresh Procedure

Perform these steps after a new wasm deployment is confirmed:

### 2.1 Pre-flight checks

```
1. Confirm the new wasm hash is recorded in the Stellar network explorer.
2. Verify ESCROW_CONTRACT_ID points to the upgraded contract instance.
3. Ensure SOROBAN_RPC_URL is reachable and returning the expected ledger.
```

### 2.2 Trigger the refresh

**Via the admin API (preferred):**

```bash
curl -X POST https://<host>/api/admin/escrow/refresh \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json"
```

Or with an API key:

```bash
curl -X POST https://<host>/api/admin/escrow/refresh \
  -H "X-API-KEY: <service-api-key>" \
  -H "Content-Type: application/json"
```

Expected success response (`202 Accepted`):

```json
{
  "message": "Contract list refresh triggered.",
  "onChainVersion": 3,
  "knownVersion": "1.2.0"
}
```

**Via environment / deploy hook:**

Set `ESCROW_REFRESH_ON_BOOT=true` before restarting the service.  The job
runs once during bootstrap and clears the flag.

### 2.3 Verify the refresh

```bash
# Poll until the version registry reflects the new deployment
curl https://<host>/api/admin/escrow/version \
  -H "Authorization: Bearer <admin-jwt>"
```

Expected response:

```json
{
  "onChainVersion": 3,
  "knownVersion": "1.2.0",
  "status": "current"
}
```

`status` values:

| Value | Meaning |
|-------|---------|
| `current` | On-chain version matches the highest registry entry |
| `ahead` | On-chain version is higher — refresh required |
| `unknown` | RPC read failed or version not in registry |

---

## 3. Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | Stellar network passphrase |
| `ESCROW_CONTRACT_ID` | Deployed LiquifactEscrow contract address |
| `JWT_SECRET` | Secret for verifying admin JWT tokens |
| `API_KEYS` | Encoded JSON list of API key entries for the env-backed registry (see [README — API Key Authentication](../README.md#api-key-authentication)) |
| `ESCROW_REFRESH_ON_BOOT` | Set to `true` to auto-refresh on service start |

> **Note**: The legacy `API_KEYS_DB_PATH` SQLite store was retired alongside
> `src/middleware/apiKey.js` (issue #590). API key authentication is served
> entirely from the environment-backed registry in `src/middleware/apiKeyAuth.js`; no
> SQLite connection is opened per request.

---

## 4. Error Handling and Rollback

### RPC read failure

- `getOnChainSchemaVersion` rejects with `{ code: 'RPC_ERROR', message }`.
- The refresh route returns `502 Bad Gateway`.
- **Do not** update the registry or invalidate caches on RPC failure.
- Retry after confirming `SOROBAN_RPC_URL` is healthy.

### Version mismatch / unexpected schema

- If `onChainVersion` is lower than the highest registry entry, the contract
  may have been rolled back.  Log a `warn` and return `409 Conflict`.
- Investigate the on-chain state before re-triggering a refresh.

### Refresh job failure

- The refresh job is idempotent — re-triggering it is safe.
- If the job throws, the error is logged with `correlation_id` and the HTTP
  response carries `500 Internal Server Error`.
- No partial state is written; the existing registry remains authoritative.

### Rollback steps

1. Redeploy the previous wasm hash via the Stellar CLI.
2. Confirm `SCHEMA_VERSION` reverts to the previous value.
3. POST to `/api/admin/escrow/refresh` to re-sync the registry.
4. Restart the service if `ESCROW_REFRESH_ON_BOOT` is set.

---

## 5. Version Mismatch Alert (issue #457)

When `runContractListRefresh` (`src/jobs/contractListRefresh.js`) detects that the
on-chain `SCHEMA_VERSION` diverges from the expected/known registry version, it
raises an **operator-facing alert** rather than noticing the divergence silently.
A mismatch signals a contract upgrade or an unexpected/rolled-back deployment that
the backend may not yet support.

### What fires

A mismatch is any comparison `status` other than `current`:

| `status` | Meaning | Alert |
|----------|---------|-------|
| `current` | On-chain matches the highest registry entry | none (clears prior alert state) |
| `ahead` | On-chain is newer than every registry entry | **alert** |
| `unknown` | On-chain version is not in the registry | **alert** |

On a mismatch the job:

1. Increments the Prometheus counter
   **`contract_wasm_version_mismatch_alerts_total`** (label `status` = `ahead` |
   `unknown`).
2. Emits an **`error`-severity** structured log (the severity the existing
   alerting pipeline consumes) tagged `alert: "contract_wasm_version_mismatch"`:

   ```json
   {
     "level": "ERROR",
     "alert": "contract_wasm_version_mismatch",
     "contractId": "C....",
     "expectedVersion": "1.2.0",
     "observedVersion": 4,
     "status": "ahead",
     "msg": "ALERT: on-chain wasm SCHEMA_VERSION mismatch detected"
   }
   ```

### De-duplication (no alert spam)

The alert is **idempotent by version pair**: while the same
`(contractId, expectedVersion, observedVersion)` mismatch persists across
scheduled runs, only the **first** occurrence emits a metric increment and log.
The de-dupe state for a contract is cleared automatically once its version
returns to `current`, so a later regression re-alerts. It re-alerts immediately
if the observed version changes to a new pair. State can be reset manually via
`resetVersionMismatchAlertState()` (exported for tests/ops). The alert helper
returns `true` only when it emits a new metric/log alert and `false` when an
identical signature is suppressed.

> Note: because de-dupe state is in-process, a service restart resets it and the
> next run will alert once for any still-present mismatch — this is intentional
> (it re-surfaces an unresolved condition after a deploy/restart).

### Read failures are not mismatches

If `getOnChainSchemaVersion` fails (RPC error / invalid contract id) the job
rejects and **no** mismatch alert is raised — that path is handled separately
(see §4 RPC read failure). RPC failures surface through the existing
`getOnChainSchemaVersion` error log and the refresh route's `502`.

### Security: the alert payload is safe to surface

The payload contains only non-secret, publicly observable values: the contract
address (a public on-chain identifier), the expected registry version label, the
observed `SCHEMA_VERSION` integer, and the status. No RPC URLs, API keys, JWTs,
or other secrets are included. (Verified by a test asserting the payload never
contains RPC-URL credentials and exposes only the whitelisted keys.)

### Runbook — responding to the alert

1. **Acknowledge**: the alert means the deployed `LiquifactEscrow` contract no
   longer matches what this backend tracks. Capital-movement flows may rely on
   schema assumptions — treat as time-sensitive.
2. **Confirm on-chain**: read `SCHEMA_VERSION` directly
   (`GET /api/admin/escrow/version`) and cross-check the wasm hash in the Stellar
   explorer for the `contractId` in the alert.
3. **Classify**:
   - `ahead` → a planned upgrade is live before the backend caught up. Add the
     new `semver → SCHEMA_VERSION` entry to `REGISTRY` in
     `src/config/escrowVersions.js`, ship it, then trigger a refresh
     (`POST /api/admin/escrow/refresh`).
   - `unknown` (lower than current) → possible rollback or wrong
     `ESCROW_CONTRACT_ID`. Verify the contract id and follow the **Rollback
     steps** in §4 before re-triggering a refresh.
4. **Verify recovery**: re-run the refresh; once `status` returns to `current`
   the alert de-dupe state clears and `contract_wasm_version_mismatch_alerts_total`
   stops increasing.
5. **Suggested monitor**: alert when
   `increase(contract_wasm_version_mismatch_alerts_total[15m]) > 0`.

---

## 6. Security Notes

- The `/api/admin/escrow/*` routes require **either** a valid admin JWT
  (`Authorization: Bearer <token>`) **or** a valid `X-API-KEY` header.
  Unauthenticated requests receive `401 Unauthorized`.
- `ESCROW_CONTRACT_ID` and all secrets must be supplied via environment
  variables.  Never commit secret values to source control.
- The `X-API-KEY` value is hashed with SHA-256 before comparison; the plain
  key is never stored or logged.
- Input validation: `contractId` path/query parameters are validated against
  a Stellar contract address pattern (`C[A-Z2-7]{55}`) before any RPC call.
- Rate limiting: the admin refresh endpoint inherits the global rate limiter.
  Apply `sensitiveLimiter` if the endpoint is exposed publicly.
- Audit log: every refresh trigger is recorded via `auditMiddleware` with the
  caller's identity and correlation ID.
