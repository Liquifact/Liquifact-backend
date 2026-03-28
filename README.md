# LiquiFact Backend

API gateway and server for LiquiFact — the global invoice liquidity network on Stellar.
This repo provides the Express-based REST API for invoice uploads, escrow state, and (future) Stellar/Horizon integration.

Part of the LiquiFact stack: **frontend (Next.js)** | **backend (this repo)** | **contracts (Soroban)**.

---

## Error Handling (RFC 7807)

This API uses RFC 7807 Problem Details format for error responses.

Example:
{
  "type": "https://example.com/errors/bad-request",
  "title": "Bad Request",
  "status": 400,
  "detail": "Invalid input",
  "instance": "/api/resource"
}

Content-Type: application/problem+json

---

## Prerequisites

- Node.js 20+ (LTS recommended)
- npm 9+

---

## Setup

```bash
# 1. Clone the repo
git clone <this-repo-url>
cd liquifact-backend

# 2. Install dependencies
npm ci

# 3. Configure environment
cp .env.example .env
# Edit .env for CORS, body-size limits, Stellar/Horizon, or DB settings
```

---

## Development

| Command | Description |
|---|---|
| `npm run dev` | Start API with watch mode |
| `npm run start` | Start API (production-style) |
| `npm run lint` | Run ESLint on `src/` |
| `npm run lint:fix` | Auto-fix linting issues |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:coverage` | Run tests with coverage report |

Default port: **3001**. After starting:

- Health: `http://localhost:3001/health`
- API info: `http://localhost:3001/api`
- Invoices: `http://localhost:3001/api/invoices`
  - `GET  /api/invoices` — List active invoices
  - `GET  /api/invoices?includeDeleted=true` — List all invoices
  - `POST /api/invoices` — Create invoice *(512 KB body limit)*
  - `DELETE /api/invoices/:id` — Soft delete invoice
  - `PATCH  /api/invoices/:id/restore` — Restore deleted invoice

---

## Request Body Size Limits

| Command                | Description                             |
|------------------------|-----------------------------------------|
| `npm run dev`          | Start API with watch mode               |
| `npm run start`        | Start API (production-style)            |
| `npm run lint`         | Run ESLint on `src/`                    |
| `npm run lint:fix`     | Auto-fix linting issues                 |
| `npm test`             | Run unit tests                          |
| `npm run test:coverage`| Run tests with coverage report          |

### How it works

The middleware lives in `src/middleware/bodySizeLimits.js` and is composed of three layers:

1. **`jsonBodyLimit(limit?)`** — Wraps `express.json()` with a byte cap. Also guards against
   forged `Content-Length` headers.
2. **`urlencodedBodyLimit(limit?)`** — Same protection for URL-encoded form bodies.
3. **`invoiceBodyLimit(limit?)`** — Stricter variant used on sensitive endpoints
   (`POST /api/invoices`, escrow writes). Defaults to 512 KB.
4. **`payloadTooLargeHandler`** — Error-handling middleware that catches body-parser's
   `entity.too.large` error and converts it into a clean JSON 413 response.

### 413 Response Shape

```json
{
  "error": "Payload Too Large",
  "message": "Request body exceeds the maximum allowed size of 512kb.",
  "limit": "512kb",
  "path": "/api/invoices"
}
```

### Default Limits

| Limit | Default | Env Variable |
|---|---|---|
| Global JSON bodies | `100kb` | `BODY_LIMIT_JSON` |
| URL-encoded bodies | `50kb` | `BODY_LIMIT_URLENCODED` |
| Raw / binary bodies | `1mb` | `BODY_LIMIT_RAW` |
| Invoice upload endpoints | `512kb` | `BODY_LIMIT_INVOICE` |

All limits are configurable via environment variables (see `.env.example`).

### Overriding limits (`.env`)

```dotenv
BODY_LIMIT_JSON=200kb
BODY_LIMIT_INVOICE=256kb
```

### Security assumptions validated

| Assumption | How it is enforced |
|---|---|
| Forged `Content-Length` headers | Secondary guard middleware checks the header value against `parseSize(limit)` before body parsing can complete. |
| Primitive JSON root values (`"string"`, `42`) | `express.json` runs in `strict: true` mode — only objects and arrays are accepted. |
| Misconfigured limit strings | `parseSize()` throws `TypeError` / `RangeError` at startup, preventing silent misconfigurations. |
| Unbounded retries on upstream calls | Separate `src/utils/retry.js` hard-caps retries at 10 and delay at 60 s. |

---

## Code Quality & Testing

### ESLint

We enforce strict linting rules using `eslint:recommended`.
All code must include JSDoc comments for maintainability.

```bash
npm run lint       # check
npm run lint:fix   # auto-fix
```

### Testing
We use **Jest** and **Supertest** for testing.
- Run tests: `npm test`
- Check coverage: `npm run test:coverage`

```bash
npm test                # run all tests
npm run test:coverage   # run with coverage report
```

Coverage target: **≥ 95% lines and statements**.

Test suite covers:

- `parseSize()` — 11 happy-path cases, 6 TypeError cases, 3 RangeError cases
- `DEFAULT_LIMITS` — all four keys are parseable and non-zero
- `jsonBodyLimit()` — pass/fail/413-shape/malformed/strict-mode/Content-Length guard
- `urlencodedBodyLimit()` — pass/fail/413-shape/Content-Length guard
- `invoiceBodyLimit()` — default limit, custom limit, response shape
- `payloadTooLargeHandler()` — converts `entity.too.large`, passes through other errors
- **Full app integration** — health, api-info, GET/POST invoices, oversized 413 end-to-end

---

## Authentication

Protected endpoints (invoice mutations, escrow operations) require a JWT in the `Authorization` header:

```
Authorization: Bearer <jwt_token_here>
```

The middleware validates the token against `JWT_SECRET` (defaults to `test-secret` locally).
Unauthenticated requests are rejected with `401 Unauthorized`.

---

## Rate Limiting

| Scope | Limit |
|---|---|
| Global (per IP / User ID) | 100 requests / 15 minutes |
| Sensitive operations (invoice upload, escrow writes) | 10 requests / hour per IP |

Clients exceeding limits receive `429 Too Many Requests`.
Check the standard `RateLimit-*` headers for quota and reset time.

---

## Tenant-Aware Data Isolation
- **Overview**
Every /api/* route enforces tenant-scoped isolation. A caller's tenant identity is resolved once per request by the middleware chain and then applied to every read and write operation. No route handler ever accepts a tenant ID from the request body — the tenant is always derived from the verified middleware context.


- **Middleware chain**
All protected routes use this stack:
[globalLimiter] → [authenticateToken] → [extractTenant] → route handler

| Step                  | Responsibility                                   |
|-----------------------|--------------------------------------------------|
| `globalLimiter`       | Rate limiting (existing)                         |
| `authenticateToken`   | Validates JWT, attaches req.user                 |
| `extractTenant`       | Resolves req.tenantId from header or JWT claim   |


- **Tenant ID resolution**
extractTenant resolves the tenant in priority order:

x-tenant-id request header — for service-to-service / API-key flows
req.user.tenantId JWT claim — set by authenticateToken

If neither yields a valid identifier, the request is rejected immediately with 400 Bad Request. The server never falls back to a default tenant.


- **Data isolation guarantee**
Invoices are stored in a nested Map<tenantId, Map<invoiceId, Invoice>>. Every repository function requires tenantId as its first argument and queries only that tenant's bucket:
Tenant A's data  →  { inv_001, inv_002 }
Tenant B's data  →  { inv_003, inv_004 }
A caller from Tenant B holding a valid invoice ID from Tenant A will always receive 404 Not Found — the invoice is simply invisible outside its owning tenant's scope.

- **Escrow validation**
Before forwarding to the Soroban contract, the escrow endpoint verifies the invoiceId exists in the requesting tenant's scope. A cross-tenant guess returns 404 without making any contract call.

- **API Reference**:
| Method          | Path                                | Auth/Tenat  | Decription                  |
|-----------------|-------------------------------------|-------------|-----------------------------|
| `GET`           | `health`                            | None        | Health check                |
| `GET`           | `api`                               | None        | Endpoint listing            |
| `GET`           | `api/invoices`                      | Yes         | List tenant invoices        |
| `POST`          | `api/invoices`                      | Yes         | Create tenant invoice       |
| `DELETE`        | `/api/invoices/:id`                 | Yes         | Soft delete invoice         |
| `PATCH`         | `/api/invoices/:id/restore`         | Yes         | Restore Soft deleted invoice|
| `GET`           | `/api/escrow/:invoiceId`            | Yes         | Read escrow data            |

- **Response Headers**:
| Header          | Required On                         |  Decription       |
|-----------------|-------------------------------------|-------------------|
| `x-tenant-id`   | All routes                          | Tenant identifier | 


- **Security Notes**:
Teant id is never read from `req.body`

## Configuration

### CORS Allowlist

```dotenv
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

Behavior:
- Requests without an `Origin` header are allowed, as it can be curl, postman, etc.
- Requests from allowed origins receive normal CORS headers.
- Requests from disallowed origins are rejected with `403 Forbidden`.
- Origin matching is exact only. Wildcards and regex patterns are not supported.

**Development default:** If `NODE_ENV=development` and `CORS_ALLOWED_ORIGINS` is unset,
common local origins are allowed automatically.

**Production default:** If `CORS_ALLOWED_ORIGINS` is unset outside development,
all browser origins are denied.

---

## API Response Structure

All endpoints return a standardized JSON envelope:

```json
{
  "data": { ... },
  "meta": {
    "timestamp": "2026-03-24T09:55:00.000Z",
    "version": "0.1.0"
  },
  "error": null
}
```

In case of an error:

```json
{
  "data": null,
  "meta": { ... },
  "error": {
    "message": "Human readable message",
    "code": "ERROR_CODE",
    "details": { ... }
  }
}
```

---

## Project structure

```
liquifact-backend/
├── src/
│   ├── app.js               # Express application setup
│   ├── index.js             # Server entry point
│   ├── utils/
│   │   └── responseHelper.js # Standardized response logic
│   └── tests/
│       └── response.test.js # Coverage-backed integration tests
├── .env.example
│   │   └── cors.js     # CORS allowlist parsing and policy
│   │   └── cors.js       # CORS allowlist parsing and policy
│   ├── middleware/
│   │   └── security.js   # Helmet security header configuration
│   ├── services/
│   │   └── soroban.js    # Contract interaction wrappers
│   ├── utils/
│   │   ├── asyncHandler.js # Async route wrapper
│   │   ├── queryBuilder.js # Reusable DB query builder
│   │   ├── retry.js    # Exponential backoff utility
│   │   └── validators.js # Input validation utilities
│   ├── app.js          # Express app, middleware, routes
│   └── index.js        # Runtime bootstrap
├── .env.example        # Env template
│   │   └── retry.js      # Exponential backoff utility
│   ├── index.js          # Express app, routes, error handler (importable for tests)
│   ├── index.test.js     # Integration + security header tests (Jest + supertest)
│   └── server.js         # Server entry point — binds app to PORT
├── .env.example          # Env template (PORT, Stellar, DB placeholders)
├── eslint.config.js
├── vitest.config.js
└── package.json
```

---

## Security

HTTP response headers are hardened via [Helmet](https://helmetjs.github.io/) (`src/middleware/security.js`). Applied headers include:

| Header | Value / Policy |
|--------|----------------|
| `Content-Security-Policy` | Restricts all resource loading to `'self'`; blocks objects and frames |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `X-Frame-Options` | `DENY` — prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` — disables MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |
| `X-DNS-Prefetch-Control` | `off` |
| `X-Permitted-Cross-Domain-Policies` | `none` |
| `X-Powered-By` | Removed (technology fingerprinting prevention) |

---

## Resiliency & Retries

To ensure reliable communication with Soroban contract provider APIs, this backend implements a robust **Retry and Backoff** mechanism (`src/utils/retry.js`).

- **Automatic retries** for HTTP 429, 502, 503, 504, and network timeouts.
- **Jitter** (±20%) prevents thundering-herd problems.
- **Hard caps:** `maxRetries ≤ 10`, `maxDelay ≤ 60 000 ms`, `baseDelay ≤ 10 000 ms`.

---

## Invoice Filtering & Sorting

Endpoint: GET /invoices

Query Parameters:
- status: paid | pending | overdue
- sme: SME ID
- buyer: Buyer ID
- dateFrom: ISO date
- dateTo: ISO date
- sortBy: amount | date
- order: asc | desc

Example:
GET /invoices?status=paid&sortBy=amount&order=desc

---

## CI/CD

GitHub Actions runs on every push and pull request to `main`:

- **Lint** — `npm run lint`
- **Tests** — `npm run test:coverage`
- **Build check** — `node --check src/index.js` (syntax)

Ensure your branch passes all checks before opening a PR.

---

## Contributing

```bash
# 1. Fork and clone
git clone <your-fork-url>
cd liquifact-backend

# 2. Create a feature branch
git checkout -b feature/your-feature   # or fix/your-fix

# 3. Install and configure
npm ci
cp .env.example .env

# 4. Make changes, keeping style consistent
npm run lint:fix
npm test

# 5. Commit with a clear message
git commit -m "feat: add X"   # or "fix: Y"

# 6. Push and open a Pull Request to main
git push origin feature/your-feature
```

We welcome docs improvements, bug fixes, and new API endpoints aligned with the LiquiFact product.

---

## License

MIT (see root LiquiFact project for full license).