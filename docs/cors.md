# CORS API Contract

Cross-Origin Resource Sharing (CORS) for the LiquiFact backend is implemented in
[`src/config/cors.js`](../src/config/cors.js) and wired into Express in
[`src/app.js`](../src/app.js). This document is the single reference for every
integrator who needs to understand CORS policy, request/response shapes, and error
codes.

---

## Table of contents

1. [How CORS is applied](#1-how-cors-is-applied)
2. [Configuration reference](#2-configuration-reference)
3. [Origin normalization](#3-origin-normalization)
4. [Preflight requests (OPTIONS)](#4-preflight-requests-options)
5. [Simple and credentialed requests](#5-simple-and-credentialed-requests)
6. [Request/response examples](#6-requestresponse-examples)
   - [Allowed origin](#61-allowed-origin)
   - [Blocked origin](#62-blocked-origin)
   - [No-Origin request](#63-no-origin-request)
   - [null origin](#64-null-origin)
   - [Preflight success](#65-preflight-success)
   - [Preflight blocked](#66-preflight-blocked)
7. [Error codes](#7-error-codes)
8. [Dev-mode behaviour](#8-dev-mode-behaviour)
9. [Runtime allowlist reload](#9-runtime-allowlist-reload)
10. [Security notes](#10-security-notes)
11. [Module exports reference](#11-module-exports-reference)

---

## 1. How CORS is applied

`cors(createCorsOptions())` is the **first** middleware registered on the Express
app — before body parsers, auth, and all route handlers. Every inbound request
passes through the CORS check before any application logic runs.

The CORS middleware is provided by the [`cors`](https://www.npmjs.com/package/cors)
npm package. `createCorsOptions()` returns the options object that drives it:

```
Request
  └─► cors() ──[allowed]──► body parsers ──► route handlers
               └─[blocked]──► handleCorsError() ──► 403 JSON response
```

The error handler `handleCorsError` (defined in `app.js`) intercepts only the
specific rejection error produced by `createCorsRejectionError`; all other errors
are forwarded to the next handler.

---

## 2. Configuration reference

| Variable | Default | Description |
|---|---|---|
| `CORS_ORIGINS` | unset | Comma-separated list of allowed browser origins (exact match after normalization) |
| `CORS_ALLOWED_ORIGINS` | unset | Alias for `CORS_ORIGINS`. When **both** are set, `CORS_ALLOWED_ORIGINS` takes precedence |
| `CORS_MAX_AGE` | `600` | Preflight `Access-Control-Max-Age` in seconds. Must be a positive integer ≤ 86400 |

### Precedence and fallback

```
CORS_ALLOWED_ORIGINS  ──► takes precedence when non-empty
CORS_ORIGINS          ──► used when CORS_ALLOWED_ORIGINS is unset/empty
[dev fallback]        ──► used in NODE_ENV=development when neither is set
[deny all]            ──► used in all other environments when neither is set
```

### CORS_MAX_AGE validation

- Must be a positive integer in the range `1` to `86400` (inclusive).
- Values that are non-integer, zero, negative, or exceed 86400 fall back to `600`.
- The browser's own cap on `Access-Control-Max-Age` is also 86400 per the Fetch spec.

### Example `.env` snippet

```bash
# Allow two frontend origins
CORS_ORIGINS=https://app.example.com,https://admin.example.com

# Increase preflight cache to 1 hour
CORS_MAX_AGE=3600
```

---

## 3. Origin normalization

Before any allowlist comparison, both the incoming request origin and each entry in
the configured allowlist are normalized through the WHATWG `URL` parser:

```
normalizeOrigin(origin)
  → new URL(origin).origin   (lowercases scheme + host, strips path/trailing slash)
  → returns null for:
      • the literal string "null"
      • empty string or non-string input
      • any string that is not a valid URL
```

Practical consequences for integrators:

| Raw origin sent by browser | Normalized form | Allowed if `https://app.example.com` is listed? |
|---|---|---|
| `https://app.example.com` | `https://app.example.com` | ✅ yes |
| `https://app.example.com/` | `https://app.example.com` | ✅ yes |
| `HTTPS://APP.EXAMPLE.COM` | `https://app.example.com` | ✅ yes |
| `HTTPS://APP.EXAMPLE.COM/` | `https://app.example.com` | ✅ yes |
| `https://attacker.example.com` | `https://attacker.example.com` | ❌ no |
| `null` | `null` (rejected) | ❌ always blocked |
| `not-a-url` | `null` (rejected) | ❌ always blocked |

Allowlist entries set via `CORS_ORIGINS` are normalized by the same function, so
`HTTPS://APP.EXAMPLE.COM` and `https://app.example.com` in the allowlist are
equivalent.

---

## 4. Preflight requests (OPTIONS)

When a browser sends a cross-origin request that is not a simple request (e.g. it
uses a non-standard method or custom headers), it first sends an `OPTIONS` preflight.

**Preflight request headers sent by the browser:**

```
OPTIONS /api/invoices HTTP/1.1
Origin: https://app.example.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: authorization, content-type
```

**Preflight success response (204):**

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 600
Vary: Origin
```

The `optionsSuccessStatus` is set to `204` — some older browsers require this for
preflight responses.

**Preflight blocked response (403):**

```
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "CORS policy: origin is not allowed.",
  "code": "CORS_ORIGIN_REJECTED"
}
```

---

## 5. Simple and credentialed requests

For non-preflight cross-origin requests:

- When the origin is **allowed**: the `cors` middleware adds
  `Access-Control-Allow-Origin` set to the exact incoming origin (not `*`) and
  `Access-Control-Allow-Credentials: true`. This ensures cookies and authorization
  headers work with credentialed fetches.
- When the origin is **blocked**: the CORS callback passes the rejection error to
  Express. The `handleCorsError` middleware returns `403 Forbidden` with the
  structured JSON payload described in [§7 Error codes](#7-error-codes).
- When there is **no `Origin` header**: the request is a non-browser client (curl,
  Postman, server-side fetch). It is always allowed and no CORS response headers
  are added.

### Why origins are never wildcarded for credentialed responses

The CORS spec prohibits `Access-Control-Allow-Origin: *` together with
`Access-Control-Allow-Credentials: true`. Only origins explicitly present in the
allowlist receive the `Access-Control-Allow-Origin` response header. Unlisted
origins — including `"null"` and any origin that fails normalization — are denied.

---

## 6. Request/response examples

### 6.1 Allowed origin

**Request:**

```http
GET /api/invoices HTTP/1.1
Host: api.example.com
Origin: https://app.example.com
Authorization: Bearer <token>
```

**Response (200):**

```http
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Vary: Origin
Content-Type: application/json

{
  "data": [...],
  "meta": { "total": 12, "page": 1, "limit": 10 },
  "message": "Invoices retrieved successfully."
}
```

---

### 6.2 Blocked origin

**Request:**

```http
GET /api/invoices HTTP/1.1
Host: api.example.com
Origin: https://attacker.example.com
```

**Response (403):**

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "CORS policy: origin is not allowed.",
  "code": "CORS_ORIGIN_REJECTED"
}
```

No `Access-Control-Allow-Origin` header is present. The browser will refuse to
expose the response body to the script that made the request.

---

### 6.3 No-Origin request

Non-browser clients that omit the `Origin` header are always passed through. No
CORS response headers are added, and the request proceeds normally.

**Request (curl):**

```bash
curl -s https://api.example.com/api/invoices \
  -H "Authorization: Bearer <token>"
```

**Response (200):** — standard response, no CORS headers.

---

### 6.4 `null` origin

Browsers send `Origin: null` for requests from sandboxed `<iframe>` elements,
`data:` URIs, and `file://` navigations.

**Request:**

```http
GET /api/invoices HTTP/1.1
Origin: null
```

**Response (403):**

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "CORS policy: origin is not allowed.",
  "code": "CORS_ORIGIN_REJECTED"
}
```

The literal string `"null"` is unconditionally denied — even if `"null"` appears
inside `CORS_ORIGINS`. `normalizeOrigin("null")` returns `null` immediately,
before any allowlist lookup.

---

### 6.5 Preflight success

**Request:**

```http
OPTIONS /api/invoices HTTP/1.1
Host: api.example.com
Origin: https://app.example.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: authorization, content-type
```

**Response (204):**

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Max-Age: 600
Vary: Origin
```

---

### 6.6 Preflight blocked

**Request:**

```http
OPTIONS /api/invoices HTTP/1.1
Origin: https://attacker.example.com
Access-Control-Request-Method: POST
```

**Response (403):**

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "CORS policy: origin is not allowed.",
  "code": "CORS_ORIGIN_REJECTED"
}
```

---

## 7. Error codes

CORS produces exactly one error type. There are no partial or degraded responses.

| Field | Value |
|---|---|
| HTTP status | `403 Forbidden` |
| `error` | `"CORS policy: origin is not allowed."` |
| `code` | `"CORS_ORIGIN_REJECTED"` |

**Full response body:**

```json
{
  "error": "CORS policy: origin is not allowed.",
  "code": "CORS_ORIGIN_REJECTED"
}
```

This shape is produced by `handleCorsError` in `app.js`:

```js
if (isCorsOriginRejectedError(err)) {
  res.status(403).json({ error: err.message, code: err.code });
}
```

### Detection in client code

The `code` field is stable across releases. Clients and integration tests should
check `code === "CORS_ORIGIN_REJECTED"` rather than parsing the human-readable
`error` string.

```js
// JavaScript fetch example
const res = await fetch('https://api.example.com/api/invoices');
if (!res.ok) {
  const body = await res.json();
  if (body.code === 'CORS_ORIGIN_REJECTED') {
    // The request origin is not in the allowlist.
  }
}
```

### Distinguishing a CORS block from a generic 403

A CORS rejection always includes the `"code": "CORS_ORIGIN_REJECTED"` field. A
generic authorization 403 from the application layer will not carry this code.

---

## 8. Dev-mode behaviour

When `NODE_ENV=development` and neither `CORS_ORIGINS` nor `CORS_ALLOWED_ORIGINS`
is set, the following origins are automatically allowed:

| Origin | Typical use |
|---|---|
| `http://localhost:3000` | Create React App / Next.js default |
| `http://localhost:3001` | Alternative local port |
| `http://localhost:5173` | Vite default |
| `http://127.0.0.1:3000` | Explicit loopback (Chrome treats differently to `localhost`) |
| `http://127.0.0.1:5173` | Vite on explicit loopback |

These fallback origins are exported as `DEV_DEFAULT_ORIGINS` from `src/config/cors.js`
and are **never** active in `production`, `staging`, or any environment other than
`development`.

Setting `CORS_ORIGINS` or `CORS_ALLOWED_ORIGINS` in development overrides the
fallback entirely — the explicit list is used as-is.

---

## 9. Runtime allowlist reload

The allowlist can be updated without restarting the server:

```js
const { reloadCorsOrigins } = require('./src/config/cors');

// After mutating process.env.CORS_ORIGINS (e.g. from a config reload):
reloadCorsOrigins();
```

`reloadCorsOrigins()` re-reads `CORS_ALLOWED_ORIGINS` / `CORS_ORIGINS` from
`process.env`, re-parses the comma-separated list, and replaces the module-level
allowlist. Requests already past the CORS middleware are not affected; new requests
see the updated allowlist immediately.

This is useful for:
- Admin endpoints that mutate config at runtime.
- Config file watchers that signal a reload without a process restart.

---

## 10. Security notes

| Property | Detail |
|---|---|
| No wildcard reflection | `Access-Control-Allow-Origin: *` is never returned for credentialed responses. Only explicitly allowlisted origins are reflected. |
| `null` origin unconditionally denied | `normalizeOrigin("null")` returns `null`; the allowlist lookup is never reached. Adding `"null"` to `CORS_ORIGINS` has no effect. |
| Case / trailing-slash normalization | Both sides of the comparison go through the WHATWG URL parser, so case variants and trailing-slash variants are matched correctly rather than treated as bypass attempts. |
| No origin reflection without explicit listing | An origin that is not in the allowlist never appears in any response header, regardless of request method or body. |
| Credential gating | `Access-Control-Allow-Credentials: true` is only returned for exact allowlisted origin matches. |
| `X-Forwarded-For` not consulted | CORS policy acts on the `Origin` request header set by the browser, not on IP-level forwarding headers. |

---

## 11. Module exports reference

`src/config/cors.js` exports the following public API:

| Export | Type | Description |
|---|---|---|
| `createCorsOptions(env?)` | `function` | Returns the `cors` middleware options object. Pass a custom env map in tests; defaults to `process.env`. |
| `normalizeOrigin(origin)` | `function` | Normalizes a raw origin string. Returns `null` for `"null"`, empty strings, and non-URL inputs. |
| `isAllowedOrigin(origin, allowlist)` | `function` | Returns `true` if the origin, after normalization, appears in the allowlist. |
| `parseAllowedOrigins(raw, opts?)` | `function` | Parses a raw comma-separated env value into a de-duplicated origin array. Supports `{ strict: true }` for structured validation output. |
| `parseMaxAge(raw, opts?)` | `function` | Parses `CORS_MAX_AGE`. Returns `600` on invalid input. Supports `{ strict: true }` for validation detail. |
| `reloadCorsOrigins()` | `function` | Hot-reloads the allowlist from `process.env` without a server restart. |
| `createCorsRejectionError(origin?)` | `function` | Creates the sentinel `Error` with `.isCorsOriginRejected = true`, `.code = "CORS_ORIGIN_REJECTED"`, `.status = 403`. |
| `isCorsOriginRejectedError(err)` | `function` | Returns `true` if `err` is a CORS rejection produced by `createCorsRejectionError`. |
| `validateCorsOrigin(origin, allowlist)` | `function` | Returns `true` if the origin is `undefined` (no-origin pass-through) or is in the allowlist. |
| `resolveAllowlist(env?)` | `function` | Returns the effective allowlist for the given env, including the dev fallback logic. |
| `getAllowedOriginsFromEnv(env?)` | `function` | Reads `CORS_ALLOWED_ORIGINS` / `CORS_ORIGINS` from the env map and applies the dev fallback. |
| `getDevelopmentFallbackOrigins()` | `function` | Returns the `DEV_DEFAULT_ORIGINS` array. |
| `getMaxAge()` | `function` | Returns the current `Access-Control-Max-Age` value in seconds. |
| `CORS_REJECTION_CODE` | `"CORS_ORIGIN_REJECTED"` | Stable machine-readable code for the blocked-origin error. |
| `CORS_REJECTION_MESSAGE` | `"CORS policy: origin is not allowed."` | Human-readable message included in the 403 response body. |
| `DEV_DEFAULT_ORIGINS` | `string[]` | The five localhost/loopback origins allowed in development when no env var is set. |
| `MAX_MAX_AGE` | `86400` | Upper bound for `CORS_MAX_AGE` (24 hours). |
| `MAX_ORIGIN_LENGTH` | `500` | Maximum character length for a single origin entry. Entries that exceed this are rejected. |

---

## See also

- [`src/config/cors.js`](../src/config/cors.js) — implementation
- [`src/app.js`](../src/app.js) — `handleCorsError`, middleware registration order
- [`src/tests/unit/corsValidator.test.js`](../src/tests/unit/corsValidator.test.js) — unit tests for `validateCorsOrigin`
- [`tests/security.middleware.test.js`](../tests/security.middleware.test.js) — integration tests covering CORS policy
- [`docs/configuration.md`](./configuration.md) — full environment variable reference
- [`docs/request-lifecycle-middleware-order.md`](./request-lifecycle-middleware-order.md) — where CORS sits in the middleware stack
