# Runbook: API Keys Subsystem

## Overview

The api-keys subsystem authenticates service-to-service requests via a static,
environment-configured key registry. There is no database table and no
runtime key issuance — keys are provisioned by setting the `API_KEYS`
environment variable and redeploying/restarting the process.

**Source of truth:**
- Configuration & parsing: `src/config/apiKeys.js`
- Request authentication middleware: `src/middleware/apiKeyAuth.js`

## How it works

1. A client sends a request with an `X-API-Key` header.
2. `authenticateApiKey()` middleware (in `apiKeyAuth.js`) reads the header,
   trims it, and looks it up against the in-memory registry built by
   `loadApiKeyRegistry()`.
3. Key comparison is constant-time (`timingSafeStringEqual`, SHA-256 hash +
   `crypto.timingSafeEqual`) to prevent timing-based key enumeration.
4. On a match: the entry's `revoked` flag is checked, then (if the route
   requires one) the entry's `scopes` array is checked against the route's
   `requiredScope`.
5. On success, `req.apiClient = { clientId, scopes }` is attached for
   downstream handlers.

The registry is rebuilt from `process.env.API_KEYS` on **every request** (not
cached at startup) — see "Rotating or revoking a key" below for why this
matters operationally.

## Configuration

### `API_KEYS` environment variable

A semicolon-separated list of JSON objects, one per key:



Each entry:

| Field      | Type       | Required | Notes                                                        |
|------------|------------|----------|----------------------------------------------------------------|
| `key`      | string     | yes      | Must start with `lf_` and be at least 10 characters total.     |
| `clientId` | string     | yes      | Non-empty; identifies the calling service in logs/`req.apiClient`. |
| `scopes`   | string[]   | yes      | Non-empty array; each value must be one of the valid scopes below. |
| `revoked`  | boolean    | no       | Defaults to `false`. Set `true` to disable a key without deleting it. |

### Valid scopes

Defined in `VALID_SCOPES` (`src/config/apiKeys.js`):
- `invoices:read`
- `invoices:write`
- `escrow:read`

Any scope outside this list causes **the entire `API_KEYS` variable to fail
validation at load time** (see Failure Modes below) — this is not per-key,
it's fail-fast for the whole registry.

## Common failure modes

### 1. Missing header → `401`
```json
{ "error": "API key is required. Provide it via the X-API-Key header." }
```
Client didn't send `X-API-Key`. Not a server-side problem; confirm with the
calling team that they're setting the header.

### 2. Invalid/unknown key → `401`
```json
{ "error": "Invalid API key." }
```
The key wasn't found in the registry. Causes:
- Typo in the client's key.
- Key was rotated/removed from `API_KEYS` but the client wasn't updated.
- `API_KEYS` env var isn't set at all in this environment (registry is empty).

### 3. Revoked key → `401`
```json
{ "error": "API key has been revoked." }
```
The key exists in the registry with `"revoked": true`. Intentional — confirm
with whoever revoked it before re-enabling.

### 4. Insufficient scope → `403`
```json
{ "error": "Insufficient permissions. Required scope: \"<scope>\"." }
```
Key is valid but missing the scope required by the route. Add the scope to
that key's `scopes` array in `API_KEYS` and redeploy.

### 5. Process fails to start / crashes on config load
`loadApiKeyRegistry()` → `parseApiKeys()` throws synchronously if:
- Any entry is malformed JSON.
- Any entry is missing `key`, `clientId`, or `scopes`.
- Any `key` doesn't start with `lf_` or is under 10 characters.
- Any `scopes` entry isn't in `VALID_SCOPES`.
- Two entries share the same `key` string (`buildKeyRegistry` duplicate check).

Since the registry is rebuilt on every request (not just at startup), a
malformed `API_KEYS` value will cause **every authenticated request to throw**,
not just fail to start. This will surface as 500s across every api-key-gated
route, not a clean startup failure — check application logs for the specific
`Error` message thrown by `validateEntry`/`parseApiKeys`, which names the
exact index and field that failed.

## Alerts

*(Adjust to match this repo's actual alerting/observability stack — the
following describes what to watch for based on the code's behavior, not a
specific existing alert.)*

- Spike in `401` responses on api-key-gated routes → likely a client-side key
  rotation that wasn't coordinated, or an accidental revocation.
- Spike in `500` responses on api-key-gated routes → likely a malformed
  `API_KEYS` env var deployed (see Failure Mode 5 above). Check recent
  deploys/config changes first.
- `403` responses are expected when a legitimate client is missing a scope;
  only alert on unexpected volume increases, not the existence of any `403`.

## Recovery steps

### Rotating a key
1. Add the new `{"key": "...", "clientId": "...", "scopes": [...]}` entry to
   `API_KEYS` (append with a `;` separator).
2. Deploy the updated env var to all relevant environments.
3. Confirm the client has switched to the new key.
4. Once confirmed, either remove the old entry or set `"revoked": true` on it
   as an interim step before full removal.

### Revoking a compromised key immediately
1. Find the entry in `API_KEYS` matching the compromised key.
2. Set `"revoked": true` on that entry (do not delete it yet — this preserves
   an audit trail of which key existed and was revoked, vs. removing it
   entirely).
3. Redeploy. Because the registry is rebuilt per-request, revocation takes
   effect on the next request after the new env var is live — no
   in-process restart-and-wait needed beyond the deploy itself.

### Diagnosing "valid key returns 401"
1. Confirm the exact header name is `X-API-Key` (case-insensitive per HTTP,
   but the code reads `req.headers['x-api-key']` — most frameworks
   lowercase headers automatically, but verify if using a custom client).
2. Confirm the key in `API_KEYS` for this environment matches character-for-
   character what the client is sending (leading/trailing whitespace is
   trimmed on both sides, so that specifically is not the cause).
3. Confirm `API_KEYS` is actually set in this environment — an empty/unset
   value results in an empty registry, meaning every key looks "unknown."

### Diagnosing "everything is 500ing on api-key routes"
1. This points to Failure Mode 5 — `API_KEYS` failed validation.
2. Check the most recent change to the `API_KEYS` env var.
3. Look for the thrown error message; it names the failing index (0-based
   position in the semicolon-separated list) and the specific field/reason.
4. Roll back the env var change, or fix the specific malformed entry it
   identifies.

## Cross-references

- Middleware: `src/middleware/apiKeyAuth.js` — `authenticateApiKey()`,
  `timingSafeStringEqual()`, `findEntry()`.
- Config/parsing: `src/config/apiKeys.js` — `parseApiKeys()`,
  `validateEntry()`, `buildKeyRegistry()`, `loadApiKeyRegistry()`.
- Tests: `tests/apiKey.test.js`, `tests/unit/apiKeyAuth.test.js`.