# LiquiFact Backend

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

## Observability

Optional Sentry error tracking is supported through the `SENTRY_DSN` environment variable. When enabled, the server scrubs sensitive values before sending events, including:

- Invoice payload bodies and invoice-related fields
- Authorization headers and bearer tokens
- API keys and secret values
- Stellar XDR / Stellar-specific payloads

Environment variables:

- `SENTRY_DSN` — Optional Sentry DSN. Example: `https://<PUBLIC_KEY>@o<ORG_ID>.ingest.sentry.io/<PROJECT_ID>`
- `SENTRY_RELEASE` — Optional release tag. Defaults to package version when available.
- `SENTRY_ENVIRONMENT` — Optional environment tag. Defaults to `NODE_ENV`.

Do not store secrets in source control. Use `.env` locally and deployment secrets in production.

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

The documentation covers all public endpoints including health checks, invoice management, escrow operations, and investment opportunities.

---

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
│   │   └── rateLimit.js     # Rate limiting enforcement
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

### Example API usage

Admin action example:

```bash
curl -X POST http://localhost:3001/api/admin/kyc/cus_42/approve \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "x-admin-action: kyc.approve" \
  -H "x-audit-target-type: kyc_profile" \
  -H "x-audit-target-id: cus_42" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual review","privateKey":"redacted-at-write-time"}'
```

Webhook delivery logging is typically called internally from delivery workers/routes via `req.audit.logWebhookDelivery(...)`.

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

## License

MIT (see root LiquiFact project for full license).
