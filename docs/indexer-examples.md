# Indexer endpoint examples

This document provides ready-to-run `curl` examples for the admin indexer endpoint exposed by the backend.

## Base URL

```bash
export BASE_URL="http://localhost:3001"
```

## Authentication

The route at `/api/admin/indexer/events` accepts either:

- an `Authorization: Bearer <JWT>` header, or
- an `X-API-Key: <key>` header.

For local testing, set one of the following before running the examples:

```bash
export ADMIN_JWT="<admin-jwt>"
export API_KEY="<valid-api-key>"
```

If your deployment expects a tenant context, also set:

```bash
export TENANT_ID="tenant-test"
```

## 1. List the latest indexed events

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

Example response shape:

```json
{
  "data": [
    {
      "event_id": "evt_9f21ac",
      "invoice_id": "inv_001",
      "event_type": "escrow_created",
      "ledger_sequence": 100,
      "paging_token": "100-1",
      "contract_id": null,
      "tx_hash": null,
      "observed_at": "2026-01-01T00:00:00.000Z",
      "created_at": "2026-01-01T00:00:01.000Z"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 20,
    "hasMore": false,
    "nextCursor": null,
    "timestamp": "2026-07-25T12:00:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Indexer events retrieved successfully."
}
```

## 2. Filter by invoice ID and page size

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?invoiceId=inv_001&limit=10" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

This uses the validated `invoiceId` filter, which accepts 1-128 characters matching `^[a-zA-Z0-9_-]+$`.

## 3. Filter by event type and sort by ledger sequence

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?eventType=escrow_created&sortBy=ledger_sequence&order=asc&limit=25" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

Supported `sortBy` values are `observed_at` and `ledger_sequence`.

## 4. Use cursor pagination for stable paging

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?limit=5" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

Use the returned `meta.nextCursor` value on the next request:

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?cursor=<nextCursor>&limit=5" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

Cursors are opaque and HMAC-signed. A malformed or tampered cursor returns `400` with a validation error.

## 5. Authenticate with an API key instead of a JWT

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?limit=5" \
  -H "X-API-Key: $API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

## Validation examples

### Invalid sort field

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?sortBy=yield_bps" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

This returns `400` with a validation error because `sortBy` must be one of `observed_at` or `ledger_sequence`.

### Invalid contract ID

```bash
curl -X GET "$BASE_URL/api/admin/indexer/events?contractId=BADADDR" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "Accept: application/json"
```

This returns `400` because `contractId` must match the Stellar contract address format.
