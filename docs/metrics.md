# Metrics API

The Liquifact API exposes Prometheus-compatible metrics for monitoring and alerting.

## GET /metrics

Exposes system-level Prometheus metrics.

### Access Control
- **Authentication**: Required via Bearer token (`METRICS_BEARER_TOKEN`) or via loopback address (`127.0.0.1` / `::1`).
- **Rate Limiting**: Per-client (IP/token) rate limiting applied via `metricsLimiter` (see `src/middleware/rateLimit.js`).

### Request
- **Method**: `GET`
- **Path**: `/metrics`
- **Headers**:
  - `Authorization`: `Bearer <token>` (if not loopback)

### Response
- **Status 200 OK**: Prometheus exposition format (plain text).
- **Status 401 Unauthorized**: Authentication failed.
  - Body: `{ "error": "Unauthorized" }`
- **Status 429 Too Many Requests**: Rate limit exceeded.
  - Body: `{ "error": "Too many metrics requests" }`

---

## GET /api/admin/metrics/audit

> **Note**: This endpoint is primarily for internal admin audit log retrieval.

Retrieves the in-memory audit log of metrics mutations.

### Access Control
- **Authentication**: Required via `adminStack` (JWT or API key).

### Request
- **Method**: `GET`
- **Path**: `/api/admin/metrics/audit`
- **Query Parameters**:
  - `metricName` (optional, string): Filter by metric name.
  - `action` (optional, enum `CREATE`, `UPDATE`, `DELETE`): Filter by action.
  - `actorId` (optional, string): Filter by actor ID.
  - `limit` (optional, int, 1-1000): Number of records.
  - `offset` (optional, int, >= 0): Page offset.

### Response
- **Status 200 OK**: JSON object containing audit log data.
  - Body:
    ```json
    {
      "data": [
        {
          "metricName": "string",
          "action": "string",
          "actorId": "string",
          "timestamp": "string"
        }
      ],
      "meta": {
        "total": 100,
        "limit": 100,
        "offset": 0,
        "returned": 100
      },
      "filters": {
        "metricName": null,
        "action": null,
        "actorId": null
      }
    }
    ```
- **Status 400 Bad Request**: Validation error (e.g., invalid query parameter).
- **Status 401/403**: Authentication or authorization failed.
