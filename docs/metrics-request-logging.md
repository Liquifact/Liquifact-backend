# Structured Request Logging for `/metrics`

Every completed `GET /metrics` request emits exactly one structured log
line, written by `recordMetricsEndpointOutcome()` in
[`src/metrics.js`](../src/metrics.js). This mirrors the pattern already used
for health endpoints (`recordHealthOutcome()` in
[`src/middleware/healthMetrics.js`](../src/middleware/healthMetrics.js)) so
the two observability surfaces stay consistent.

## When it fires

`recordMetricsEndpointOutcome()` is the single call site for metrics-request
telemetry, invoked from two places:

- `metricsAuth` — on an unauthorized (401) rejection, before the handler
  ever runs.
- `metricsHandler` — on `res.on('finish')` / `res.on('close')`, once the
  final status code is known (success or an in-handler failure).

This guarantees exactly one log line per request, regardless of which stage
it failed at.

## Fields

| Field | Type | Notes |
|-------|------|-------|
| `endpoint` | `string` | Always `"metrics"`. |
| `statusClass` | `'2xx' \| '4xx' \| '5xx'` | From `normalizeMetricsEndpointStatusClass()`. |
| `statusCode` | `number` | The raw HTTP status code. |
| `durationSeconds` | `number` | Wall-clock duration, rounded to 6 decimal places. |
| `cause` | `string` | Bounded cause label — see [`metrics-troubleshooting.md`](./metrics-troubleshooting.md#metrics_request_errors_totalcause--cause-codes) for the full table. |

No request headers, tokens, IP addresses, or raw error messages are logged —
only the bounded fields above. This matches the "no PII" rule already
documented for health-endpoint logging.

## Log level by outcome

| `statusClass` | Level | Message |
|----------------|-------|---------|
| `2xx` | `info` | `"metrics endpoint request completed"` |
| `4xx` | `warn` | `"metrics endpoint request rejected"` |
| `5xx` | `error` | `"metrics endpoint request failed"` |

## Request correlation

When a request object is available, the log line is written via
`logger.createRequestLogger(req)` (see
[`src/logger.js`](../src/logger.js)), which binds `requestId` and
`correlationId` onto every field automatically if present on the request.
When no request object is available (e.g. a direct unit-test call to
`recordMetricsEndpointOutcome()` without a `req`), it falls back to the
base `logger` with no request-scoped bindings.

## Example

```json
{
  "level": "warn",
  "requestId": "req_...",
  "correlationId": "req_...",
  "endpoint": "metrics",
  "statusClass": "4xx",
  "statusCode": 401,
  "durationSeconds": 0.000412,
  "cause": "auth_failure",
  "msg": "metrics endpoint request rejected"
}
```

## See also

- [`metrics-troubleshooting.md`](./metrics-troubleshooting.md) — cause/status
  code reference and fixes.
- [`runbook-metrics.md`](./runbook-metrics.md) — full operational runbook.
- [`src/middleware/healthMetrics.js`](../src/middleware/healthMetrics.js) —
  the equivalent pattern for health endpoints.
