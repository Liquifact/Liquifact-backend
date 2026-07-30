# API Keys

This document covers the API key authentication contract used by Liquifact-backend: how keys are configured, the request header contract, every error code a caller can receive, and where this authentication is applied.

There is no key-management HTTP endpoint (no create/list/revoke route) — keys are provisioned via an environment variable and validated at request time by middleware. This document describes that contract in full.

## Overview

- **Module:** `src/middleware/apiKeyAuth.js` (middleware) + `src/config/apiKeys.js` (key registry/config)
- **Header:** `X-API-Key`
- **Applied to:** admin routes, via `adminStack` in `src/middleware/stacks.js`. `adminAuth` accepts either a valid JWT (`authenticateToken`) **or** a valid API key — if the `X-API-Key` header is present, the request is authenticated via API key; otherwise it falls back to JWT.

## Configuring keys

Keys are provisioned via the `API_KEYS` environment variable — a semicolon-separated list of JSON objects, one per key:

```
API_KEYS={"key":"lf_abc123...","clientId":"service-a","scopes":["invoices:read"]};{"key":"lf_xyz789...","clientId":"service-b","scopes":["invoices:write","escrow:read"],"revoked":true}
```

### Key entry shape

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | Yes | The raw key. Must start with `lf_` and be at least 10 characters long. |
| `clientId` | `string` | Yes | Identifier for the service/client this key belongs to. |
| `scopes` | `string[]` | Yes | Non-empty list of permissions granted to this key. Must be drawn from the valid scope list below. |
| `revoked` | `boolean` | No | Defaults to `false`. When `true`, the key is rejected at auth time regardless of validity. |

### Valid scopes

- `invoices:read`
- `invoices:write`
- `escrow:read`

Any scope outside this list fails validation when the registry is loaded (this happens at request time, not at process startup — see [Error codes](#error-codes) below).

Duplicate `key` values across entries are rejected when the registry is built.

## Request contract

Send the key in the `X-API-Key` header on any request to a route protected by `adminStack`:

```
GET /api/admin/some-resource
X-API-Key: lf_abc123yourkeyhere
```

On success, the middleware attaches an `apiClient` object to the request for downstream handlers to inspect:

```json
{
  "clientId": "service-a",
  "scopes": ["invoices:read", "invoices:write"]
}
```

No response body is added on success — the request simply proceeds to the handler.

## Scope enforcement

Some routes require a specific scope. When configured with a `requiredScope`, the middleware rejects any key that doesn't include that scope, even if the key is otherwise valid and not revoked.

## Error codes

| Status | Condition | Response body |
|--------|-----------|----------------|
| `401` | `X-API-Key` header missing or empty | `{ "error": "API key is required. Provide it via the X-API-Key header." }` |
| `401` | Key not found in the registry | `{ "error": "Invalid API key." }` |
| `401` | Key found but `revoked: true` | `{ "error": "API key has been revoked." }` |
| `403` | Key is valid but missing the route's required scope | `{ "error": "Insufficient permissions. Required scope: \"<scope>\"." }` |
| `500` | `API_KEYS` env var contains malformed JSON or fails validation | Handled by Express's default error handler (registry loading throws) |

### Example: missing header

Request:
```
GET /api/admin/some-resource
```

Response — `401`:
```json
{ "error": "API key is required. Provide it via the X-API-Key header." }
```

### Example: invalid key

Request:
```
GET /api/admin/some-resource
X-API-Key: lf_unknownkey000
```

Response — `401`:
```json
{ "error": "Invalid API key." }
```

### Example: revoked key

Request:
```
GET /api/admin/some-resource
X-API-Key: lf_revokedkey01
```

Response — `401`:
```json
{ "error": "API key has been revoked." }
```

### Example: insufficient scope

Request (route requires `invoices:write`, key only has `escrow:read`):
```
GET /api/admin/some-resource
X-API-Key: lf_scopedkey001
```

Response — `403`:
```json
{ "error": "Insufficient permissions. Required scope: \"invoices:write\"." }
```

### Example: valid key

Request:
```
GET /api/admin/some-resource
X-API-Key: lf_validkey001
```

Response: request proceeds to the handler with `req.apiClient = { clientId: "svc-a", scopes: ["invoices:read", "invoices:write"] }`.

## Security notes

- Key lookup uses SHA-256 hashing plus `crypto.timingSafeEqual` (`timingSafeStringEqual` in `apiKeyAuth.js`) and always evaluates every registry entry, so lookups are constant-time and don't leak which prefix of a key matched via response timing.
- The registry is rebuilt fresh from `process.env` on every request (not cached at module load), so key rotation via environment changes takes effect without a restart in test/override scenarios. In production this still requires a process restart since env vars are typically fixed at boot.
- Error responses never echo back the submitted key value.

## Testing

Coverage for this contract lives in:
- `tests/unit/apiKeyAuth.test.js` — registry parsing/validation (`config/apiKeys.js`) and the full middleware behavior (`middleware/apiKeyAuth.js`), including scope enforcement and timing-safe lookup.
- `tests/apiKey.test.js` — confirms the legacy SQLite-backed key middleware has been fully retired and exercises the same scenarios against the current env-registry implementation.

Current coverage for the two files (`npm test -- --coverage --collectCoverageFrom="src/middleware/apiKeyAuth.js" --collectCoverageFrom="src/config/apiKeys.js" --testPathPatterns="apiKey"`):

| File | % Stmts | % Branch | % Funcs | % Lines |
|------|---------|----------|---------|---------|
| `config/apiKeys.js` | 100 | 97.05 | 100 | 100 |
| `middleware/apiKeyAuth.js` | 100 | 88.23 | 100 | 100 |
