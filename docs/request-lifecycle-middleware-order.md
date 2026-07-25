# Request lifecycle and middleware order

This document describes how incoming HTTP requests flow through the LiquiFact
Express application and the intended order of global middleware and feature-router
mounts in [`src/app.js`](../src/app.js).

## Global middleware (every request)

Applied in this order before any route handler runs:

| Step | Middleware | Purpose |
|------|------------|---------|
| 1 | CORS (`createCorsOptions`) | Environment-driven origin allowlist |
| 1.a | Raw body parser (`/api/kyc/webhook` only) | Provider webhook signature verification |
| 2 | JSON body limit | Global JSON payload guardrail (100 KB) |
| 3 | URL-encoded body limit | Form payloads (50 KB) |
| 4 | Security headers (`createSecurityMiddleware`) | Helmet-style hardening |
| 5 | Audit middleware | Structured request audit trail |
| 6 | Request ID | Resolves the canonical request identifier from `X-Request-Id`, `request-id`, or `X-Correlation-Id`, then attaches it to both `req.id` and `req.correlationId` for logging |
| 7 | Correlation ID | Echoes the canonical identifier in `X-Correlation-Id` and refreshes the request-scoped logger bindings |

## Request identifier header contract

The identifier pipeline accepts a client-supplied request or correlation header only when it is 8 to 64 characters long and contains only the safe characters `[A-Za-z0-9_-]`. Values with dots, control characters, newlines, whitespace, or other disallowed bytes are rejected. `X-Request-Id` and `request-id` take precedence over `X-Correlation-Id` when multiple valid headers are present. The sanitized value is attached to both `req.id` and `req.correlationId`, propagated into child loggers as `requestId` and `correlationId`, and echoed in `X-Request-Id` and `X-Correlation-Id`. If no inbound identifier is trusted, the server generates a full-strength `req_` identifier from UUID entropy.

## Body Size Limits

The JSON, URL-encoded, and invoice body guards reject requests early when a
trustworthy `Content-Length` declares a body larger than the configured limit.
Requests without a valid `Content-Length`, including `Transfer-Encoding:
chunked`, are not treated as zero-byte bodies. They continue into the Express
body parser, which enforces the same byte cap without buffering beyond its
configured limit. Parser-raised 413 responses reuse the guard's stored limit
context so `bodySizeLimitRejectionsTotal` keeps the correct `json`,
`urlencoded`, or `invoice` label.

## Inline routes (defined on `app` directly)

Health probes (`/health`, `/healthz`, `/ready`, `/readyz`), API info (`/api`),
invoice list/create, escrow read, and debug error routes are registered on the
app instance before feature routers mount.

## Composed auth and tenant stacks

Protected routers that need both authentication and tenant context mount the
composed middleware stacks from [`src/middleware/stacks.js`](../src/middleware/stacks.js).
These stacks preserve a strict ordering contract:

- `authenticatedTenantStack` executes `authenticateToken` first and `extractTenant`
  second. Tenant extraction must never run when JWT authentication fails.
- `adminStack` executes `adminAuth` first and `extractTenant` second. `adminAuth`
  selects the API-key branch only when the `x-api-key` header is present.
  Empty strings and array-valued headers are treated as non-branching values so
  the request falls back to JWT authentication.

The repository includes an integration-style regression suite in
[`tests/stacks.ordering.test.js`](../tests/stacks.ordering.test.js) that mounts
both stacks on a throwaway Express app and exercises the middleware chain with
Supertest to guard this ordering contract.

## Feature router mounts (single mount per router instance)

Each feature router is imported once and mounted once via
`mountFeatureRouter` from [`src/utils/routeMountRegistry.js`](../src/utils/routeMountRegistry.js).
A startup assertion (`assertNoDuplicateRouterMounts`) fails fast if the same
router instance is mounted twice at the same base path.

Mount order (preserved intentionally):

| Order | Base path | Router module | Notes |
|-------|-----------|---------------|-------|
| 1 | `/api/sme` | `routes/sme` | SME metrics and uploads |
| 2 | `/api/invoices` | `routes/invoiceFile` | File upload handlers |
| 3 | `/api/invoices` | `routes/invoiceStateRoutes` | State machine (second router, different instance) |
| 4 | `/api/invest` | `routes/invest` | Funding opportunities and fund-invoice |
| 5 | `/api/investor` | `routes/investor` | **Single mount** — investor lock list/detail |
| 6 | `/api/kyc` | `routes/kyc` | KYC verification |
| 7 | `/api/marketplace` | `routes/marketplace` | Investable invoice marketplace |
| 8 | `/api/retention` | `routes/retention` | Data retention policies |
| 9 | `/api/admin/audit` | `routes/auditTrail` | Admin audit trail |
| 10 | `/api/admin/escrow` | `routes/adminEscrow` | Admin escrow tooling |
| 11 | `/api/admin/reconciliation` | `routes/reconciliation` | Reconciliation runs |
| 12 | `/v1` | `routes/v1` | Versioned API surface |

> **Investor routes:** `/api/investor` is mounted exactly once. The investor
> router applies `authenticateToken` then `extractTenant` on each handler, so
> auth and tenant context are enforced before lock list or detail logic runs.

## Post-route middleware

| Step | Handler | Purpose |
|------|---------|---------|
| Metrics | `GET /metrics` | Prometheus scrape (auth-gated) |
| 404 | Catch-all | Unknown paths |
| Error | CORS → payload-too-large → internal | Ordered error normalization |

## Standardized response envelope

Production entry points use `createStandardizedApp()`, which wraps `createApp()`
and normalizes JSON responses through `toStandardEnvelope`. Route order inside
`createApp()` is unchanged; only the outer response wrapper is added.
