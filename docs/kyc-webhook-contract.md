# KYC Inbound Webhook Contract

This document describes the inbound KYC webhook that external KYC providers
POST to for signalling SME verification events.

Endpoint
- POST /api/kyc/webhook
- Content-Type: `application/json`

Raw-body requirement
- The signature is computed over the raw JSON string exactly as transmitted
  (including whitespace). The server expects the request body to be available
  as raw bytes (the app mounts `express.raw({ type: 'application/json' })`).

Signature scheme
- Header: `X-Signature: t=<unix_ts_seconds>,v1=<hex64_hmac>`
- Computation: `hmac = HMAC-SHA256(secret, `${t}.${rawBody}`)`; the header
  includes the timestamp `t` (seconds) and the hex-encoded signature `v1`.
- The server verifies:
  - header format and length guards,
  - timestamp within tolerance (default 5 minutes),
  - HMAC equality using a constant-time compare.

Accepted payload shape and aliases
- SME identifier (required):
  - `smeId` (preferred) or `sme_id`
- Status (required):
  - `status` (preferred) or `kycStatus` or `kyc_status`
- Provider record identifier (optional):
  - `recordId` or `providerRecordId` or `provider_record_id`
- Verified timestamp (optional):
  - `verifiedAt` or `verified_at` (ISO 8601)
- Tenant id (optional but required when the authenticated principal has a tenant):
  - `tenantId` or `tenant_id`

Example minimal payload
```
{ "smeId": "sme-123", "status": "verified" }
```

Responses
- 200 OK — Ingested and persisted.
  - Body: `{ "success": true, "smeId": "...", "status": "verified" }`
- 400 Bad Request — Malformed JSON, missing or invalid fields, or provider
  status not recognised (fail-closed). Body: `{ "error": "..." }`.
- 401 Unauthorized — Missing or invalid `X-Signature` header.
- 403 Forbidden — Tenant scope mismatch (`tenantId` mismatch).
- 500 Internal Server Error — Persistence/processing failure.
- 503 Service Unavailable — Provider secret not configured; ingestion is
  disabled. Body: `{ "error": "KYC webhook ingestion is not configured" }`.

Provider status → internal status mapping

The webhook handler normalises provider-specific status strings using the
`PROVIDER_STATUS_MAP` in `src/services/kycService.js`. The mapping is:

| Provider status (example variants) | Internal status |
|---|---|
| pending, in_review, reviewing, queued, submitted | pending |
| verified, approved, pass, success | verified |
| rejected, denied, declined, failed | rejected |
| exempted, exempt, waived | exempted |

Any provider string not present in the mapping is treated as `unknown` and
results in a 400 response (fail-closed).

Notes for integrators
- Compute the signature over the exact bytes you transmit. Any change in
  whitespace or field ordering will change the signature.
- Use the `t=<seconds>` value from your clock (UTC); the server allows a
  5-minute window by default.
- Do not include secrets in the payload; the signing secret is separate and
  must be shared out-of-band.

See also
- Implementation: `src/routes/kyc.js`
- Signature helpers: `src/services/webhooks.js`
- Status mapping and persistence: `src/services/kycService.js`
