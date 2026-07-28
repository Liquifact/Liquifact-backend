# KYC Webhooks — Copy-Paste Request Examples

Ready-to-run `curl` and HTTP examples for every KYC webhook endpoint.

## Setup

```bash
export BASE_URL="http://localhost:3001"
export JWT="<your-jwt-token>"
export ADMIN_API_KEY="<your-admin-api-key>"
export KYC_SECRET="<your-kyc-provider-secret>"
```

## HMAC Signature Helper

The `POST /api/kyc/webhook` endpoint requires an `X-Signature` header in the format `t=<unix_epoch_seconds>,v1=<hmac_hex>`. Generate one with:

```bash
# Generate a signature for a given payload
payload='{"smeId":"sme_acme_01","status":"verified"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')
echo "X-Signature: t=$ts,v1=$sig"
```

Or inline with Node.js:

```bash
node -e "
const crypto = require('crypto');
const secret = process.env.KYC_SECRET;
const body = JSON.stringify({smeId:'sme_acme_01',status:'verified'});
const ts = Math.floor(Date.now()/1000);
const sig = crypto.createHmac('sha256',secret).update(ts+'.'+body).digest('hex');
console.log('t='+ts+',v1='+sig);
"
```

---

## 1. Ingest KYC Webhook

`POST /api/kyc/webhook`

Ingests a KYC status update from an external provider. Requires HMAC signature and JWT auth.

### Verified status

```bash
payload='{"smeId":"sme_acme_01","status":"verified","recordId":"rec_abc123","verifiedAt":"2025-06-01T12:00:00.000Z"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "smeId": "sme_acme_01",
  "status": "verified"
}
```

### Pending status (using legacy field name)

```bash
payload='{"sme_id":"sme_beta_02","kyc_status":"in_review","provider_record_id":"rec_def456"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "smeId": "sme_beta_02",
  "status": "pending"
}
```

### Rejected status

```bash
payload='{"smeId":"sme_gamma_03","status":"denied","recordId":"rec_ghi789","verifiedAt":"2025-06-02T08:30:00.000Z"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "smeId": "sme_gamma_03",
  "status": "rejected"
}
```

### Exempted status

```bash
payload='{"smeId":"sme_delta_04","status":"exempted","recordId":"rec_jkl012"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "smeId": "sme_delta_04",
  "status": "exempted"
}
```

### Error: Missing signature

```bash
curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"smeId":"sme_acme_01","status":"verified"}'
```

**Response:**
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Missing X-Signature header"
}
```

### Error: Invalid signature

```bash
curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=1234567890,v1=deadbeef" \
  -d '{"smeId":"sme_acme_01","status":"verified"}'
```

**Response:**
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Invalid webhook signature"
}
```

### Error: Unknown provider status

```bash
payload='{"smeId":"sme_acme_01","status":"unknown_status_value"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Unknown provider status: unknown_status_value"
}
```

### Error: Missing smeId

```bash
payload='{"status":"verified"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Missing or invalid smeId"
}
```

### Error: Missing status

```bash
payload='{"smeId":"sme_acme_01"}'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Missing or invalid status"
}
```

### Error: Malformed JSON

```bash
payload='not valid json'
ts=$(date +%s)
sig=$(echo -n "$ts.$payload" | openssl dgst -sha256 -hmac "$KYC_SECRET" | sed 's/^.* //')

curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=$ts,v1=$sig" \
  -d "$payload"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Invalid JSON payload"
}
```

### Error: Service not configured

Unset `KYC_PROVIDER_SECRET` and send a valid request:

```bash
curl -X POST "$BASE_URL/api/kyc/webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Signature: t=1234567890,v1=abcd1234" \
  -d '{"smeId":"sme_acme_01","status":"verified"}'
```

**Response:**
```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "error": "KYC webhook ingestion is not configured"
}
```

---

## 2. List KYC Records

`GET /api/kyc/webhooks`

Cursor-paginated listing of KYC records scoped to the authenticated tenant.

### Default page (first 20 records)

```bash
curl "$BASE_URL/api/kyc/webhooks" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "smeId": "sme_delta_04",
      "status": "exempted",
      "recordId": "rec_jkl012",
      "verifiedAt": null,
      "updatedAt": "2025-06-02T10:15:00.000Z"
    },
    {
      "smeId": "sme_gamma_03",
      "status": "rejected",
      "recordId": "rec_ghi789",
      "verifiedAt": "2025-06-02T08:30:00.000Z",
      "updatedAt": "2025-06-02T08:30:00.000Z"
    },
    {
      "smeId": "sme_beta_02",
      "status": "pending",
      "recordId": "rec_def456",
      "verifiedAt": null,
      "updatedAt": "2025-06-01T14:00:00.000Z"
    },
    {
      "smeId": "sme_acme_01",
      "status": "verified",
      "recordId": "rec_abc123",
      "verifiedAt": "2025-06-01T12:00:00.000Z",
      "updatedAt": "2025-06-01T12:00:00.000Z"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": false,
    "nextCursor": null
  }
}
```

### Filter by status

```bash
curl "$BASE_URL/api/kyc/webhooks?status=verified" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "smeId": "sme_acme_01",
      "status": "verified",
      "recordId": "rec_abc123",
      "verifiedAt": "2025-06-01T12:00:00.000Z",
      "updatedAt": "2025-06-01T12:00:00.000Z"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": false,
    "nextCursor": null
  }
}
```

### Paginated with custom limit and cursor

```bash
curl "$BASE_URL/api/kyc/webhooks?limit=2" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    { "smeId": "sme_delta_04", "status": "exempted", "recordId": "rec_jkl012", "verifiedAt": null, "updatedAt": "2025-06-02T10:15:00.000Z" },
    { "smeId": "sme_gamma_03", "status": "rejected", "recordId": "rec_ghi789", "verifiedAt": "2025-06-02T08:30:00.000Z", "updatedAt": "2025-06-02T08:30:00.000Z" }
  ],
  "meta": {
    "limit": 2,
    "hasMore": true,
    "nextCursor": "eyJzb3J0RmllbGQiOiJ1cGRhdGVkX2F0Iiwic29ydFZhbHVlIjoiMjAyNS0wNi0wMlQwODozMDowMC4wMDBaIiwiaWQiOiJzbWVfZ2FtbWFfMDMifQ=="
  }
}
```

Use the `nextCursor` value to fetch the next page:

```bash
curl "$BASE_URL/api/kyc/webhooks?limit=2&cursor=eyJzb3J0RmllbGQiOiJ1cGRhdGVkX2F0Iiwic29ydFZhbHVlIjoiMjAyNS0wNi0wMlQwODozMDowMC4wMDBaIiwiaWQiOiJzbWVfZ2FtbWFfMDMifQ==" \
  -H "Authorization: Bearer $JWT"
```

### Error: Invalid limit

```bash
curl "$BASE_URL/api/kyc/webhooks?limit=200" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "limit must be an integer between 1 and 100",
  "code": "INVALID_PAGINATION"
}
```

### Error: Invalid cursor

```bash
curl "$BASE_URL/api/kyc/webhooks?cursor=not-a-valid-cursor" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Invalid cursor: ...",
  "code": "INVALID_CURSOR"
}
```

---

## 3. List Dead-Letter Rows

`GET /api/admin/webhooks/dead-letters`

Filterable, cursor-paginated listing of failed webhook deliveries. Admin-only.

### Default listing

```bash
curl "$BASE_URL/api/admin/webhooks/dead-letters" \
  -H "Authorization: Bearer $JWT"
```

Or using an API key:

```bash
curl "$BASE_URL/api/admin/webhooks/dead-letters" \
  -H "X-API-Key: $ADMIN_API_KEY"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "id": "dl_001",
      "event": "invoice.approved",
      "webhook_url": "https://example.com/webhooks",
      "attempts": 4,
      "last_error": "Webhook responded with 500",
      "resolved": false,
      "resolved_at": null,
      "created_at": "2025-06-01T10:00:00.000Z",
      "updated_at": "2025-06-01T10:05:00.000Z"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": false,
    "nextCursor": null
  },
  "message": "Dead-letter rows retrieved successfully."
}
```

### Filtered by event and resolved status

```bash
curl "$BASE_URL/api/admin/webhooks/dead-letters?event=invoice.approved&resolved=false" \
  -H "Authorization: Bearer $JWT"
```

### Filtered by date range

```bash
curl "$BASE_URL/api/admin/webhooks/dead-letters?createdAfter=2025-06-01T00:00:00Z&createdBefore=2025-06-30T00:00:00Z" \
  -H "Authorization: Bearer $JWT"
```

---

## 4. Replay Single Dead-Letter

`POST /api/admin/webhooks/replay/:id`

Replays a single dead-letter row. Admin-only.

### Success

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay/dl_001" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "replayed": ["dl_001"]
}
```

### Error: Not found

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay/nonexistent" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "Dead-letter row not found: nonexistent"
}
```

### Error: Already resolved

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay/dl_002" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": "Dead-letter row already resolved: dl_002"
}
```

### Error: Replay failed

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay/dl_003" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json

{
  "error": "Replay failed: No webhook secret configured for tenant t_123"
}
```

---

## 5. Batch Replay Dead-Letters

`POST /api/admin/webhooks/replay`

Replays multiple dead-letter rows in a batch. Admin-only.

### By explicit ID list

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "ids": ["dl_001", "dl_004", "dl_005"]
  }'
```

**Response:**
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "replayed": ["dl_001", "dl_004"],
  "failed": [
    {
      "id": "dl_005",
      "error": "Dead-letter row already resolved: dl_005"
    }
  ]
}
```

### By tenant filter

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "tenantId": "t_123",
    "limit": 50
  }'
```

### Error: Missing body fields

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{}'
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Provide either \"ids\" array or \"tenantId\" filter."
}
```

### Error: Empty ids array

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/replay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"ids": []}'
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "\"ids\" must be a non-empty array."
}
```

---

## 6. Resolve Dead-Letter

`POST /api/admin/webhooks/resolve/:id`

Marks a dead-letter row as resolved without re-sending. Admin-only.

### Success

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/resolve/dl_001" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "resolved": "dl_001"
}
```

### Error: Not found

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/resolve/nonexistent" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "Dead-letter row not found: nonexistent"
}
```

### Error: Already resolved

```bash
curl -X POST "$BASE_URL/api/admin/webhooks/resolve/dl_002" \
  -H "Authorization: Bearer $JWT"
```

**Response:**
```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": "Dead-letter row already resolved: dl_002"
}
```

---

## Quick Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST`   | `/api/kyc/webhook`                 | JWT + HMAC Signature | Ingest KYC status update |
| `GET`    | `/api/kyc/webhooks`                | JWT                  | List KYC records |
| `GET`    | `/api/admin/webhooks/dead-letters` | JWT or X-API-Key     | List dead-letter rows |
| `POST`   | `/api/admin/webhooks/replay/:id`   | JWT or X-API-Key     | Replay single dead-letter |
| `POST`   | `/api/admin/webhooks/replay`       | JWT or X-API-Key     | Batch replay dead-letters |
| `POST`   | `/api/admin/webhooks/resolve/:id`  | JWT or X-API-Key     | Resolve dead-letter |

### Required Headers

| Endpoint | Headers |
|----------|---------|
| `POST /api/kyc/webhook` | `Content-Type: application/json`, `Authorization: Bearer <jwt>`, `X-Signature: t=<ts>,v1=<hmac>` |
| `GET /api/kyc/webhooks` | `Authorization: Bearer <jwt>` |
| Admin endpoints | `Authorization: Bearer <jwt>` **or** `X-API-Key: <key>` |

### Provider Status → Internal Status Map

| Provider Status | Internal Status |
|----------------|-----------------|
| `pending`, `in_review`, `reviewing`, `queued`, `submitted` | `pending` |
| `verified`, `approved`, `pass`, `success` | `verified` |
| `rejected`, `denied`, `declined`, `failed` | `rejected` |
| `exempted`, `exempt`, `waived` | `exempted` |
| Any other value | Rejected with `400 Unknown provider status` |
