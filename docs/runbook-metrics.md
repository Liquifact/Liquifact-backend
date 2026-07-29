# Metrics Subsystem Operations Runbook

Operator runbook for the LiquiFact backend **metrics subsystem**: the
Prometheus registry and scrape endpoint (`GET /metrics`), plus the related
per-tenant SME metrics endpoint (`GET /api/sme/metrics`). Covers
configuration, common failures, alerts, and recovery steps.

> **Scope note.** This runbook covers two distinct things that share the word
> "metrics" but serve different purposes:
> - **Prometheus metrics** (`GET /metrics`) — the registry defined in
>   [`src/metrics.js`](../src/metrics.js): counters, gauges, and histograms for
>   escrow, persistence, Soroban RPC, webhooks, caching, and more, scraped by
>   an operator's Prometheus instance.
> - **SME invoice metrics** (`GET /api/sme/metrics`) — a per-tenant JSON
>   summary of invoice counts by status, guarded by
>   [`src/utils/metricsValidation.js`](../src/utils/metricsValidation.js).
>
> They are unrelated in purpose and auth model; do not confuse a failure in
> one for a failure in the other.

---

## Architecture Overview

```
Prometheus scraper                    Authenticated tenant user
        |                                        |
        v                                        v
GET /metrics                          GET /api/sme/metrics
        |                                        |
        v                                        v
  metricsAuth                       authenticateToken, extractTenant
        |                                        |
   (bearer token OR loopback)          validateMetricsRequest()
        |                                        |
        v                                        v
  metricsHandler                      per-tenant invoice status counts
        |
        v
  registry.metrics()  (prom-client, or in-memory shim in tests)
```

The Prometheus registry is created once in `src/metrics.js` and shared by
every module that records a metric (`registers: [registry]` on each
Counter/Gauge/Histogram). `GET /metrics` is mounted in
[`src/app.js`](../src/app.js) as `app.get('/metrics', metricsAuth, metricsHandler)`.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `METRICS_ENABLED` | `true` | Feature flag that gates Prometheus metrics collection and the `/metrics` endpoint. When `false`, all metric recording becomes a silent no-op and `GET /metrics` returns `503 Service Unavailable`. Changing this value requires a restart. |
| `METRICS_BEARER_TOKEN` | unset (loopback-only mode) | When set, `GET /metrics` requires `Authorization: Bearer <token>`, compared in constant time. When unset, only loopback addresses (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) may scrape. |

`GET /api/sme/metrics` has no metrics-specific configuration of its own — its
behavior is governed by the standard auth (`authenticateToken`) and tenant
(`extractTenant`) middleware used across the SME routes.

---

## Auth Model for `GET /metrics`

In priority order (see the module docblock in `src/metrics.js`):

1. **`METRICS_BEARER_TOKEN` set** — requires `Authorization: Bearer <token>`,
   compared with a constant-time algorithm to prevent timing side-channel
   attacks.
2. **`METRICS_BEARER_TOKEN` unset** — allows loopback addresses only.
   Loopback detection reads `req.socket.remoteAddress` directly and **never**
   consults `X-Forwarded-For`, so a remote attacker cannot spoof a loopback
   origin via that header. This holds even if `app.set('trust proxy', ...)`
   is added later, since the check bypasses `req.ip` entirely.
3. **Otherwise** — a uniform `401` with no detail distinguishing "wrong
   token" from "missing token" from "not loopback," by design.

---

## Failure Modes

### 1. Prometheus scrape returns 401

**Symptom:** Prometheus (or `curl`) gets `401 Unauthorized` hitting `/metrics`.

**Cause:** either `METRICS_BEARER_TOKEN` is set and the scraper isn't sending
a matching `Authorization: Bearer <token>` header, or the token is unset and
the scraper isn't connecting from a loopback address.

**Check:** confirm whether `METRICS_BEARER_TOKEN` is set in the target
environment. If set, verify the scrape config's bearer token matches exactly
(a trailing newline or whitespace difference will fail the constant-time
comparison). If unset, confirm the scraper is running on the same host
(loopback) — Prometheus running on a separate host or container requires
setting `METRICS_BEARER_TOKEN` and configuring the scrape job with it.

### 2. Prometheus scrape returns 503

**Symptom:** Prometheus (or `curl`) gets `503 Service Unavailable` hitting
`/metrics`.

**Cause:** `METRICS_ENABLED` is set to `false` in the environment. When
disabled, both the auth middleware and the handler short-circuit with a 503
before performing any auth checks or returning metric data.

**Check:** confirm whether `METRICS_ENABLED=false` is set in the target
environment. If this is intentional (metrics are disabled for maintenance or
cost reasons), no action is needed — Prometheus should be configured to
tolerate 503 from this target. If unintentional, set `METRICS_ENABLED=true`
and restart the process.

### 3. Metrics missing from scrape output despite the app running

**Symptom:** `/metrics` returns `200` but a specific counter/gauge is absent
or stuck at zero.

**Cause:** the relevant code path was never exercised (e.g., no persistence
requests have been made since startup, so `persistence_requests_total` has no
series yet — prom-client counters only appear once `.inc()` is called at
least once with a given label set). This is normal for low-traffic
environments or freshly deployed instances, not a bug.

**Check:** exercise the relevant endpoint once and re-scrape; the series
should appear.

### 4. `GET /api/sme/metrics` returns 400 "Missing tenant context"

**Symptom:** the SME invoice metrics endpoint returns `400` with
`{ "error": "Bad Request", "message": "Missing tenant context" }`.

**Cause:** `validateMetricsRequest()` found no `req.tenantId` — the
`extractTenant` middleware didn't resolve a tenant from the request (no
`x-tenant-id` header and no tenant claim on the authenticated JWT).

**Fix:** this is a client-side request problem, not a server outage. The
caller must supply a tenant identifier via header or use a JWT that carries
one.

### 5. `GET /api/sme/metrics` returns 403 "Cross-tenant access denied"

**Symptom:** `403` with `{ "error": "Forbidden", "message": "Cross-tenant access denied" }`.

**Cause:** the request is authenticated via a JWT that carries its own
`tenantId` claim, but the resolved `tenantId` (e.g. from an `x-tenant-id`
header) does not match the JWT's tenant scope. This is the cross-tenant read
guard in `validateMetricsRequest()` working as intended.

**Check:** confirm the caller isn't passing a stale or mismatched
`x-tenant-id` header alongside a JWT scoped to a different tenant.

### 6. Registry inconsistent between processes (multi-instance)

**Symptom:** a scrape from one instance shows different counts than another
behind the same load balancer.

**Cause:** the Prometheus registry in `src/metrics.js` is per-process, the
same way the in-memory rate limiter is (see
[`rate-limit-ops.md`](./rate-limit-ops.md) for the equivalent issue on
counters). With `WEB_CONCURRENCY`/`CLUSTER_WORKERS` > 1 or multiple replicas,
each process accumulates its own counts.

**Fix:** this is expected Prometheus behavior when each replica is scraped
independently (Prometheus aggregates via `sum()` in queries/alerts, e.g. the
existing `sum(rate(body_size_limit_rejections_total[5m]))` pattern in
`prometheus-rules.yml`). Ensure alert expressions sum across instances rather
than assuming a single global counter.

---

## Alerts

Alert rules that consume metrics exported by this subsystem live in
[`prometheus-rules.yml`](./prometheus-rules.yml). Relevant families already
defined there: `BodySizeLimitRejection*` (invoice upload abuse),
`EscrowReconciliationDrift*`, `EscrowIndexerStalled`,
`EscrowIndexerHighFailureRate`. Persistence-endpoint request metrics
(`persistence_request_duration_seconds`, `persistence_requests_total`,
`persistence_request_errors_total`) are documented in
[`runbook-persistence.md`](./runbook-persistence.md).

If `/metrics` itself becomes unreachable (see Failure Modes 1 or 2), no alert rule
can fire on any metric it exports — treat scrape-target-down as the
highest-priority signal, since it silently blinds every other alert in
`prometheus-rules.yml`.

---

## Recovery Steps

### Restore Prometheus scraping after a 503

1. Confirm whether `METRICS_ENABLED=false` is set in the target environment.
2. If intentional: no action needed — configure Prometheus to tolerate 503.
3. If unintentional: set `METRICS_ENABLED=true` and restart the process. The
   change takes effect at module load time, not at runtime.

### Restore Prometheus scraping after a 401

1. Confirm which auth mode is active (`METRICS_BEARER_TOKEN` set or unset).
2. If set: update the Prometheus scrape config's bearer token to match, or
   rotate `METRICS_BEARER_TOKEN` and update both sides together to avoid a
   scrape gap.
3. If unset: confirm the scraper runs on the same host/network namespace as
   the app (loopback-reachable), or set `METRICS_BEARER_TOKEN` and
   reconfigure the scrape job for remote access.

### Diagnose a missing or zero-valued series

1. Confirm the code path that increments the metric has actually run since
   process start (see Failure Mode 3).
2. If it has run and the series is still missing, check the relevant
   feature's own runbook (`runbook-persistence.md`, `storage-ops.md`,
   `rate-limit-ops.md`) for whether that subsystem itself is degraded.

### Diagnose SME metrics tenant errors

1. Confirm the caller is sending a tenant identifier via `x-tenant-id` or a
   JWT with a tenant claim.
2. If using both, confirm they agree — a JWT-scoped tenant always wins the
   cross-tenant check.

---

## Cross-References

- [`src/metrics.js`](../src/metrics.js) — the Prometheus registry, all
  registered metrics, and the `/metrics` auth/handler implementation.
- [`src/utils/metricsValidation.js`](../src/utils/metricsValidation.js) — the
  SME metrics endpoint's tenant validation contract.
- [`runbook-persistence.md`](./runbook-persistence.md) — persistence-endpoint
  request metrics in detail.
- [`storage-ops.md`](./storage-ops.md) — object-storage connectivity, which
  the metrics subsystem does not directly probe.
- [`rate-limit-ops.md`](./rate-limit-ops.md) — the equivalent per-process
  multi-instance caveat for rate-limit counters.
- [`prometheus-rules.yml`](./prometheus-rules.yml) — alert definitions.
- [`configuration.md`](./configuration.md) — full environment-variable
  inventory.
