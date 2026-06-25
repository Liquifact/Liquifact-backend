# LiquiFact Backend
//Comment
API gateway and server for LiquiFact, the global invoice liquidity network on Stellar. This repo provides the Express-based REST API for invoice uploads, escrow state, and future Stellar integration.

Part of the LiquiFact stack: frontend (Next.js) | backend (this repo) | contracts (Soroban).

---

## Prerequisites

- Node.js 20+ (LTS recommended)
- npm 9+
- Docker & Docker Compose (for local PostgreSQL)

---

## Setup

1. Clone the repo

   ```bash
   git clone <this-repo-url>
   cd liquifact-backend
   ```

2. Install dependencies

   ```bash
   npm install
   ```

3. Configure environment

   ```bash
   cp .env.example .env
   # Edit .env with your database configuration
   ```

4. Start database services

   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ```

5. Run database migrations

   ```bash
   npm run db:migrate
   ```

---

## Database connection and test isolation

`src/db/knex.js` is the single Knex connection factory. It selects the correct
config block from `knexfile.js` based on `NODE_ENV` and enforces strict isolation:

| NODE_ENV | Config block | Backend |
|----------|-------------|---------|
| `test` | `test` | SQLite `:memory:` — never touches a shared file or network DB |
| `development` | `development` | SQLite `db.sqlite3` (local convenience) |
| `production` | `production` | PostgreSQL — `DATABASE_URL` required |

The factory **throws** on start-up if:
- `NODE_ENV=test` and the `test` block is missing from `knexfile.js`
- `NODE_ENV=production` and `DATABASE_URL` is unset

Pool error events (`createFail`, `acquireFail`, `destroyFail`) are logged via
the application logger rather than surfacing as unhandled promise rejections.

Unit tests mock the DB module via `src/db/__mocks__/knex.js` and never create
a real connection. See [`DB_MIGRATIONS.md`](./DB_MIGRATIONS.md) for full details.

---

## Observability

Optional Sentry error tracking is supported through the `SENTRY_DSN` environment variable. When enabled, the server scrubs sensitive values before sending events, including:

- Invoice payload bodies and invoice-related fields
- Authorization headers and bearer tokens
- API keys and secret values
- Stellar XDR / Stellar-specific payloads

### Health endpoints

| Endpoint | Type | Dependencies checked | Response |
|----------|------|---------------------|----------|
| `GET /health` | Liveness | None (process alive) | 200 `{ status: "ok" }` |
| `GET /healthz` | Liveness | None (Kubernetes convention alias) | 200 `{ status: "ok" }` |
| `GET /ready` | Readiness | Soroban RPC, KYC provider, indexer staleness | 200/503 with per-check detail |
| `GET /readyz` | Readiness | **Critical:** DB (via knex `SELECT 1`), Soroban RPC | 200/503 with per-check detail |

The `/readyz` probe is designed for orchestrated deployments (Kubernetes, Nomad, etc.)
to distinguish "process is alive" from "process is ready to serve traffic".

- Liveness probes (`/health`, `/healthz`) never touch external dependencies.
- Readiness probe (`/readyz`) only checks critical upstream dependencies (DB, Soroban RPC).
- Credentials and internal hostnames are stripped from error responses.

Health state is also surfaced as a Prometheus gauge (`readiness_gauge`).

Environment variables:

- `SENTRY_DSN` — Optional Sentry DSN. Example: `https://<PUBLIC_KEY>@o<ORG_ID>.ingest.sentry.io/<PROJECT_ID>`
- `SENTRY_RELEASE` — Optional release tag. Defaults to package version when available.
- `SENTRY_ENVIRONMENT` — Optional environment tag. Defaults to `NODE_ENV`.

Do not store secrets in source control. Use `.env` locally and deployment secrets in production.

---

## KYC Provider Integration

This backend supports an optional external KYC provider adapter. When `KYC_PROVIDER_URL` and `KYC_PROVIDER_API_KEY` are both configured, the service submits verification requests to the provider and maps provider statuses onto internal `KYC_STATUSES`:

- `pending`
- `verified`
- `rejected`
- `exempted`

Incoming provider status updates are ingested through a signed webhook endpoint:

- `POST /api/kyc/webhook`

The webhook verifies the `X-Signature` HMAC signature using `KYC_PROVIDER_SECRET` before persisting the SME record.

When no provider keys are present, the service gracefully falls back to the in-memory mock provider behavior used for local development and tests.

---

## Stellar Network Configuration

The API enforces a strict matching between `STELLAR_NETWORK` and `SOROBAN_RPC_URL` at boot time. This prevents misconfiguration where a passphrase (network identity) is paired with an incompatible RPC endpoint, which would cause on-chain validation failures.

### Supported networks

| Network | Passphrase | RPC URL |
| --- | --- | --- |
| TESTNET | `Test SDF Network ; September 2015` | `https://soroban-testnet.stellar.org` |
| MAINNET | `Public Global Stellar Network ; September 2014` | `https://soroban.stellar.org` |
| FUTURENET | `Test SDF Future Network ; October 2022` | `https://rpc-futurenet.stellar.org` |

### Configuration

Set both variables in your `.env`:

```bash
STELLAR_NETWORK=TESTNET
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

Do NOT use custom RPC URLs. The validation will reject any deviation from the expected RPC for the selected network.

### Boot-time validation

On startup, `src/index.js` calls `validateStellarConfig()` from `src/config/stellar.js`. If the network/RPC combination is invalid, the server fails to start with a clear error message:

```
Error: Mismatch: STELLAR_NETWORK=TESTNET requires SOROBAN_RPC_URL="https://soroban-testnet.stellar.org", but got "https://custom-rpc.example.com". This combination would cause on-chain validation failures.
```

### Security notes

- The validation is a hard fail - no partial or degraded operation is permitted.
- This ensures the backend never signs transactions with a mismatched network, which could result in fund loss.
- The passphrase is derived from the network constant and is not user-configurable.

---

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Start API with watch mode |
| `npm run dev:ts` | Start API with TS runtime (optional) |
| `npm run start` | Start API |
| `npm run typecheck` | Run TypeScript type checking (no emit) |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run start:dist` | Start compiled output from `dist/` |
| `npm run lint` | Run ESLint on `src/` |
| `npm test` | Run load helper tests and structured error tests |
| `npm run db:migrate` | Run database migrations |
| `npm run db:rollback` | Rollback last migration |
| `npm run db:seed` | Run database seeds |
| `npm run db:migrate:down` | Rollback last migration |
| `npm run db:migrate:create <name>` | Create new migration file |
| `npm run db:migrate:reset` | Reset database (drop & re-run) |
| `npm run test:coverage` | Run helper/API tests with coverage |
| `npm run load:baseline` | Run the core endpoint load baseline suite |

Default port: `3001`.
Escrow Redis cache is optional and disabled by default; set `REDIS_ESCROW_CACHE_ENABLED=true` with `REDIS_URL` to enable it.
`REDIS_ESCROW_CACHE_TTL_SECONDS` is strictly clamped to `5..300`, and `REDIS_ESCROW_LEDGER_GAP_THRESHOLD` controls ledger-gap invalidation.

Incremental TypeScript setup and migration guidance lives in `docs/typescript-plan.md`.

---

## Database Migrations

This project uses **node-pg-migrate** for database schema management with PostgreSQL. The migration system provides:

- SQL-first migration control with rollback support
- Multi-tenant architecture with Row Level Security (RLS)
- Production-safe transaction handling
- Comprehensive audit logging

### Quick Database Setup

```bash
# Start PostgreSQL and Redis
docker-compose -f docker-compose.dev.yml up -d

# Run migrations
npm run db:migrate
```

### Key Features

- **Multi-tenant isolation** with tenant-scoped data
- **Soft deletes** for data recovery
- **Audit trail** for compliance
- **UUID primary keys** for distributed systems
- **JSONB metadata** for schema flexibility

📖 **Full documentation**: See [`DB_MIGRATIONS.md`](./DB_MIGRATIONS.md) for comprehensive migration guide, troubleshooting, and deployment procedures.

---

## API Documentation

The API is documented using OpenAPI 3.0 specification.

- **OpenAPI JSON**: `GET /openapi.json` - Machine-readable API specification
- **Interactive Docs**: `GET /docs` - Swagger UI for exploring and testing the API
- **Correlation Strategy**: See [`docs/invoice-correlation.md`](./docs/invoice-correlation.md) for details on how `invoiceId` correlates with on-chain Stellar and Soroban data.
- **Signing Modes**: See [`docs/ops-signing.md`](./docs/ops-signing.md) for details on the escrow transaction signing modes (delegated, custodial, stubbed).

The documentation covers all public endpoints including health checks, invoice management, escrow operations, and investment opportunities.

- **Marketplace**: `GET /api/marketplace` - Search and sort invoices by yield, maturity, and funded ratio. Supports advanced filtering (`yieldBpsMin`, `maturityDateTo`, `fundedRatioMin`, etc.) and both **cursor-based** and offset pagination.

  **Cursor pagination (recommended)** — stable under inserts/deletes; use the `nextCursor` value from one response as the `cursor` param in the next request. Cursors are opaque and HMAC-signed; any modification returns 400.

  **Offset pagination (legacy)** — use `page` + `limit` as before. `nextCursor` and `hasMore` are also returned so clients can migrate incrementally.

  | Param | Mode | Description |
  |---|---|---|
  | `cursor` | Cursor | Opaque cursor from previous `nextCursor`; invalidates `page` |
  | `limit` | Both | Page size (1–100, default 10) |
  | `page` | Offset | 1-based page number (ignored when `cursor` present) |
  | `sortBy` | Both | `yield_bps` \| `maturity_date` \| `funded_ratio` \| `amount` \| `created_at` |
  | `order` | Both | `asc` \| `desc` (must be consistent across pages in cursor mode) |

**Example — first page (cursor mode):**
```bash
curl -H "Authorization: Bearer <token>" \
     "http://localhost:3001/api/marketplace?sortBy=yield_bps&order=desc&limit=10"
# Response meta: { total, limit, hasMore, nextCursor }
```

**Example — next page:**
```bash
curl -H "Authorization: Bearer <token>" \
     "http://localhost:3001/api/marketplace?sortBy=yield_bps&order=desc&limit=10&cursor=<nextCursor>"
```

**Example — with filters (offset mode):**
```bash
curl -H "Authorization: Bearer <token>" \
     "http://localhost:3001/api/marketplace?yieldBpsMin=500&sortBy=yield_bps&order=desc&page=2&limit=10"
```

---

## Invoice Upload Security

LiquiFact uses tenant-scoped object storage and strict validation controls for invoice uploads.

### Storage Key Scoping

Invoice files are stored using tenant and invoice scoped object keys:

```text
tenants/{tenantId}/invoices/{invoiceId}/{uuid}-{filename}
```

Example:

```text
tenants/tenant-123/invoices/inv-456/550e8400-e29b-41d4-a716-446655440000-invoice.pdf
```

Security benefits:

- Tenant isolation
- Invoice isolation
- UUID-based object naming
- Protection against object enumeration
- Prevention of cross-tenant object access

### Filename Validation

Uploaded filenames are sanitized before storage.

The storage layer:

- Rejects path traversal attempts (`../`)
- Rejects invalid filenames
- Removes null bytes
- Sanitizes special characters
- Truncates excessively long filenames

Examples:

```text
../../etc/passwd        -> rejected
..\..\windows\system32 -> rejected
invoice.pdf            -> accepted
```

### Tenant and Invoice Validation

Tenant IDs and invoice IDs are validated before key generation.

Allowed characters:

```text
a-z
A-Z
0-9
_
-
```

Rejected examples:

```text
../../admin
tenant/admin
inv/123
```

### MIME Type Validation

Supported invoice file types:

- application/pdf
- image/jpeg
- image/png
- image/tiff

Validation occurs during:

- Direct uploads
- Presigned URL generation

Unsupported MIME types are rejected before any storage operation occurs.

### File Size Limits

Invoice uploads are limited by:

```bash
BODY_LIMIT_INVOICE
```

Default:

```text
512 KB
```

Files exceeding the configured limit are rejected.

### Presigned URL Expiry Limits

Upload URLs:

```text
15 minutes
```

Download URLs:

```text
Default: 1 hour
Maximum: 24 hours
```

Requests outside the allowed expiry range are rejected.

### Security Controls

The invoice upload subsystem includes:

- Path traversal protection
- MIME type allow-listing
- File size enforcement
- Tenant isolation
- Invoice isolation
- UUID object naming
- Presigned URL expiry limits
- AWS credential non-disclosure
- Server-side validation before S3 operations
- Prototype pollution prevention — `sanitizeValue` in `src/utils/sanitization.js` recursively strips `__proto__`, `constructor`, and `prototype` keys from every object and array in request body, query, and params before any downstream handler or Knex query sees the data. Depth and string-length caps bound processing cost for adversarially deep payloads.

Core routes currently covered:

- Health: `GET /health`
- API Info: `GET /api`
- Invoices: `GET /api/invoices` (with optional status filter), `GET /api/invoices/:id`, `POST /api/invoices`
- Escrow: `GET /api/escrow/:invoiceId`, `POST /api/escrow`
- Investment: `GET /api/invest/opportunities`
- SME Metrics: `GET /api/sme/metrics`

---

## Project structure

```text
liquifact-backend/
├── src/
│   └── index.js
├── tests/
│   └── load/
│       ├── config.js
│       ├── reporter.js
│       ├── run-baselines.js
│       └── *.test.js
├── .env.example
├── eslint.config.js
└── package.json
```

---

## Escrow integration

For the full end-to-end model (indexer → projection → `GET /api/escrow`, funding via `escrowSubmit`, reconciliation, signing modes, and env contracts), see **[`docs/escrow-integration-overview.md`](./docs/escrow-integration-overview.md)**.

## Escrow Address Mapping

The API supports invoice-to-escrow contract address resolution using environment-based configuration for early phases. This allows mapping invoice IDs to their corresponding Stellar escrow contract addresses without requiring on-chain registry lookups.

### Configuration

Configure escrow mappings using the `ESCROW_ADDR_BY_INVOICE` environment variable:

```bash
ESCROW_ADDR_BY_INVOICE='{"mappings":[{"invoiceId":"inv_demo_001","escrowAddress":"GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM","environment":"development","isActive":true}],"defaultEnvironment":"development","allowlistEnabled":true,"cacheEnabled":true,"cacheTtlSeconds":300}'
```

### Security Features

- **Allowlist Validation**: Only mapped invoices can be resolved
- **Environment Separation**: Different mappings for development, staging, production
- **Address Validation**: Ensures Stellar addresses are properly formatted
- **Caching**: In-memory caching with configurable TTL
- **Input Validation**: Strict validation of invoice IDs and addresses

### Usage Examples

The mapping system is automatically used by escrow endpoints. When resolving `/api/escrow/:invoiceId`, the system:

1. Validates the invoice ID format
2. Checks if the invoice is in the allowlist for the current environment
3. Returns the corresponding Stellar escrow contract address
4. Caches the result for subsequent requests

### Rotation and Multi-Environment Support

For production deployments:

1. **Environment Separation**: Use different mappings per environment
2. **Key Rotation**: Update mappings by modifying the environment variable
3. **Monitoring**: Use health checks to validate mapping configuration
4. **Security**: Only map invoices you own or have explicit permission to map

### Configuration Schema

```json
{
  "mappings": [
    {
      "invoiceId": "inv_123",
      "escrowAddress": "GABC...123",
      "environment": "development",
      "isActive": true
    }
  ],
  "defaultEnvironment": "development",
  "allowlistEnabled": true,
  "cacheEnabled": true,
  "cacheTtlSeconds": 300
}
```

---

## Load baseline suite

The repo includes a focused load baseline suite for representative core endpoint reads:

- `GET /health`
- `GET /api/invoices`
- `GET /api/escrow/:invoiceId`

The suite uses `autocannon` and captures:

- total requests
- throughput in requests per second
- average latency
- p50 latency
- p95 latency
- p99 latency
- error count
- non-2xx count
- timeout count

### Why these endpoints

These are the canonical health, invoices, and escrow endpoints currently exposed by the backend. They provide a low-risk baseline for throughput and latency without introducing destructive writes.

### Safe defaults

The load suite is intentionally safe by default:

- it targets `http://127.0.0.1:3001`
- it blocks remote targets unless `ALLOW_REMOTE_LOAD_BASELINES=true`
- it does not hardcode tokens or credentials
- it uses a placeholder escrow invoice id unless a fixture id is provided

Do not run the suite against production without explicit approval.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOAD_BASE_URL` | `http://127.0.0.1:3001` | Base URL for the load target |
| `ALLOW_REMOTE_LOAD_BASELINES` | `false` | Explicit opt-in for non-local targets |
| `LOAD_DURATION_SECONDS` | `15` | Duration per endpoint scenario |
| `LOAD_CONNECTIONS` | `10` | Concurrent connections per scenario |
| `LOAD_TIMEOUT_SECONDS` | `10` | Request timeout |
| `LOAD_AUTH_TOKEN` | unset | Optional bearer token for protected endpoints |
| `LOAD_ESCROW_INVOICE_ID` | `placeholder-invoice` | Escrow fixture id |
| `LOAD_REPORT_DIR` | `tests/load/reports` | Directory for generated reports |

### How to run

1. Start the API locally:

   ```bash
   npm run dev
   ```

2. In another terminal, run the baseline suite:

   ```bash
   npm run load:baseline
   ```

3. Optional example with custom settings:

   ```bash
   LOAD_DURATION_SECONDS=20 LOAD_CONNECTIONS=25 LOAD_ESCROW_INVOICE_ID=invoice-123 npm run load:baseline
   ```

---

## E2E Testing (API)

The repository includes a reproducible one-command E2E smoke test script that uses Docker Compose to spin up a fully isolated environment including the API, a test Postgres database, and a mocked Soroban RPC server.

### What is tested
- Service health: `/health` (verifies API, DB reachability, and Soroban mock integration).
- Versioned API: `GET /v1/escrow/:invoiceId` (verifies token authentication and Soroban mock state).
- Backward compatibility: `GET /api/escrow/:invoiceId` (verifies deprecation warning headers).

### How to run
Ensure you have Docker and Docker Compose installed.

```bash
npm run e2e:api
```

The script will:
1. Build and start the `api`, `db`, and `mock-soroban` services.
2. Wait for the API to report a healthy status.
3. Run the Jest smoke test suite against the live containers.
4. Clean up (shutdown and remove) the containers and volumes.

### Security and Reliability
- **Isolated Environment**: Uses a dedicated `docker-compose.e2e.yml` and a private network.
- **Mocked Dependencies**: Points `SOROBAN_RPC_URL` to a local mock server to ensure tests are fast, deterministic, and don't require external network access.
- **Fail-Fast Healthchecks**: The API and DB services use Docker healthchecks to ensure dependent services only start when their dependencies are ready.

---

### Reports

Each run generates:

- a JSON artifact
- a Markdown artifact
- a console summary

By default, reports are written to:

```text
tests/load/reports/
```
│   ├── config/
│   │   └── cors.js          # CORS allowlist parsing and policy
│   ├── middleware/
│   │   ├── auth.js          # JWT authentication middleware
│   │   ├── audit.js         # Immutable audit logging for mutations
│   │   ├── deprecation.js   # API deprecation notices
│   │   ├── errorHandler.js  # Centralized error handling
│   │   ├── rateLimit.js     # Rate limiting enforcement
│   │   └── stacks.js        # Composed middleware stacks (authenticatedTenantStack, adminStack)
│   ├── services/
│   │   ├── invoiceService.js # Business logic and pagination
│   │   └── soroban.js        # Contract interaction wrappers
│   ├── utils/
│   │   ├── asyncHandler.js  # Express async error wrapper
│   │   └── retry.js         # Exponential backoff utility
│   ├── app.js               # Express app, middleware, routes
│   └── index.js             # Runtime bootstrap
├── tests/
│   ├── setup.js             # Test configuration
│   ├── helpers/
│   │   └── createTestApp.js # Test app factory
│   ├── unit/
│   │   ├── asyncHandler.test.js
│   │   └── errorHandler.test.js
│   └── app.test.js
├── .env.example             # Env template
├── eslint.config.js
└── package.json
```

---

## Resiliency & Retries

### Security notes

- Remote load targets are blocked by default.
- Secrets and tokens must come from environment variables.
- The suite never prints auth tokens.
- If protected endpoints are added later, use least-privilege non-production credentials.
- The selected baseline endpoints are low-risk reads to avoid destructive behavior.

### Edge cases handled

- missing base URL falls back to a safe local default
- remote targets require explicit opt-in
- invalid concurrency, duration, or timeout values are rejected
- missing auth token is handled gracefully
- missing escrow fixture id falls back to a placeholder
- partial endpoint failures are still captured in the report

### Limitations

- This suite establishes baselines, not maximum capacity.
- Results depend on local machine resources and runtime conditions.
- The invoices and escrow endpoints are currently placeholders, so these baselines should be treated as early reference points rather than production sizing data.

---

## Structured API errors

All API failures now return a consistent structured error payload:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Malformed JSON request body.",
    "correlation_id": "req_f7d1b9f6c0f1459d8b3b7b6a",
    "retryable": false,
    "retry_hint": "Fix the JSON payload and try again."
  }
}
```

### Error fields

- `code`: stable machine-readable error code
- `message`: safe human-readable message
- `correlation_id`: per-request identifier for debugging and support
- `retryable`: whether the caller may safely retry
- `retry_hint`: safe retry guidance

### Current error categories

- `VALIDATION_ERROR`
- `AUTHENTICATION_REQUIRED`
- `FORBIDDEN`
- `NOT_FOUND`
- `UPSTREAM_ERROR`
- `INTERNAL_SERVER_ERROR`

### Correlation IDs

- Every request receives a correlation ID.
- The API returns it in both the response body and the `X-Correlation-Id` header.
- If a client sends `X-Correlation-Id` and it matches the accepted pattern, the value is echoed back.
- Invalid client-supplied IDs are ignored and replaced with a generated ID.

### Structured failure behavior

The centralized mapper covers:

- malformed JSON
- validation failures
- authorization and authentication failures
- not found responses
- upstream connection failures
- unexpected thrown errors
- non-`Error` thrown values

### Security notes

- Internal stack traces and raw exception details are never returned to clients.
- Correlation IDs are sanitized and do not expose internal state.
- Retry hints are generic and do not leak infrastructure details.
- Server-side logs include correlation context without returning sensitive internals in responses.

### Example responses

Validation error:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invoice payload must be a JSON object.",
    "correlation_id": "req_d3b92b4d2d554f33b8d8b089",
    "retryable": false,
    "retry_hint": "Send a valid JSON object in the request body and try again."
  }
}
```

Unexpected error:

```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "An internal server error occurred.",
    "correlation_id": "req_3d5d8c9e4ff34dd9aa73b946",
    "retryable": false,
    "retry_hint": "Do not retry until the issue is resolved or support is contacted."
  }
}
```

---

## Idempotency

The backend supports durable idempotency keys for funding operations to safely retry requests without risking double-funding. 

### Headers and Behavior
- Send an `Idempotency-Key` header with each distinct funding request. The key must be an 8-128 character URL-safe string.
- First use: The backend processes the request and persists the key along with a SHA-256 hash of the payload and the resulting response.
- Identical retries: Resending the same key with the same payload will short-circuit and instantly replay the cached response.
- Conflicting payload: Resending the same key with a different payload body results in a `409 Conflict` containing an RFC 7807 `application/problem+json` error envelope.

### TTL and Purging
- Keys expire after a configurable TTL (default is 24 hours, overridable via `IDEMPOTENCY_KEY_TTL_HOURS`).
- Expired keys are automatically purged to save database space, governed by the `expires_at` index.

---

## Security audit log (Issue #116)

The backend now supports a database-backed append-only audit log for:

- admin actions (for example, KYC state transitions or key-rotation operations)
- webhook dispatch outcomes (success/failure with redacted payload fields)

### Database migrations

Run SQL migrations in order:

- `migrations/202604260001_create_audit_log_events.sql`
- `migrations/202604260002_enforce_audit_log_append_only.sql`

`audit_log_events` is enforced as append-only at the database layer via triggers that reject `UPDATE` and `DELETE`.

### Runtime behavior

- `src/middleware/auditLog.js` attaches `req.audit` helpers:
  - `req.audit.logAdminAction(...)`
  - `req.audit.logWebhookDelivery(...)`
- successful `POST|PUT|PATCH|DELETE` requests under `/api/admin/*` are auto-logged
- sensitive fields are redacted before persistence (`password`, `token`, `secret`, `apiKey`, `privateKey`, etc.)

### Audit trail export

`GET /api/admin/audit/invoices/:invoiceId/export` accepts a `format` query parameter:

| `format` | Behaviour |
| --- | --- |
| `json` (default) | Returns a paginated JSON array. The `limit` query param (default 50, max 500) controls the page size. |
| `csv` | **Streaming**: rows are emitted directly from the database cursor and piped to the HTTP response. The full result set is **never** buffered in memory, making this safe for arbitrarily large audit trails. |

#### CSV streaming pipeline

```
PostgreSQL cursor (Knex .stream())
  → createCsvTransform()   ← object-mode Transform, writes header on first row
  → res (HTTP response)
```

Both ends of the pipeline attach `error` listeners. If the database stream or the transform errors after headers have been flushed, the socket is destroyed cleanly to avoid a hanging client connection.

#### Formula-injection safety

Every CSV field is processed by `escapeCsvField()` in `src/services/auditLogStore.js`:

1. **Leading-character neutralisation** — cells beginning with `=`, `+`, `-`, `@`, TAB, or CR are prefixed with a single quote (`'`). This prevents spreadsheet software (Excel, LibreOffice Calc, Google Sheets) from interpreting the cell as a formula or a DDE command.
2. **RFC 4180 quoting** — fields containing commas, double-quotes, or newlines are wrapped in double-quotes; embedded double-quotes are doubled (`"` → `""`).

#### Tenant isolation

Tenant scoping is enforced **at the database level** using a `whereRaw` filter on the JSONB `metadata` column:

```sql
WHERE metadata->>'tenantId' = ?
```

No cross-tenant row is ever loaded into application memory.

#### Response headers

```
Content-Type: text/csv
Content-Disposition: attachment; filename="audit-<invoiceId>.csv"
```

#### Column order

```
id, timestamp, actor, action, resourceType, resourceId, statusCode, ipAddress, userAgent
```

### Example API usage

Admin action logging:

```bash
curl -X POST http://localhost:3001/api/admin/kyc/cus_42/approve \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "x-admin-action: kyc.approve" \
  -H "x-audit-target-type: kyc_profile" \
  -H "x-audit-target-id: cus_42" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual review","privateKey":"redacted-at-write-time"}'
```

Streaming CSV export:

```bash
curl -H "Authorization: Bearer <admin-jwt>" \
     -H "x-tenant-id: tenant-alpha" \
     "http://localhost:3001/api/admin/audit/invoices/inv-001/export?format=csv" \
     -o audit-inv-001.csv
```

JSON export (paginated):

```bash
curl -H "Authorization: Bearer <admin-jwt>" \
     -H "x-tenant-id: tenant-alpha" \
     "http://localhost:3001/api/admin/audit/invoices/inv-001/export?format=json&limit=100"
```

---


## Load baseline suite

The repo includes a focused load baseline suite for representative core endpoint reads:

- `GET /health`
- `GET /api/invoices`
- `GET /api/escrow/:invoiceId`

The suite uses `autocannon` and captures:

- total requests
- throughput in requests per second
- average latency
- p50 latency
- p95 latency
- p99 latency
- error count
- non-2xx count
- timeout count

### Safe defaults

- targets `http://127.0.0.1:3001`
- blocks remote targets unless `ALLOW_REMOTE_LOAD_BASELINES=true`
- does not hardcode tokens or credentials
- uses a placeholder escrow invoice id unless a fixture id is provided

Do not run the suite against production without explicit approval.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOAD_BASE_URL` | `http://127.0.0.1:3001` | Base URL for the load target |
| `ALLOW_REMOTE_LOAD_BASELINES` | `false` | Explicit opt-in for non-local targets |
| `LOAD_DURATION_SECONDS` | `15` | Duration per endpoint scenario |
| `LOAD_CONNECTIONS` | `10` | Concurrent connections per scenario |
| `LOAD_TIMEOUT_SECONDS` | `10` | Request timeout |
| `LOAD_AUTH_TOKEN` | unset | Optional bearer token for protected endpoints |
| `LOAD_ESCROW_INVOICE_ID` | `placeholder-invoice` | Escrow fixture id |
| `LOAD_REPORT_DIR` | `tests/load/reports` | Directory for generated reports |

### How to run

```bash
npm run dev
npm run load:baseline
```

### Security notes

- Remote load targets are blocked by default.
- Secrets and tokens must come from environment variables.
- The suite never prints auth tokens.
- The selected baseline endpoints are low-risk reads.

---

## Structured API errors

All API failures return a structured error payload:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Malformed JSON request body.",
    "correlation_id": "req_f7d1b9f6c0f1459d8b3b7b6a",
    "retryable": false,
    "retry_hint": "Fix the JSON payload and try again."
  }
}
```

### Current error categories

- `VALIDATION_ERROR`
- `AUTHENTICATION_REQUIRED`
- `INVALID_TOKEN`
- `FORBIDDEN`
- `NOT_FOUND`
- `RATE_LIMITED`
- `UPSTREAM_ERROR`
- `INTERNAL_SERVER_ERROR`

### Security notes

- Internal stack traces and raw exception details are never returned to clients.
- Correlation IDs are sanitized.
- Retry hints are generic and do not leak infrastructure details.

---

## Negative middleware security tests

The repo includes a focused negative security test suite for middleware hardening.

### Scenarios covered

- unauthorized requests with no `Authorization` header
- malformed `Authorization` header formats
- invalid or tampered Bearer tokens
- rate-limited abuse against a representative protected endpoint
- non-leakage checks for error bodies and headers
- public-route behavior when malformed auth headers are present

GitHub Actions runs on push and pull requests to `main`:

- Lint: `npm run lint`
- Build check: `node --check src/index.js`

---

## Contributing

1. Fork the repo and clone your fork.
2. Create a branch from `main`.
3. Run `npm install`.
4. Make focused changes and keep style consistent.
5. Run `npm run lint`, `npm test`, and any relevant local checks.
6. Push your branch and open a pull request.

We welcome docs improvements, bug fixes, and new API endpoints aligned with LiquiFact product goals.

---


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, local checks, testing expectations, CI behavior, and pull request guidance.

---

## Webhooks

LiquiFact delivers signed webhook callbacks to tenant-configured endpoints whenever an invoice transitions between states (e.g. `pending → approved`, `approved → linked_escrow`).

### How it works

1. **State transition** — `invoiceStateMachine.executeTransition` completes successfully.
2. **Job enqueue** — `enqueueWebhookDelivery` looks up the tenant's `webhook_url` / `webhook_secret` from the database and enqueues a `webhook_delivery` job via the shared `BackgroundWorker`.
3. **Signed delivery** — the `webhookDelivery` job handler constructs a deterministically-sorted JSON payload, signs it with HMAC-SHA256 (`v1` scheme), and POSTs it with an `X-Signature` header.
4. **Retry** — transient failures (network errors, HTTP 5xx) are retried with bounded exponential backoff. Non-retriable failures (HTTP 4xx) are not retried.
5. **Dead-letter** — after exhausting all retry attempts the delivery is written to `webhook_dead_letters` and a Prometheus counter is incremented.

### Signature verification

Every webhook request carries an `X-Signature` header in the format:

```
t=<unix_timestamp>,v1=<hmac_sha256_hex>
```

To verify on the receiving end:

1. Extract `t` (timestamp, seconds since epoch) and `v1` (hex signature) from the header.
2. Reject if `|now_ms − t × 1000| > 300000` (5-minute tolerance window).
3. Compute the expected signature:
   ```
   HMAC-SHA256(secret, "<t>.<raw_body>")
   ```
4. Compare using a **constant-time** function (e.g. `crypto.timingSafeEqual`) to prevent timing attacks.
5. Reject if the signatures do not match.

**Example (Node.js receiver):**

```js
const crypto = require('crypto');

function verifyWebhook(secret, rawBody, signatureHeader) {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('='))
  );
  const ts = parseInt(parts.t, 10);
  if (Math.abs(Date.now() - ts * 1000) > 5 * 60 * 1000) {
    return false; // replay / clock-skew rejected
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(parts.v1, 'hex'),
    Buffer.from(expected, 'hex')
  );
}
```

### Payload shape

```jsonc
{
  "event": "invoice.pending_to_approved",
  "invoiceId": "inv_abc123",
  "tenantId": "tenant_xyz",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "transition": {
    "actor": "usr_admin",
    "from": "pending",
    "reason": null,
    "to": "approved",
    "transitionedAt": "2025-01-15T12:00:00.000Z"
  }
}
```

Keys are always sorted alphabetically (deterministic) to simplify signature verification on any platform.

### Environment variables

| Variable              | Default | Description                                    |
|-----------------------|---------|------------------------------------------------|
| `WEBHOOK_MAX_RETRIES` | `3`     | Max retry attempts after the first failure     |
| `WEBHOOK_BASE_DELAY`  | `500`   | Base exponential-backoff delay (ms)            |
| `WEBHOOK_MAX_DELAY`   | `10000` | Maximum backoff delay cap (ms)                 |
| `WEBHOOK_TIMEOUT_MS`  | `5000`  | Per-request HTTP timeout (ms)                  |

### Tenant configuration

Configure per-tenant webhook delivery by storing `webhook_url` and `webhook_secret` in the `tenants.settings` JSONB column:

```sql
UPDATE tenants
SET settings = settings || '{"webhook_url":"https://your.endpoint/cb","webhook_secret":"<strong-random-secret>"}'
WHERE id = 'your-tenant-id';
```

> **Security**: Generate `webhook_secret` with at least 32 bytes of cryptographic randomness (e.g. `openssl rand -hex 32`). Rotate secrets by updating the column — in-flight jobs will fail safe and dead-letter, then delivery resumes automatically on the next enqueue.

### Security notes

- Secrets and full target URLs are **never** logged at `info` level.
- Signature comparison uses `crypto.timingSafeEqual` — no timing side-channels.
- The 5-minute timestamp tolerance prevents replay attacks.
- Webhook delivery failures never affect the outcome of a state transition.
- Dead-lettered deliveries are stored in `webhook_dead_letters` for ops inspection.

---

## License
MIT (see root LiquiFact project for full license).
