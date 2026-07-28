# Escrow Read Operations Runbook

Operator runbook for the LiquiFact backend escrow-read subsystem. This document covers configuration, common failure modes, alert signals, and recovery actions for the read path implemented in [src/services/escrowRead.js](../src/services/escrowRead.js), the HTTP route in [src/routes/v1/index.js](../src/routes/v1/index.js), and the Redis-backed summary cache in [src/cache/redis.js](../src/cache/redis.js).

---

## Architecture Overview

The escrow-read surface is intentionally projection-first and fail-closed:

```text
GET /v1/escrow/:invoiceId
  |
  +-> authenticateToken
  +-> resolve escrow contract address
  +-> read escrow state
        |
        +-> Redis summary cache (best effort, fail-open)
        +-> escrow_event_projection row (durable indexer state)
        +-> neutral RPC stub (no fabricated state)
  +-> derive display fields
  +-> return enriched escrow payload
```

Key behaviors:

- The route requires a valid bearer token before it will return escrow data.
- The service prefers durable projection rows over a live read, but never fabricates on-chain state for invoices that the indexer has not recorded.
- Legal-hold reads are treated as a tri-state: `held`, `not_held`, or `unknown`.
- Unknown legal-hold outcomes are failed closed so downstream funding and gating paths do not accidentally proceed as if the hold check were clear.

---

## Configuration

The read path is configured from environment variables and defaults are intentionally conservative.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC endpoint used by the Soroban wrapper for read operations. |
| `SOROBAN_MAX_RETRIES` | `3` | Retry budget for transient Soroban RPC failures. |
| `SOROBAN_BASE_DELAY` | `200` | Initial retry backoff in milliseconds. |
| `SOROBAN_MAX_DELAY` | `5000` | Maximum retry backoff in milliseconds. |
| `SOROBAN_MAX_ELAPSED_MS` | `10000` | Retry-window budget for Soroban calls. |
| `SOROBAN_CB_FAILURE_THRESHOLD` | `5` | Number of consecutive Soroban failures before the shared circuit breaker opens. |
| `SOROBAN_CB_RECOVERY_TIMEOUT` | `10000` | Time in milliseconds before the breaker attempts recovery. |
| `REDIS_ESCROW_CACHE_ENABLED` | `false` | Enables the Redis-backed escrow summary cache when set to `true`. |
| `REDIS_URL` | `redis://localhost:6379` | Redis endpoint used by the escrow summary cache. |
| `REDIS_ESCROW_CACHE_TTL_SECONDS` | `30` | Cache TTL for escrow summaries; clamped to `[5, 300]`. |
| `REDIS_ESCROW_LEDGER_GAP_THRESHOLD` | `3` | Evicts cached summaries when the ledger gap exceeds this threshold. |
| `REDIS_ESCROW_CACHE_TIMEOUT_MS` | `500` | Per-operation Redis timeout; clamped to `[50, 5000]`. |
| `JWT_SECRET` | dev/test fallback | Required for authentication on the protected escrow route in non-test environments. |

### Operational checklist

1. Confirm the escrow contract mapping exists for the invoice ID class you are reading.
2. Verify the Soroban RPC URL and credentials are reachable before investigating user-facing read failures.
3. If Redis is enabled, confirm the service can reach Redis and that cache keys are being populated.
4. Verify that the indexer has written a projection row before assuming the projection path is healthy.

---

## Failure Modes

### 1. Escrow read returns a neutral `not_found` state

**Symptom:** the API returns `status: "not_found"`, `fundedAmount: 0`, and `source: "rpc_stub"`.

**Likely cause:** no projection exists for the invoice and the live read fell back to the neutral RPC stub.

**Check:**

- Inspect the projection table for the invoice ID.
- Verify the indexer has processed and persisted the relevant escrow event.
- Check whether the invoice ID is mapped to a real escrow contract address.

**Recovery:** wait for the indexer to publish the projection or correct the contract mapping / invoice identifier.

### 2. Legal-hold read is `unknown`

**Symptom:** the response includes `legalHoldStatus: "unknown"` and the legal-hold gate blocks reads or funding.

**Likely cause:** the Soroban legal-hold read failed, timed out, or was rejected by a circuit-open breaker.

**Check:**

- Review Soroban RPC logs and error classification for the read path.
- Check whether the shared Soroban breaker has opened.
- Inspect whether the read path is falling back to the unknown outcome because of a timeout or transport issue.

**Recovery:** restore Soroban connectivity or fix the RPC endpoint. Once the upstream issue is cleared, the next read should return a concrete `held` or `not_held` value.

### 3. Redis cache is failing open

**Symptom:** cache lookups silently miss and the service falls back to projection or RPC, even though the cache layer is enabled.

**Likely cause:** Redis is unreachable, the operation timed out, or the circuit breaker is open.

**Check:**

- Verify Redis connectivity from the application host.
- Review whether the cache circuit breaker has tripped.
- Confirm that the Redis cache is configured with a reachable `REDIS_URL`.

**Recovery:** restore Redis availability or disable the cache for the incident window by setting `REDIS_ESCROW_CACHE_ENABLED=false` and restarting the service.

### 4. Projection read fails and the service falls back

**Symptom:** the read path does not use projection data, and the operation degrades to the neutral stub path.

**Likely cause:** the projection query failed, the table is missing, or the DB is unavailable.

**Check:**

- Confirm the `escrow_event_projection` table exists and is reachable.
- Review logs for the warning emitted by the service when the projection lookup fails.

**Recovery:** repair the DB / table issue and allow the indexer to repopulate the projection row.

### 5. Authentication failures on the route

**Symptom:** requests to the escrow route return authentication errors before any escrow read occurs.

**Likely cause:** the caller is missing or sending an invalid bearer token, or `JWT_SECRET` is misconfigured in a non-test environment.

**Check:**

- Validate the bearer token and the application’s JWT secret.
- Confirm the caller is hitting the authenticated route with the expected audience / issuer configuration if the middleware expects it.

**Recovery:** fix the token or auth configuration and retry the request.

---

## Alerts and Signals

Monitor the following signals in logs, metrics, and health checks:

| Signal | Meaning |
|--------|---------|
| `escrowRead: projection read failed; falling back to RPC stub` | The projection lookup failed; the read is degrading to the neutral fallback path. |
| `escrowRead: get_legal_hold call failed — status is unknown, gate must fail closed` | The legal-hold read failed and the service has marked the state as unreadable. |
| `escrowRead: Failed to fetch token metadata, continuing without it` | Token metadata enrichment failed; the escrow read still succeeds without that enrichment. |
| Redis cache fail-open metrics | The cache is failing open; the service is using the slower fallback path instead of cache hits. |
| Soroban breaker transition to `OPEN` | The shared Soroban circuit breaker has tripped and further calls will fail fast until recovery. |

Relevant implementation points:

- [src/services/escrowRead.js](../src/services/escrowRead.js) — read ordering, legal-hold tri-state, projection fallback, and the neutral stub behavior.
- [src/cache/redis.js](../src/cache/redis.js) — Redis cache configuration, TTL, ledger-gap eviction, and fail-open semantics.
- [src/services/soroban.js](../src/services/soroban.js) — shared Soroban retry wrapper and breaker configuration.

---

## Recovery Steps

### Restore a degraded escrow read

1. Verify the invoice ID and escrow address mapping.
2. Confirm the indexer has written a projection row for the invoice.
3. Check Soroban RPC connectivity and restore the endpoint if it is down.
4. If Redis is enabled, confirm the cache backend is reachable and healthy.
5. Retry the read once the underlying dependency is healthy again.

### Recover from a legal-hold outage

1. Investigate the underlying Soroban or RPC failure.
2. If the breaker is open, wait for the recovery timeout or reset it after the dependency is confirmed healthy.
3. Re-run the read and verify that the legal-hold state resolves to `held` or `not_held` instead of `unknown`.

### Disable the cache during triage

Set `REDIS_ESCROW_CACHE_ENABLED=false` and restart the process to bypass the cache path and isolate the underlying projection / RPC behavior.

---

## Cross-References

- [src/services/escrowRead.js](../src/services/escrowRead.js) — core escrow read implementation and fail-closed legal-hold behavior.
- [src/routes/v1/index.js](../src/routes/v1/index.js) — HTTP route that protects escrow reads with authentication.
- [src/cache/redis.js](../src/cache/redis.js) — Redis summary cache implementation and fail-open semantics.
- [src/services/soroban.js](../src/services/soroban.js) — Soroban retry wrapper and shared breaker.
- [docs/configuration.md](./configuration.md) — broader environment-variable reference.
