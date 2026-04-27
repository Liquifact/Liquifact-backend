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
| `API_KEYS_DB_PATH` | Path to the SQLite API key store |
| `ESCROW_REFRESH_ON_BOOT` | Set to `true` to auto-refresh on service start |

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

## 5. Security Notes

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
