# Config API Examples

This document provides runnable `curl` and raw HTTP request/response examples for
every admin config endpoint. All examples assume a local development server.

---

## Setup

### Base URL

```bash
export BASE_URL="http://localhost:3001"
```

### Authentication

All config endpoints require admin authentication. You can authenticate with
either a **JWT bearer token** or an **API key**.

```bash
# JWT bearer token
export TOKEN="your-jwt-token-here"

# Or API key
export API_KEY="lf_your_api_key_here"

# Tenant context (required for multi-tenant deployments)
export TENANT_ID="tenant_123"
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/config/sections` | List valid configuration section names |
| `POST` | `/api/admin/config` | Write a runtime configuration section |

---

## GET /api/admin/config/sections

Returns the list of valid section names accepted by `POST /api/admin/config`.

### cURL

```bash
curl -s "$BASE_URL/api/admin/config/sections" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  | jq
```

### HTTP Request

```http
GET /api/admin/config/sections HTTP/1.1
Host: localhost:3001
Authorization: Bearer <jwt-token>
x-tenant-id: tenant_123
```

### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc123

{
  "sections": [
    "webhook",
    "reconciliation",
    "kyc",
    "retention",
    "fraudThresholds"
  ]
}
```

---

## POST /api/admin/config

Writes a runtime configuration section. The request body requires a `section`
field (one of the values returned by the sections endpoint) and a `config`
object whose shape depends on the section.

Supported sections:

| Section | Purpose |
|---------|---------|
| `webhook` | Webhook delivery URL, signing secret, subscribed events, retry behaviour |
| `reconciliation` | Escrow-reconciliation batch size, drift tolerance, schedule |
| `kyc` | KYC provider base URL, API key, timeout, retries |
| `retention` | Data-retention window, purge schedule, legal-hold reasons |
| `fraudThresholds` | Per-tenant fraud ceiling and manual-review threshold |

---

### Webhook config

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "webhook",
    "config": {
      "url": "https://webhooks.example.com/liquifact",
      "secret": "whsec_abcdefghijklmnopqrstuvwxyz123456",
      "events": ["invoice.created", "invoice.paid", "invoice.settled"],
      "maxRetries": 5,
      "timeoutMs": 10000,
      "enabled": true
    }
  }' \
  | jq
```

#### HTTP Request

```http
POST /api/admin/config HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Authorization: Bearer <jwt-token>
x-tenant-id: tenant_123

{
  "section": "webhook",
  "config": {
    "url": "https://webhooks.example.com/liquifact",
    "secret": "whsec_abcdefghijklmnopqrstuvwxyz123456",
    "events": ["invoice.created", "invoice.paid", "invoice.settled"],
    "maxRetries": 5,
    "timeoutMs": 10000,
    "enabled": true
  }
}
```

#### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc124

{
  "section": "webhook",
  "config": {
    "url": "https://webhooks.example.com/liquifact",
    "secret": "whsec_abcdefghijklmnopqrstuvwxyz123456",
    "events": ["invoice.created", "invoice.paid", "invoice.settled"],
    "maxRetries": 5,
    "timeoutMs": 10000,
    "enabled": true
  },
  "message": "Configuration section 'webhook' validated and accepted."
}
```

---

### Reconciliation config

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "reconciliation",
    "config": {
      "batchSize": 100,
      "maxDriftSeconds": 300,
      "scheduleExpression": "0 3 * * *",
      "enabled": true
    }
  }' \
  | jq
```

#### HTTP Request

```http
POST /api/admin/config HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Authorization: Bearer <jwt-token>
x-tenant-id: tenant_123

{
  "section": "reconciliation",
  "config": {
    "batchSize": 100,
    "maxDriftSeconds": 300,
    "scheduleExpression": "0 3 * * *",
    "enabled": true
  }
}
```

#### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc125

{
  "section": "reconciliation",
  "config": {
    "batchSize": 100,
    "maxDriftSeconds": 300,
    "scheduleExpression": "0 3 * * *",
    "enabled": true
  },
  "message": "Configuration section 'reconciliation' validated and accepted."
}
```

---

### KYC config

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "kyc",
    "config": {
      "providerUrl": "https://kyc-provider.example.com/api/v2",
      "apiKey": "kyc_live_abcdefgh12345678",
      "timeoutMs": 15000,
      "retries": 3
    }
  }' \
  | jq
```

#### HTTP Request

```http
POST /api/admin/config HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Authorization: Bearer <jwt-token>
x-tenant-id: tenant_123

{
  "section": "kyc",
  "config": {
    "providerUrl": "https://kyc-provider.example.com/api/v2",
    "apiKey": "kyc_live_abcdefgh12345678",
    "timeoutMs": 15000,
    "retries": 3
  }
}
```

#### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc126

{
  "section": "kyc",
  "config": {
    "providerUrl": "https://kyc-provider.example.com/api/v2",
    "apiKey": "kyc_live_abcdefgh12345678",
    "timeoutMs": 15000,
    "retries": 3
  },
  "message": "Configuration section 'kyc' validated and accepted."
}
```

---

### Retention config

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "retention",
    "config": {
      "retentionDays": 365,
      "purgeEnabled": true,
      "batchSize": 500,
      "purgeCron": "0 4 * * *",
      "legalHoldReasons": ["litigation", "regulatory_investigation", "audit"]
    }
  }' \
  | jq
```

#### HTTP Request

```http
POST /api/admin/config HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Authorization: Bearer <jwt-token>
x-tenant-id: tenant_123

{
  "section": "retention",
  "config": {
    "retentionDays": 365,
    "purgeEnabled": true,
    "batchSize": 500,
    "purgeCron": "0 4 * * *",
    "legalHoldReasons": ["litigation", "regulatory_investigation", "audit"]
  }
}
```

#### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc127

{
  "section": "retention",
  "config": {
    "retentionDays": 365,
    "purgeEnabled": true,
    "batchSize": 500,
    "purgeCron": "0 4 * * *",
    "legalHoldReasons": ["litigation", "regulatory_investigation", "audit"]
  },
  "message": "Configuration section 'retention' validated and accepted."
}
```

---

### Fraud thresholds config

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "fraudThresholds",
    "config": {
      "fraudCeiling": 500000,
      "manualReviewThreshold": 10000
    }
  }' \
  | jq
```

#### HTTP Request

```http
POST /api/admin/config HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Authorization: Bearer <jwt-token>
x-tenant-id: tenant_123

{
  "section": "fraudThresholds",
  "config": {
    "fraudCeiling": 500000,
    "manualReviewThreshold": 10000
  }
}
```

#### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc128

{
  "section": "fraudThresholds",
  "config": {
    "fraudCeiling": 500000,
    "manualReviewThreshold": 10000
  },
  "message": "Configuration section 'fraudThresholds' validated and accepted."
}
```

---

### Minimal config (single field update)

Every config section accepts partial updates — you only need to supply the
fields you want to change. For example, enabling purging without touching the
other retention fields:

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "retention",
    "config": {
      "purgeEnabled": false
    }
  }' \
  | jq
```

#### Response (200)

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_abc129

{
  "section": "retention",
  "config": {
    "purgeEnabled": false
  },
  "message": "Configuration section 'retention' validated and accepted."
}
```

> **Note:** The `reconciliation`, `retention`, and `fraudThresholds` schemas
> require at least one field to be present. Sending an empty `config` object
> (`{}`) for those sections will produce a 400 validation error.

---

## Error response examples

### Validation error (400) — missing required field

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "webhook",
    "config": {
      "url": "not-a-url"
    }
  }' \
  | jq
```

#### Response (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_abc130

{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "code": "VALIDATION_ERROR",
  "fieldErrors": {
    "config.url": "url must be a valid URL",
    "config.secret": "secret must be at least 16 characters"
  }
}
```

### Validation error (400) — unknown section

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "unknown_section",
    "config": {}
  }' \
  | jq
```

#### Response (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_abc131

{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "code": "VALIDATION_ERROR",
  "fieldErrors": {
    "section": "section must be one of: webhook, reconciliation, kyc, retention, fraudThresholds"
  }
}
```

### Validation error (400) — cross-field rule violation

The `fraudThresholds` section enforces a cross-field rule: `manualReviewThreshold`
must not exceed `fraudCeiling`.

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "fraudThresholds",
    "config": {
      "fraudCeiling": 1000,
      "manualReviewThreshold": 50000
    }
  }' \
  | jq
```

#### Response (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_abc132

{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "code": "VALIDATION_ERROR",
  "fieldErrors": {
    "config.manualReviewThreshold": "manualReviewThreshold must not exceed fraudCeiling"
  }
}
```

### Validation error (400) — unknown top-level keys

The runtime config schema rejects unknown top-level keys.

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "webhook",
    "config": { "url": "https://valid.url/webhook", "secret": "abcdefghijklmnop" },
    "extraField": "not allowed"
  }' \
  | jq
```

#### Response (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_abc133

{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "code": "VALIDATION_ERROR",
  "fieldErrors": {
    "": "Unrecognized key(s) in object: 'extraField'"
  }
}
```

### Validation error (400) — unknown keys inside config object

Each section schema is `.strict()`, so unknown keys inside the `config` object
are also rejected.

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "kyc",
    "config": {
      "providerUrl": "https://kyc.example.com",
      "apiKey": "key_abcdefgh12345678",
      "nonexistentField": "will be rejected"
    }
  }' \
  | jq
```

#### Response (400)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_abc134

{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "code": "VALIDATION_ERROR",
  "fieldErrors": {
    "config.nonexistentField": "Unrecognized key(s) in object: 'nonexistentField'"
  }
}
```

### Unauthorized (401) — missing or invalid authentication

#### cURL

```bash
curl -s -X GET "$BASE_URL/api/admin/config/sections" \
  -H "x-tenant-id: $TENANT_ID" \
  | jq
```

#### Response (401)

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
X-Request-ID: req_abc135

{
  "type": "https://liquifact.com/probs/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid or expired authentication token",
  "instance": "/api/admin/config/sections"
}
```

### Forbidden (403) — insufficient permissions

#### cURL

```bash
curl -s -X POST "$BASE_URL/api/admin/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "section": "webhook",
    "config": {
      "url": "https://valid.url/webhook",
      "secret": "abcdefghijklmnop",
      "events": ["invoice.created"]
    }
  }' \
  | jq
```

> This response occurs when the authenticated principal exists but does not have
> the required admin scope.

#### Response (403)

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
X-Request-ID: req_abc136

{
  "type": "https://liquifact.com/probs/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "Insufficient permissions. Admin access required.",
  "instance": "/api/admin/config"
}
```

### Rate limited (429)

The config endpoints have a per-client rate limiter (default: 20 requests per
60-second window per client identified by API key or IP).

#### cURL

```bash
# Rapid-fire requests to trigger the rate limiter
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X GET "$BASE_URL/api/admin/config/sections" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-tenant-id: $TENANT_ID"
done
```

#### Response (429)

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
X-Request-ID: req_abc137
Retry-After: 60

{
  "type": "https://liquifact.com/probs/rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "code": "RATE_LIMITED",
  "detail": "Rate limit exceeded. Please try again later.",
  "instance": "/api/admin/config/sections",
  "retryable": true,
  "retry_hint": "Retry after the Retry-After period",
  "scope": "config"
}
```

---

## Quick reference

### Required headers

| Header | Value | Required |
|--------|-------|----------|
| `Authorization` | `Bearer <jwt-token>` or `Bearer <api-key>` | **Yes** |
| `x-tenant-id` | Tenant identifier string | **Yes** (multi-tenant) |
| `Content-Type` | `application/json` | **Yes** (POST only) |

### Section config field summary

| Section | Required fields | Optional fields |
|---------|----------------|-----------------|
| `webhook` | `url`, `secret`, `events` | `maxRetries`, `timeoutMs`, `enabled` |
| `reconciliation` | At least one field | `batchSize`, `maxDriftSeconds`, `scheduleExpression`, `enabled` |
| `kyc` | `providerUrl`, `apiKey` | `timeoutMs`, `retries` |
| `retention` | At least one field | `retentionDays`, `purgeEnabled`, `batchSize`, `purgeCron`, `legalHoldReasons` |
| `fraudThresholds` | At least one field | `fraudCeiling`, `manualReviewThreshold` |

### Validation constraints

| Field | Constraint |
|-------|------------|
| `url`, `providerUrl` | Valid HTTPS URL, max 2048 chars |
| `secret` | Min 16, max 256 characters |
| `apiKey` | Min 8, max 256 characters |
| `events` | Array of 1–50 strings (each 1–100 chars) |
| `maxRetries` | Integer 0–10 |
| `timeoutMs` | Integer 500–30 000 |
| `batchSize` | Integer 1–500 (reconciliation) or 1–1000 (retention) |
| `maxDriftSeconds` | Integer 0–3600 |
| `scheduleExpression`, `purgeCron` | String 1–100 chars |
| `retentionDays` | Integer 1–3650 |
| `legalHoldReasons` | Array of up to 20 strings (each 1–100 chars) |
| `fraudCeiling`, `manualReviewThreshold` | Finite number 1–1 000 000 000 |
| `manualReviewThreshold` | Must be ≤ `fraudCeiling` |
