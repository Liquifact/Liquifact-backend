# Metrics Troubleshooting Guide

Quick-reference for diagnosing `GET /metrics` and metrics-subsystem failures
by the exact code/status you're looking at. For deep operational
background (architecture, configuration, alerts, recovery runbooks), see
[`runbook-metrics.md`](./runbook-metrics.md) — this document is a faster
symptom → code → fix index that cross-references it.

## `metrics_request_errors_total{cause=...}` — cause codes

Emitted by `normalizeMetricsEndpointCause()` in
[`src/metrics.js`](../src/metrics.js) and attached to every structured log
line `recordMetricsEndpointOutcome()` writes (see
[`docs/metrics-request-logging.md`](./metrics-request-logging.md)).

| `cause` | HTTP status range | Meaning | Fix |
|---------|--------------------|---------|-----|
| `none` | 2xx | Successful scrape. Not an error; appears in logs/metrics as the non-error baseline. | N/A |
| `auth_failure` | 4xx | `metricsAuth` rejected the request — wrong/missing bearer token, or a non-loopback caller when no token is configured. | See "Auth Model" and Failure Mode 1 in [`runbook-metrics.md`](./runbook-metrics.md#failure-modes). |
| `internal_error` | 5xx | The registry threw while serializing metrics, or the handler failed for an unrelated reason. | Check application logs for the underlying stack trace at the same `requestId`/`correlationId`. |

## Readiness sub-check (`GET /ready`, `checks.metrics`) — status codes

`checkMetricsHealth()` in [`src/services/health.js`](../src/services/health.js)
contributes a `metrics` entry to the readiness probe's `checks` object. It is
**always non-blocking** — an unhealthy or disabled metrics sub-check never
flips overall `/ready` to unhealthy, since metrics is an observability
concern, not a request-serving dependency.

| `status` | Meaning | `error.code` | Fix |
|----------|---------|--------------|-----|
| `healthy` | The Prometheus registry produced output within the 1 s guard. | — | N/A |
| `disabled` | `METRICS_ENABLED=false`. Expected in environments that intentionally disable metrics. | — | If unintentional, set `METRICS_ENABLED=true` and restart (see Failure Mode 2 in the runbook). |
| `unhealthy` | The registry call threw or exceeded the timeout. | `TIMEOUT` | The registry took longer than 1000ms to serialize. Usually a symptom of an excessively large number of distinct label combinations (cardinality) on a custom metric — check for a recently added `.labels()` call using an unbounded value (e.g. a raw error message or user ID instead of a normalized/bounded cause). |
| `unhealthy` | (as above) | `SCRAPE_FAILED` | `registry.metrics()` threw synchronously — usually a bug in a custom collector registered against the shared `registry`. Check the stack trace attached to the readiness log line. |

## `getMetricsText()` — direct business-logic errors

`getMetricsText()` (extracted from `metricsHandler` so it's independently
unit-testable — see [`src/metrics.js`](../src/metrics.js)) has exactly two
code paths:

- Returns `cachedMetrics` (a static placeholder string) when the no-op
  metric shims are active (`METRICS_ENABLED=false`, or `client.Gauge` isn't
  the real prom-client constructor — i.e. tests).
- Otherwise `await registry.metrics()` — any rejection here propagates to
  `metricsHandler`'s `catch`, which sets `res.statusCode = 500` and records
  `cause: 'internal_error'` (see the table above).

If you see empty/placeholder output in a real deployment (not a test), check
`METRICS_ENABLED` first — a `cachedMetrics` response in production almost
always means the flag is unintentionally `false`.

## See also

- [`runbook-metrics.md`](./runbook-metrics.md) — architecture, configuration,
  auth model, alerts, and step-by-step recovery procedures.
- [`docs/metrics-request-logging.md`](./metrics-request-logging.md) — the
  structured log fields (`endpoint`, `statusClass`, `statusCode`,
  `durationSeconds`, `cause`) emitted alongside every metric.
- [`health.md`](./health.md) — the full readiness/liveness probe contract
  that `checks.metrics` is part of.
