# Metrics API

The LiquiFact API exposes Prometheus-compatible metrics in text exposition format (`text/plain; version=0.0.4; charset=utf-8`) for monitoring and alerting.

## GET /metrics

Internal endpoint that exposes Prometheus metrics for scraping. It is intentionally omitted from the public OpenAPI specification (`/openapi.json`).

### Access Control
- **Authentication**: Required via `Authorization: Bearer <token>`.
  - Uses `METRICS_TOKEN` when set, falling back to `ADMIN_API_TOKEN`.
  - Fails closed with `503 Service Unavailable` (`METRICS_TOKEN_NOT_CONFIGURED`) if neither token is configured.
  - Returns `401 Unauthorized` (`UNAUTHORIZED`) with `WWW-Authenticate: Bearer` if the token is missing or invalid.

### Request
- **Method**: `GET`
- **Path**: `/metrics`
- **Headers**:
  - `Authorization: Bearer <METRICS_TOKEN or ADMIN_API_TOKEN>`

### Response
- **Status 200 OK**: Prometheus text exposition format (`text/plain; version=0.0.4; charset=utf-8`).
- **Status 401 Unauthorized**: Authentication failed (`{ "error": "Metrics token required", "code": "UNAUTHORIZED" }`).
- **Status 503 Service Unavailable**: Neither `METRICS_TOKEN` nor `ADMIN_API_TOKEN` is configured (`{ "error": "Metrics endpoint is not configured", "code": "METRICS_TOKEN_NOT_CONFIGURED" }`).

---

## Exported Metrics

All metric names align with [`docs/prometheus-rules.yml`](./prometheus-rules.yml) and [`docs/grafana-dashboard.json`](./grafana-dashboard.json).

### HTTP Metrics

HTTP labels use Express route patterns (e.g. `/api/invoices/:id`) rather than raw URL paths so label cardinality stays bounded. Unmatched routes are recorded as `route="unmatched"`.

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `http_requests_total` | Counter | `method`, `route`, `status` | Total number of HTTP requests handled by the API. |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status` | HTTP request duration in seconds (fixed buckets: `0.005` to `10`s). |
| `body_size_limit_rejections_total` | Counter | `type` | Requests rejected with `413` for exceeding body size limits (`json`, `invoice`). |
| `idempotency_replays_total` | Counter | — | Total number of idempotent responses replayed from cache. |

### Webhook Metrics

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `webhook_deliveries_total` | Counter | `status` | Total number of webhook delivery outcomes (`delivered`, `failed`). |

### Escrow Indexer Metrics

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `indexer_ingested_total` | Counter | — | Total number of escrow events ingested by the indexer. |
| `indexer_last_ledger` | Gauge | — | Latest Stellar ledger observed by the escrow event indexer. |
| `escrow_indexer_events_processed_total` | Counter | — | Total number of escrow indexer events decoded and persisted. |
| `escrow_indexer_events_skipped_total` | Counter | — | Total number of escrow indexer events skipped due to decode failures. |
| `escrow_indexer_cycle_failures_total` | Counter | — | Total number of failed escrow indexer polling cycles. |
| `escrow_indexer_last_cursor_advance_timestamp_seconds` | Gauge | — | Unix timestamp (seconds) when the escrow indexer cursor last advanced. |

### Escrow Reconciliation Metrics

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `escrow_reconciliation_mismatches_total` | Counter | — | Total number of escrow reconciliation mismatches detected. |
| `escrow_reconciliation_drift_alerts_total` | Counter | — | Total number of escrow reconciliation runs exceeding drift threshold. |
