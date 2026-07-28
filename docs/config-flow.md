# Config Request Lifecycle

> **Scope:** `Liquifact/Liquifact-backend`
> **Last updated:** 2026-07-25
> **Cross-reference:** `src/routes/adminConfig.js` · `src/schemas/config.js` · `src/middleware/stacks.js` · `src/middleware/rateLimit.js` · `src/middleware/idempotency.js`
> **Changelog:** [changelog-config.md](./changelog-config.md)

## Overview

The admin config surface exposes two HTTP endpoints — a write endpoint for updating runtime configuration sections and a read endpoint for listing valid section names. Both are admin-only, rate-limited, and tenant-scoped. The write path validates the request body against a section-specific Zod schema, applies an idempotency guard when the client supplies an `Idempotency-Key` header, performs side effects for CORS configuration, and logs the change — but does **not** persist the config to a database (configuration is ephemeral and held in process memory).

---

## Flow diagram

```mermaid
flowchart LR
  subgraph POST
    A[POST /api/admin/config\nbody: { section, config }]
    --> B[adminConfigLimiter\nsrc/middleware/rateLimit.js]
    --> C[adminStack\nsrc/middleware/stacks.js]
    --> D[idempotencyMiddleware\nsrc/middleware/idempotency.js]
    --> E[validateBody runtimeConfigSchema\nsrc/schemas/config.js]
    --> F[Handler: apply side effects\nsrc/routes/adminConfig.js]
    --> G[200 response\nsrc/routes/adminConfig.js]
  end

  subgraph GET
    H[GET /api/admin/config/sections]
    --> I[adminConfigLimiter\nsrc/middleware/rateLimit.js]
    --> J[adminStack\nsrc/middleware/stacks.js]
    --> K[Return CONFIG_SECTIONS\nsrc/routes/adminConfig.js]
  end
```

---

## POST /api/admin/config

### Stage 1 — Rate limiting

**File:** `src/middleware/rateLimit.js:297` — `adminConfigLimiter`

Mounted **before** the admin auth stack (`router.use(adminConfigLimiter)` at `src/routes/adminConfig.js:48`). This ordering means failed authentication attempts still consume the per-client rate-limit budget, defending against auth-flooding attacks.

The limiter is a `express-rate-limit` instance configured with:

| Parameter | Value |
|-----------|-------|
| `windowMs` | `CONFIG_RATE_LIMIT_WINDOW_MS` (env `RATE_LIMIT_CONFIG_WINDOW_MS`, default 60 s) |
| `limit` | `CONFIG_RATE_LIMIT_MAX` (env `RATE_LIMIT_CONFIG_MAX`, default 20) |
| `keyGenerator` | `adminConfigKeyGenerator` — uses `X-API-Key` header if present (prefix `apikey_`), otherwise falls back to `req.ip`. |
| `store` | `resolveRateLimitStore('config')` — Redis-backed in production, in-memory fallback in development/test. |
| `handler` | `adminConfigHandler` — returns a structured `RATE_LIMITED` JSON body with `Retry-After` header. |

**Error path:** When the budget is exhausted, the handler returns `429` with:
```json
{
  "type": "https://liquifact.com/probs/too-many-requests",
  "title": "Too Many Requests",
  "status": 429,
  "code": "RATE_LIMITED",
  "retryable": true,
  "retry_hint": "Wait for the rate-limit window to reset before retrying.",
  "scope": "config",
  "error": "Too many requests.",
  "message": "Rate limit threshold breached for /api/admin/config. Please try again later."
}
```

### Stage 2 — Auth and tenant extraction

**File:** `src/middleware/stacks.js:63` — `adminStack`

Applied via `router.use(...adminStack)` at `src/routes/adminConfig.js:51`.

The stack executes:

1. **`adminAuth`** (`src/middleware/stacks.js:32`):
   - If `x-api-key` header is present: delegates to `authenticateApiKey()` (`src/middleware/apiKeyAuth.js:91`) with **no** `requiredScope` — any valid, non-revoked key is accepted. Attaches `req.apiClient`.
   - Otherwise: delegates to `authenticateToken` (`src/middleware/auth.js:57`). Validates `Authorization: Bearer <JWT>` with algorithm allowlist (default `HS256`), optional issuer/audience checks. Attaches `req.user`.

2. **`extractTenant`** (`src/middleware/tenant.js:54`):
   - Resolves `req.tenantId` from `x-tenant-id` header (highest priority) or `req.user.tenantId` (JWT claim). Returns `400` if neither source yields a value.

**Error paths:**
- JWT missing/invalid/expired: `authenticateToken` calls `next(new AppError(...))` which is caught by `handleInternalError` in `src/app.js:96`, returning 401.
- API key missing/invalid/revoked: `authenticateApiKey` responds directly with 401 JSON (bypasses the centralized error handler).
- Tenant resolution failure: `extractTenant` responds with `400` `{ error: 'Missing tenant context.' }`.

### Stage 3 — Idempotency

**File:** `src/middleware/idempotency.js` — `idempotencyMiddleware`

The route mounts `idempotencyMiddleware` directly at `src/routes/adminConfig.js:194`. Note there is also a redundant second import and an unused `optionalIdempotency` wrapper at line 62 (see [Known issues](#known-issues)).

The middleware checks for an `Idempotency-Key` header. When present, it validates the key against the pattern `^[A-Za-z0-9._:-]{8,128}$` and looks it up in the `idempotency_keys` database table:

- **First request:** Stores the request fingerprint (SHA-256 of the body) with status `IN_PROGRESS`, then allows the handler to execute. After the handler responds, the response status and body are cached.
- **Retry with same key and body:** Returns the cached response directly (status `COMPLETED`).
- **Retry with same key and different body:** Returns `409 Conflict`.
- **No header:** The request passes through without idempotency checks.

**Error paths:**
- Invalid key format: Returns `400` with a structured error.
- Storage failure: Logs a warning, increments `idempotencyStorageFailureTotal` metric, but still allows the request to proceed.
- TTL expiry: Keys and cached responses expire after `IDEMPOTENCY_TTL_HOURS` (default 24 hours).

### Stage 4 — Body validation

**File:** `src/schemas/config.js:361` — `runtimeConfigSchema` validated via `validateBody()` from `src/schemas/invoice.js:329`

`validateBody` is a generic Express middleware factory. It calls `schema.safeParse(req.body)`, and on success attaches the parsed/coerced result to `req.validated`. On failure, it returns `400` with an RFC 7807 `application/problem+json` body containing a `fieldErrors` map.

The `runtimeConfigSchema` is a top-level Zod object with:

```
{ section: enum, config: record }
```

It then dispatches to a section-specific schema via `.superRefine()`:

| Section | Schema | Key fields |
|---------|--------|------------|
| `webhook` | `webhookConfigSchema` (`src/schemas/config.js:108`) | `url` (HTTPS URL, ≤2048 chars), `secret` (16–256 chars), `events` (array, 1–50 items, each ≤100 chars), `maxRetries` (0–10), `timeoutMs` (500–30000), `enabled` (boolean) |
| `reconciliation` | `reconciliationConfigSchema` (`src/schemas/config.js:149`) | `batchSize` (1–500), `maxDriftSeconds` (0–3600), `scheduleExpression` (≤100 chars), `enabled` (boolean). Must provide at least one field. |
| `kyc` | `kycConfigSchema` (`src/schemas/config.js:184`) | `providerUrl` (HTTPS URL, ≤2048 chars), `apiKey` (8–256 chars), `timeoutMs` (500–30000), `retries` (0–5). Both `providerUrl` and `apiKey` required together. |
| `retention` | `retentionConfigSchema` (`src/schemas/config.js:214`) | `retentionDays` (1–3650), `purgeEnabled` (boolean), `batchSize` (1–1000), `purgeCron` (≤100 chars), `legalHoldReasons` (array, ≤20 items, each ≤100 chars). Must provide at least one field. |
| `fraudThresholds` | `fraudThresholdsSchema` (`src/schemas/config.js:304`) | `fraudCeiling` (1–1e9), `manualReviewThreshold` (1–1e9). Cross-field: `manualReviewThreshold` ≤ `fraudCeiling`. Must provide at least one field. |
| `cors` | `corsConfigSchema` (`src/schemas/config.js:259`) | `origins` (array of valid URL origins, 1–20 items, each ≤2048 chars, must be root origin), `maxAge` (60–86400). Must provide at least one field. |

All section schemas use `.strict()` to reject unknown keys, preventing prototype-pollution payloads. String fields are length-bounded and trimmed. Numeric fields are range-checked.

**Error path:** Validation failure returns `400` with:
```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "fieldErrors": {
    "config.url": "url must be a valid URL",
    "config.secret": "secret must be at least 16 characters"
  }
}
```
Field error paths are prefixed with `config.` (e.g. `config.url` instead of just `url`).

### Stage 5 — Handler (side effects)

**File:** `src/routes/adminConfig.js:194`

The handler receives `req.validated` from the `validateBody` middleware, containing `{ section, config }`.

For most sections, the handler simply logs the update and returns `200` — **no database write occurs**. The config update is acknowledged at the API level but actual runtime behavior changes depend on how the consuming module reads its configuration (e.g., environment variables, feature flags, module-level state).

The **`cors` section** is special — it has immediate side effects:

```js
if (section === 'cors') {
  if (validatedConfig.origins) {
    process.env.CORS_ALLOWED_ORIGINS = validatedConfig.origins.join(',');
    reloadCorsOrigins();
  }
  if (validatedConfig.maxAge !== undefined) {
    process.env.CORS_MAX_AGE = String(validatedConfig.maxAge);
    reloadCorsMaxAge();
  }
}
```

`reloadCorsOrigins()` and `reloadCorsMaxAge()` (`src/config/cors.js`) update the in-memory CORS allowlist and max-age used by all subsequent requests. This is the only runtime side effect of the config endpoint.

A structured log line is emitted with `tenantId`, `section`, and `adminClient` (API key client ID or JWT subject).

**Error path:** The handler does not throw. Validation errors are handled by middleware before reaching the handler. There is no database persistence, so there are no store-level error paths.

### Stage 6 — Response

On success, returns `200` with:
```json
{
  "section": "webhook",
  "config": { "url": "https://hooks.example.com", "secret": "whsec_...", "events": ["invoice.paid"], "enabled": true },
  "message": "Configuration section 'webhook' validated and accepted."
}
```

---

## GET /api/admin/config/sections

### Stages 1–2

Same as POST: `adminConfigLimiter` → `adminStack` (auth + tenant).

### Stage 3 — Response

**File:** `src/routes/adminConfig.js:257`

Returns `200` with the static list of valid section names:
```json
{ "sections": ["webhook", "reconciliation", "kyc", "retention", "fraudThresholds", "cors"] }
```

The list is defined at `src/schemas/config.js:335` (`CONFIG_SECTIONS`). No database access, no side effects.

---

## Edge cases and gotchas

### No database persistence

The POST handler does **not** write configuration to any database table. It validates, logs, applies in-memory CORS changes, and returns. Configuration is ephemeral — a process restart resets all sections except CORS (which is re-read from environment variables at boot). This is a deliberate design choice; the endpoint serves as a validation gate and logging surface.

### CORS reload is a special side effect

Only the `cors` section triggers runtime behavior changes via `reloadCorsOrigins()` and `reloadCorsMaxAge()`. The other five sections are accepted and logged but have no automated side effects — consuming modules must check environment variables or feature flags independently.

### Idempotency middleware ordering

The `idempotencyMiddleware` is mounted **after** auth. This means idempotency checks run on every authenticated request, even those that don't carry an `Idempotency-Key` header (the middleware simply passes through when the header is absent). The route also defines an `optionalIdempotency` wrapper at line 62 that conditionally calls the middleware only when the header is present, but this wrapper is **never used** — the route directly mounts `idempotencyMiddleware` instead.

### Known issue: duplicate import

`src/routes/adminConfig.js` imports `idempotencyMiddleware` twice, at lines 37 and 40. The second declaration shadows the first and **causes a parse error** in current ESLint and Node.js strict mode. This is a pre-existing bug — the file cannot be required without hitting `SyntaxError: Identifier 'idempotencyMiddleware' has already been declared`.

### Rate limiter runs before auth

The `adminConfigLimiter` is mounted before `adminStack`, so failed auth attempts still consume the rate-limit budget. This prevents an attacker from cycling through API keys or tokens without being throttled.

### Key generation for rate limiting

The rate limiter keys on `X-API-Key` when present (prefixed with `apikey_`), falling back to `req.ip`. This means multiple clients sharing the same NAT IP are counted separately when they use distinct API keys, but a malicious actor who cycles API keys from the same IP is still throttled by the IP-based fallback.

### Idempotency TTL

Idempotency keys expire after 24 hours by default (`IDEMPOTENCY_TTL_HOURS`). After expiry, the same key can be reused for a new request. The TTL is configurable via environment variable.
