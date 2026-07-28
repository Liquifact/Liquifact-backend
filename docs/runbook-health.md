# Health Subsystem Operations Runbook

Operator runbook for the LiquiFact backend **health subsystem**: the
dependency-check and readiness-probe layer that Kubernetes (and other
orchestrators) use to decide whether the pod should receive traffic. It covers
configuration, common failure modes, alerts, and recovery steps.

> **Scope note.** The health subsystem spans the HTTP probe endpoints mounted
> in [`src/app.js`](../src/app.js), the check functions in
> [`src/services/health.js`](../src/services/health.js), the cursor-paginated
> listing in [`src/routes/health.js`](../src/routes/health.js), and the
> readiness gauge in [`src/metrics.js`](../src/metrics.js).  This runbook is
> the operational companion to those modules.

---

## Architecture Overview

```
                    ┌────────────────────────────────────┐
  Liveness probes   │  GET /health  ──→ static 200 ok   │  (never touches deps)
  (K8s liveness)    │  GET /healthz ──→ static 200 ok   │
                    └────────────────────────────────────┘

                    ┌────────────────────────────────────┐
  Full readiness    │  GET /ready  ──→ performHealthChecks()         │
  (all deps)        │       ├── checkSorobanHealth()                │
                    │       ├── checkDatabaseHealth()               │
                    │       ├── checkKycHealth()                    │
                    │       ├── checkIndexerStaleness()             │
                    │       └── checkStorageHealth()                │
                    └───────────────────────────────────────────────┘

                    ┌────────────────────────────────────┐
  Critical readiness│  GET /readyz ──→ performReadinessChecks()      │
  (K8s readiness)   │       ├── checkDatabaseHealth()               │
                    │       ├── checkSorobanHealth()                │
                    │       ├── checkStorageHealth()                │
                    │       └── checkReconciliationHealth()         │
                    └───────────────────────────────────────────────┘

                    ┌────────────────────────────────────┐
  Health listing    │  GET  /api/health/checks            │  cursor-paginated
  (API consumer)    │  POST /api/health/reports           │  idempotent write
                    └────────────────────────────────────┘
```

---

## Configuration

All variables are read from the process environment.  Only the health-subsystem
relevant ones are listed here; see [`configuration.md`](./configuration.md) for
the full inventory.

### Soroban RPC

| Variable | Default | Purpose |
|----------|---------|---------|
| `SOROBAN_RPC_URL` | *(unset)* | Soroban RPC endpoint. When absent, Soroban status = `unknown`. |
| `SOROBAN_HEALTH_TIMEOUT_MS` | `5000` | Abort timeout for the JSON-RPC `getHealth` probe (clamped 250–10 000). |
| `SOROBAN_LATENCY_WARN_MS` | `200` | Latency ≤ this → `healthy`. |
| `SOROBAN_LATENCY_FAIL_MS` | `500` | Latency > this → `unhealthy`; between warn and fail → `degraded`. |

### Database

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | *(unset)* | PostgreSQL connection string. When absent, DB status = `not_configured`. |
| `DB_HEALTH_PROBE_TIMEOUT_MS` | `2000` | Timeout for the `SELECT 1` probe. |
| `DB_POOL_SATURATION_RATIO` | `0.8` | Fraction of pool `max` at which `used` connections trigger `degraded`. |

### KYC Provider

| Variable | Default | Purpose |
|----------|---------|---------|
| `KYC_PROVIDER_URL` | *(unset)* | KYC provider base URL. When absent, status = `disabled`. |
| `KYC_PROVIDER_API_KEY` | *(unset)* | Bearer token for the `HEAD` probe. Never included in responses. |

### Escrow Indexer

| Variable | Default | Purpose |
|----------|---------|---------|
| `ESCROW_INDEXER_ENABLED` | `false` | Feature flag. When not `true`, staleness status = `disabled`. |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | `300` | Seconds without cursor advance before status = `stale`. |

### Storage / S3

| Variable | Default | Purpose |
|----------|---------|---------|
| `S3_HEALTHCHECK_ENABLED` | `true` | Set `false` to skip the `HeadBucket` probe. |
| `STORAGE_IN_MEMORY` | `false` | In-memory fallback; probe skipped, status = `in_memory`. |
| `STORAGE_HEALTHCHECK_TIMEOUT_MS` | `5000` | Timeout (ms) for the S3 `HeadBucket` probe. |

### Reconciliation

| Variable | Default | Purpose |
|----------|---------|---------|
| `RECONCILIATION_DRIFT_THRESHOLD` | `1` | Mismatch count that breaches readiness. |

### Cursor Pagination (Health Listing)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CURSOR_SECRET` | *(unset)* | HMAC-SHA256 signing secret for health-listing cursors. Falls back to `JWT_SECRET`. Outside `development`/`test`, startup **throws** if neither is set. |
| `JWT_SECRET` | *(required)* | Fallback for cursor signing. |
| `CURSOR_TTL_ENABLED` | `false` | Enable TTL expiry for signed cursors. |
| `CURSOR_TTL_SECONDS` | `3600` | TTL in seconds when enabled. |

---

## Health Check Status Values

### Soroban RPC

| Status | Meaning |
|--------|---------|
| `healthy` | Reachable, latency ≤ `SOROBAN_LATENCY_WARN_MS`. |
| `degraded` | Reachable, latency between warn and fail thresholds. |
| `unhealthy` | Unreachable or latency > `SOROBAN_LATENCY_FAIL_MS`. |
| `unknown` | `SOROBAN_RPC_URL` not configured. |

### Database

| Status | Meaning |
|--------|---------|
| `healthy` | `SELECT 1` succeeded, pool within normal bounds. |
| `degraded` | Reachable but pool saturated (`pending > 0` or `used ≥ max × ratio`). |
| `unhealthy` | Unreachable or pool acquire timed out. |
| `not_configured` | `DATABASE_URL` absent. |

### KYC Provider

| Status | Meaning |
|--------|---------|
| `healthy` | Reachable (any HTTP status < 500). |
| `unhealthy` | Unreachable or HTTP ≥ 500. |
| `disabled` | Provider not configured. |

### Escrow Indexer Staleness

| Status | Meaning |
|--------|---------|
| `healthy` | Cursor advanced within threshold, or gauge not yet set (startup). |
| `stale` | Cursor hasn't advanced for > `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS`. |
| `disabled` | `ESCROW_INDEXER_ENABLED` is not `true`. |

### Storage / S3

| Status | Meaning |
|--------|---------|
| `healthy` | `HeadBucket` succeeded; bucket reachable with valid credentials. |
| `in_memory` | In-memory fallback active (`NODE_ENV=test` or `STORAGE_IN_MEMORY=true`). |
| `disabled` | `S3_HEALTHCHECK_ENABLED=false`. |
| `not_configured` | Bucket name or credentials missing. |
| `unhealthy` | `HeadBucket` failed. `error.code` is an AWS error name. |

### Escrow Reconciliation

| Status | Meaning |
|--------|---------|
| `healthy` | Last run is recent with zero mismatches. |
| `degraded` | Mismatches present but below `RECONCILIATION_DRIFT_THRESHOLD`. |
| `mismatch_threshold_breached` | Mismatches ≥ threshold; readiness degraded. |
| `stale` | Last run > 25 hours ago. |
| `not_run` | Reconciliation never executed (fresh deployment). |
| `error` | Summary lookup failed. |

---

## Readiness Decision Logic

### `/ready` (full readiness — all dependencies)

Overall `healthy` when:
- Soroban is `healthy` or `unknown`
- KYC is `healthy` or `disabled`
- Indexer staleness is `healthy` or `disabled`
- Storage is not `not_configured` and not `unhealthy`

DB `degraded` (pool saturated) **does not** block `/ready`.

### `/readyz` (critical readiness — DB, Soroban, Storage, Reconciliation)

Overall `healthy` when:
- DB is `healthy` or `degraded`
- Soroban is `healthy`, `degraded`, or `unknown`
- Storage is `healthy`, `in_memory`, or `disabled`
- Reconciliation is not `mismatch_threshold_breached`

Soroban `degraded` (slow) **does not** block `/readyz`.
Reconciliation `not_run` or `error` **does not** block `/readyz`.

### Prometheus Gauge

The `readiness_state` gauge (set by `/readyz`) encodes:
| Value | Meaning |
|-------|---------|
| `1` | Ready — all critical checks pass. |
| `0.5` | Degraded — DB pool saturated, Soroban slow, or reconciliation drift. |
| `0` | Not ready — DB unhealthy, storage unreachable, or reconciliation threshold breached. |

---

## Endpoints

| Endpoint | Method | Type | Response |
|----------|--------|------|----------|
| `GET /health` | GET | Liveness | Always `200 { status: "ok" }` |
| `GET /healthz` | GET | Liveness (alias) | Always `200 { status: "ok" }` |
| `GET /ready` | GET | Full readiness | `200` when healthy, `503` when unhealthy |
| `GET /readyz` | GET | Critical readiness | `200` when healthy, `503` when unhealthy |
| `GET /api/health/checks` | GET | Health listing | Cursor-paginated HMAC-signed records |
| `POST /api/health/reports` | POST | External report write | `201` on success, `409` on key conflict |

---

## Common Failure Modes

### 1. `/ready` or `/readyz` returns 503

**Symptoms:**
- Kubernetes marks pod as not ready; no traffic routed.
- `readiness_state` Prometheus gauge is 0 or 0.5.

**Diagnosis:**
1. `curl localhost:<port>/readyz` — inspect `checks` object.
2. Identify which check is failing: `database`, `soroban`, `storage`, or `reconciliation`.
3. Check logs for the specific error message.

**Recovery:**
- **Database unhealthy**: verify `DATABASE_URL`, check PostgreSQL availability, inspect pool metrics (`pool.used`, `pool.pending`). Restart the pod if pool is stuck.
- **Soroban unhealthy**: verify `SOROBAN_RPC_URL`, check upstream RPC status, increase `SOROBAN_HEALTH_TIMEOUT_MS` if latency is borderline.
- **Storage unhealthy**: verify S3 bucket exists and credentials are valid (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). Set `S3_HEALTHCHECK_ENABLED=false` temporarily to unblock readiness.
- **Reconciliation threshold breached**: run reconciliation manually, investigate mismatches, adjust `RECONCILIATION_DRIFT_THRESHOLD` if false positive.

### 2. DB pool saturation (degraded but not failing)

**Symptoms:**
- `/readyz` returns `200` but `readiness_state` gauge = `0.5`.
- `database.pool.pending > 0` or `pool.used ≥ pool.max × 0.8`.

**Diagnosis:**
- Inspect pool counters in the `/readyz` response: `checks.database.pool`.
- Check for slow queries, connection leaks, or under-provisioned pool.

**Recovery:**
- Increase `pool.max` in Knex config.
- Investigate long-running queries (`pg_stat_activity`).
- Consider adding read replicas if read-heavy.

### 3. Health listing cursor tampering

**Symptoms:**
- `GET /api/health/checks?cursor=...` returns HTTP 400 RFC 7807 error.
- Error message: "invalid or tampered cursor".

**Diagnosis:**
- The cursor is HMAC-SHA256 signed. Tampering or using a cursor signed by a different `CURSOR_SECRET` / `JWT_SECRET` is rejected.
- Cursor TTL may have expired if `CURSOR_TTL_ENABLED=true`.

**Recovery:**
- Omit the `cursor` parameter to fetch the first page.
- Ensure `CURSOR_SECRET` (or `JWT_SECRET`) is consistent across replicas.

### 4. S3 health probe blocks readiness on misconfigured bucket

**Symptoms:**
- `/readyz` returns `503` with `storage.status = "unhealthy"`.
- `storage.error.code` is an AWS error name (e.g. `NotFound`, `Forbidden`).

**Diagnosis:**
- Check S3 bucket name, region, and IAM credentials.
- Verify `AWS_REGION` matches the bucket's region.

**Recovery:**
- Fix the S3 configuration.
- As a temporary measure, set `S3_HEALTHCHECK_ENABLED=false` to unblock readiness (note: uploads will still fail at request time).

### 5. Fresh deployment never becomes ready (reconciliation)

**Symptoms:**
- `/readyz` returns `503` immediately after deployment.
- `reconciliation.status = "not_run"`.

**Diagnosis:**
- This is expected for fresh deployments. Reconciliation has never executed.
- However, `not_run` is non-blocking for `/readyz` (status is `200`).

**Recovery:**
- Wait for the first reconciliation cycle to run.
- If `/readyz` is still returning `503`, check other dependencies (DB, Soroban, Storage).

### 6. Indexer staleness alert

**Symptoms:**
- Prometheus alert `EscrowIndexerStalled` fires.
- `indexerStaleness.status = "stale"` in `/ready` response.

**Diagnosis:**
- Check `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` (default 300s).
- Verify the indexer worker is running and advancing its cursor.

**Recovery:**
- Restart the indexer worker.
- Check for upstream RPC failures that prevent cursor advancement.
- Indexer staleness does **not** block `/readyz` (critical readiness) but **does** block `/ready` (full readiness).

---

## Alerts

The following Prometheus alerts are defined in
[`docs/prometheus-rules.yml`](./prometheus-rules.yml):

| Alert | Expression | Severity | Description |
|-------|-----------|----------|-------------|
| `EscrowReconciliationDrift` | `increase(escrow_reconciliation_mismatches_total[26h]) > 0` | warning | On-chain vs DB funded amount mismatch detected. |
| `EscrowReconciliationDriftAlerted` | `increase(escrow_reconciliation_drift_alerts_total[26h]) > 0` | warning | Reconciliation run breached drift threshold. |
| `EscrowIndexerStalled` | `(time() - escrow_indexer_last_cursor_advance_timestamp_seconds) > 600` (10m) | warning | Cursor hasn't advanced in 10 minutes. |
| `EscrowIndexerHighFailureRate` | `rate(escrow_indexer_cycle_failures_total[5m]) > 0.1` (2m) | critical | High failure rate in indexer cycles. |

---

## Recovery Runbook (Step by Step)

1. **Identify the failing probe:**
   ```bash
   curl -s localhost:3000/readyz | jq '.checks | to_entries[] | select(.value.status != "healthy" and .value.status != "disabled" and .value.status != "unknown")'
   ```

2. **Check the Prometheus gauge:**
   ```
   readiness_state{service="liquifact-api"}
   ```

3. **Inspect pool metrics (if DB is degraded):**
   ```bash
   curl -s localhost:3000/readyz | jq '.checks.database.pool'
   ```

4. **Test individual checks:**
   ```bash
   # Soroban RPC
   curl -s -X POST "$SOROBAN_RPC_URL" -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

   # Database
   psql "$DATABASE_URL" -c "SELECT 1"

   # S3
   aws s3api head-bucket --bucket "$S3_BUCKET"
   ```

5. **Escalation path:**
   - Pod-level: restart the pod (`kubectl delete pod <name>`).
   - Config-level: fix the environment variable or secret.
   - Infrastructure-level: check upstream service status (Stellar network, PostgreSQL, AWS).

---

## Security Properties

- **No credential leakage**: Database connection strings, hostnames, AWS access keys, S3 bucket names, and KYC API keys are never included in health responses.
- **S3 error sanitizer**: AWS error messages are stripped; only `{ code, hint }` pairs are returned.
- **Cursor tampering protection**: HMAC-SHA256 signed cursors with constant-time comparison. Tampered cursors → 400.
- **Idempotency**: Health report writes use database-backed idempotency keys with TTL expiry and fingerprint comparison.
- **Timeouts everywhere**: Every external probe (Soroban, DB, KYC, S3) has bounded timeouts to prevent hanging readiness checks.
