# Implement `getOnChainSchemaVersion` RPC Read for Contract Version Drift Detection

**Closes #598**

---

## Summary

Replaces the `RPC_NOT_IMPLEMENTED` placeholder in `getOnChainSchemaVersion()` with a real Soroban RPC read that fetches the `SCHEMA_VERSION` u32 from the deployed contract's persistent storage. This enables the admin endpoint `GET /api/admin/escrow/version` and the scheduled refresh job in `contractListRefresh.js` to report real on-chain version drift against the local registry.

No response shapes are changed. All existing consumers of `getOnChainSchemaVersion` and `compareVersions` continue to work without modification.

---

## Changes

### `src/config/escrowVersions.js` — core RPC read implementation

The `getOnChainSchemaVersion(contractId)` function now:

1. **Validates the contract address** via `isValidStellarContractAddress()` → `StrKey.isValidContract()` from `@stellar/stellar-sdk` (checksum-verified StrKey validation, not just prefix regex).

2. **Resolves the target contract**: uses the explicit `contractId` argument, falling back to `process.env.ESCROW_CONTRACT_ID` when omitted.

3. **Reads `SCHEMA_VERSION` via Soroban RPC** by constructing an `xdr.LedgerKey` for the persistent `SCHEMA_VERSION` Symbol key and calling `SorobanRpc.Server.getLedgerEntries()`:
   ```js
   const key = xdr.ScVal.scvSymbol('SCHEMA_VERSION');
   const ledgerKey = xdr.LedgerKey.contractData({
     contract: contract.address().toScAddress(),
     key,
     durability: xdr.ContractDataDurability.persistent(),
   });
   const { entries } = await server.getLedgerEntries(ledgerKey);
   return entries[0].val.contractData().val().u32();
   ```

4. **Wraps the call in `callSorobanContract`** (from `src/services/soroban.js`) for automatic exponential-backoff retry on transient errors (429, 502, 503, 504, ECONNRESET, ETIMEDOUT).

5. **Handles errors with structured error codes**:
   - `INVALID_CONTRACT_ID` — when the address fails StrKey validation (also when no address is provided and `ESCROW_CONTRACT_ID` env var is unset).
   - `RPC_ERROR` — wraps any Soroban RPC failure (network, timeout, `SCHEMA_VERSION` not found in storage, etc.) with a descriptive message.

The comparison function `compareVersions(onChainVersion)` returns one of three statuses:
- `current` — on-chain version matches the highest registry entry
- `ahead` — on-chain version is higher than every registry entry (new wasm deployed)
- `unknown` — on-chain version is not in the registry (or null for empty registry)

### `src/routes/adminEscrow.js` — surfaced through existing endpoints

- **`POST /api/admin/escrow/refresh`** — calls `runContractListRefresh()` which calls `getOnChainSchemaVersion()` and `compareVersions()`. Returns `202` on success, `400` on invalid contract ID, `502` on RPC failure.
- **`GET /api/admin/escrow/version`** — calls `getOnChainSchemaVersion()` directly and `compareVersions()`. Returns `200` with `{ onChainVersion, knownVersion, status }` on success, `400` on invalid contract ID, `502` on RPC failure.

Both routes require admin authentication (JWT or API key via `adminStack` middleware).

### `src/jobs/contractListRefresh.js` — drift detection and alerting

- **`runContractListRefresh(contractId)`** — calls `getOnChainSchemaVersion()` then `compareVersions()`. On `ahead` or `unknown` status, raises a de-duplicated operator alert (increments `contractWasmVersionMismatchAlertsTotal` Prometheus counter + `error`-severity log with `alert: 'contract_wasm_version_mismatch'` tag).
- Alert deduplication: per `(contractId, expectedVersion, observedVersion)` signature; state is cleared when version returns to `current`.
- RPC/validation failures propagate as errors and do **not** trigger mismatch alerts.

### `src/app.js` — error handler fix

Extended `handleInternalError` to handle AppError status codes up to 599 (previously capped at 499). Fixes a bug where 502 Upstream Error responses were falling through to the generic 500 Internal Server Error handler instead of returning the correct 502 status and error detail.

### `src/__tests__/escrowVersions.test.js` — comprehensive test coverage (31 tests, all passing)

**31 tests** covering all modules:

| Module | Tests | Description |
|--------|-------|-------------|
| `REGISTRY` | 3 | Validates registry structure (≥1 entry, semver→u32 mapping, known versions) |
| `isValidContractId` | 5 | Accepts valid address, rejects short/invalid prefix/non-string/empty |
| `compareVersions` | 5 | `current`, `ahead`, `unknown` with/without matching semver, edge cases (0, 42) |
| `getOnChainSchemaVersion` | 5 | Missing env var, bad address, env var fallback, RPC error wrapping, success path |
| `runContractListRefresh` | 4 | Success result shape, RPC propagation, missing env var, explicit contractId override |
| POST `/api/admin/escrow/refresh` | 5 | Auth gates, success `202`, invalid contract `400`, RPC failure `502`, X-API-KEY auth |
| GET `/api/admin/escrow/version` | 4 | Auth gates, success `200` with version info, invalid contract `400`, RPC failure `502` |

**Fixed 5 pre-existing route-level test failures** by:
- Adding `tenantId` claim to the admin JWT token to satisfy the `extractTenant` middleware
- Adding `x-tenant-id` header to X-API-KEY auth tests
- Adjusting assertions for the standardized response envelope (`res.body.data.*`)
- Fixed a false positive: the "invalid contract → 400" tests were previously getting 400 from `extractTenant` (missing tenant), not from contract validation. They now correctly test the contract validation path.

### `docs/wasm-ops.md` — operational documentation

Documents the full detection flow, RPC implementation details, refresh procedure, error handling, rollback steps, and the version mismatch alert runbook (issue #457).

---

## Test Results

```
PASS src/__tests__/escrowVersions.test.js
Tests:       31 passed, 31 total
Time:        1.691 s
```

**Lint**: `npx eslint src/config/escrowVersions.js src/__tests__/escrowVersions.test.js src/app.js` — clean (no errors or warnings)

---

## Security Considerations

- **Contract ID validated before any RPC call**: `StrKey.isValidContract()` performs full StrKey checksum verification, preventing SSRF or wasted RPC calls on malformed addresses.
- **Safe error codes**: errors are mapped to `INVALID_CONTRACT_ID` and `RPC_ERROR` codes — no internal stack traces or RPC URLs leak to clients.
- **Admin routes only**: both `POST /refresh` and `GET /version` require admin authentication (JWT or API key) via `adminStack` middleware.
- **Alert payloads are safe**: only non-secret, publicly observable values (contract address, version integers, status) are surfaced in logs/metrics.
- **No `process.exit`**: errors are handled via structured error rejection, never by calling `process.exit()`.

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ESCROW_CONTRACT_ID` | Yes (unless passed explicitly) | Deployed LiquifactEscrow contract address |
| `SOROBAN_RPC_URL` | Yes | Soroban RPC endpoint (defaults to testnet) |

---

## Example Usage

```bash
# Get on-chain version
curl https://<host>/api/admin/escrow/version \
  -H "Authorization: Bearer <admin-jwt>"

# Response (200):
# { "onChainVersion": 3, "knownVersion": "1.2.0", "status": "current" }

# Trigger contract list refresh
curl -X POST https://<host>/api/admin/escrow/refresh \
  -H "Authorization: Bearer <admin-jwt>"

# Response (202):
# { "message": "Contract list refresh triggered.", "onChainVersion": 3, "knownVersion": "1.2.0", "status": "current" }
```

---

## Notes

1. To add a new wasm version to the registry, add a `'semver': schemaVersion` entry to `REGISTRY` in `src/config/escrowVersions.js`.
2. The version mismatch alert (issue #457) is fully implemented with in-process deduplication state.
3. The `handleInternalError` fix in `src/app.js` (capped at status 599 instead of 499) ensures AppError statuses like 502 propagate correctly through the Express error handling chain.
4. Tests use the global `@stellar/stellar-sdk` mock from `tests/mocks/setup.js` (regex-based StrKey validation) to avoid real checksum verification in the test environment.
