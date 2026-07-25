# CORS Subsystem Operations Runbook

Operator runbook for the LiquiFact backend CORS subsystem: the middleware that
accepts or rejects browser-origin requests before any route logic runs.

> **Scope note.** This runbook covers the browser-origin policy implemented in
> [src/config/cors.js](../src/config/cors.js) and wired into the Express app in
> [src/app.js](../src/app.js). It applies to every browser-facing route mounted
> by the app, including health probes and invoice/escrow endpoints, because the
> CORS middleware runs first.

---

## Architecture Overview

```text
Browser request
  │
  ▼
cors(createCorsOptions())
  ├─ allowed → continue to body parsers and route handlers
  └─ blocked → handleCorsError() → 403 JSON response
```

The implementation is split across two places:

- [src/config/cors.js](../src/config/cors.js) builds the allowlist, normalizes
  origins, validates `CORS_MAX_AGE`, and creates the dedicated rejection error.
- [src/app.js](../src/app.js) registers the middleware first and converts the
  dedicated rejection error into a JSON response with `code: "CORS_ORIGIN_REJECTED"`.

---

## Configuration

All settings are read from the process environment.

| Variable | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | unset | Preferred allowlist of exact browser origins. Comma-separated. |
| `CORS_ORIGINS` | unset | Deprecated alias for `CORS_ALLOWED_ORIGINS`. |
| `CORS_MAX_AGE` | `600` | Preflight cache duration in seconds. |
| `NODE_ENV` | unset | Determines the development fallback behavior when no origin allowlist is set. |

### Effective behavior

1. If `CORS_ALLOWED_ORIGINS` is set and non-empty, it is used.
2. Otherwise `CORS_ORIGINS` is used if it is set and non-empty.
3. Otherwise, in `NODE_ENV=development`, a small hard-coded localhost allowlist
   is used.
4. Otherwise, all browser origins are denied.

### Notes for operators

- Origin matching is exact after normalization. The code lowercases the scheme
  and host and strips a trailing slash before comparison.
- `https://app.example.com` and `https://app.example.com/` are treated as the
  same origin.
- The literal string `null` is always rejected.
- `CORS_MAX_AGE` must be a positive integer. Invalid values or values above
  `86400` fall back to `600` seconds.

---

## Common Failure Modes

### 1. Browser requests are rejected unexpectedly

**Symptom:** the browser sees `403` with the body:

```json
{
  "error": "CORS policy: origin is not allowed.",
  "code": "CORS_ORIGIN_REJECTED"
}
```

**Likely causes:**

- The frontend origin is not listed in `CORS_ALLOWED_ORIGINS` or `CORS_ORIGINS`.
- The frontend is using a different scheme or host than the configured value.
- The request is being sent from `https://app.example.com/` while the config
  contains `https://app.example.com` (the normalization rules treat these as
  equivalent, so this is usually not the issue unless the configured value is
  malformed).
- The deployment is running in production and no allowlist is configured.

**Check:**

1. Confirm the runtime environment value for `CORS_ALLOWED_ORIGINS` or
   `CORS_ORIGINS`.
2. Compare the browser's actual `Origin` header to the configured value.
3. Verify that `CORS_ALLOWED_ORIGINS` is not being overridden by
   `CORS_ORIGINS` in the same process.

### 2. Preflight requests fail or the cache duration looks wrong

**Symptom:** browser preflight requests fail or the `Access-Control-Max-Age`
header is not what was expected.

**Likely causes:**

- `CORS_MAX_AGE` is empty, non-numeric, zero, negative, or above `86400`.
- The service is using the default `600` seconds because the configured value was
  invalid.

**Check:**

1. Inspect the runtime value of `CORS_MAX_AGE`.
2. Ensure it is a positive integer between `1` and `86400`.
3. If the value is invalid, correct it and redeploy or reload the config.

### 3. Requests from sandboxed iframes or non-browser clients behave differently

**Symptom:** a browser-based iframe or a non-browser client behaves differently
from ordinary API calls.

**Likely causes:**

- The request carries the literal `Origin: null` header (common with sandboxed
  iframe contexts).
- The request has no `Origin` header at all (common for curl, Postman, or
  server-to-server calls).

**Behavior:**

- `Origin: null` is always rejected.
- Requests with no `Origin` header are allowed through as non-browser traffic.

### 4. Allowlist changes are not taking effect immediately

**Symptom:** an origin is still blocked after the environment has been updated.

**Likely causes:**

- The app is using the existing in-memory allowlist and the change has not been
  reloaded.
- The change was made in the environment of a different process or a different
  deployment stage.

**Behavior:**

- The code supports runtime reload via `reloadCorsOrigins()`.
- Existing in-flight requests are not affected; only new requests see the updated
  allowlist.

---

## Alerts and Monitoring

There are no dedicated CORS-specific alert rules in the repository at the time of
writing. Operators should monitor the following signals instead:

- A sudden increase in browser-origin rejections that surface as JSON `403`
  responses with `code: "CORS_ORIGIN_REJECTED"`.
- Increases in client-side failures on frontend pages that call the API from a
  browser.
- A mismatch between the configured frontend origin and the actual origin seen by
  the service.

If the team adds alerting later, the best signal remains the combination of the
CORS rejection code and the specific `Origin` header value seen by the request.

---

## Recovery Steps

### Restore access for a frontend origin

1. Confirm the intended frontend origin.
2. Add it to `CORS_ALLOWED_ORIGINS` (preferred) or `CORS_ORIGINS`.
3. Make sure the value is an exact origin, not a full URL path.
4. Redeploy the service or trigger the runtime reload path if the app is wired to
   call `reloadCorsOrigins()`.
5. Re-test the browser request using the same origin value.

### Recover from an invalid `CORS_MAX_AGE` value

1. Set `CORS_MAX_AGE` to a positive integer between `1` and `86400`.
2. Redeploy or reload the config.
3. Re-test a preflight request to confirm the expected `Access-Control-Max-Age`
   value.

### Investigate a production outage caused by a new frontend deployment

1. Check the frontend's runtime origin (for example, `https://app.example.com`
   versus `https://www.app.example.com`).
2. Compare it to the current allowlist.
3. If necessary, update the allowlist and apply the change.
4. Verify that the browser request now reaches the route handlers instead of
   failing in the CORS middleware.

### Temporarily isolate a CORS issue

If the issue is not caused by the allowlist but by the broader request path,
reproduce it with a direct request that includes a known-good origin and compare
it with a blocked request. This helps isolate whether the failure is happening in
CORS or later in the route stack.

---

## Cross-References

- [src/config/cors.js](../src/config/cors.js) — implementation of allowlist
  parsing, normalization, validation, and rejection errors.
- [src/app.js](../src/app.js) — middleware registration order and the JSON
  `403` handler for blocked origins.
- [docs/cors.md](./cors.md) — detailed API contract and request/response
  behavior for CORS.
- [docs/configuration.md](./configuration.md) — environment-variable inventory.
- [docs/request-lifecycle-middleware-order.md](./request-lifecycle-middleware-order.md)
  — where CORS sits in the middleware chain.
