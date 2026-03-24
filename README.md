# LiquiFact Backend

API gateway and server for LiquiFact, the global invoice liquidity network on Stellar. This repo provides the Express-based REST API for invoice uploads, escrow state, and future Stellar integration.

Part of the LiquiFact stack: frontend (Next.js) | backend (this repo) | contracts (Soroban).

---

## Prerequisites

- Node.js 20+ (LTS recommended)
- npm 9+

---

## Setup

1. Clone the repo

   ```bash
   git clone <this-repo-url>
   cd liquifact-backend
   ```

2. Install dependencies

   ```bash
   npm ci
   ```

3. Configure environment if needed

   ```bash
   cp .env.example .env
   ```

---

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Start API with watch mode |
| `npm run start` | Start API |
| `npm run lint` | Run ESLint on `src/` |
| `npm test` | Run retry tests, load helper tests, structured error tests, and middleware security-negative tests |
| `npm run test:coverage` | Run helper/API tests with coverage |
| `npm run load:baseline` | Run the core endpoint load baseline suite |

Default port: `3001`.

Core routes currently covered:

- Health: `GET /health`
- Invoices: `GET /api/invoices`
- Escrow: `GET /api/escrow/:invoiceId`

---

## Project structure

```text
liquifact-backend/
|-- src/
|   |-- errors/
|   |-- middleware/
|   |-- services/
|   |-- utils/
|   `-- index.js
|-- tests/
|   `-- load/
|-- .env.example
|-- eslint.config.js
`-- package.json
```

---

## Resiliency & Retries

To ensure reliable communication with Soroban contract provider APIs, this backend implements a retry and backoff mechanism in [src/utils/retry.js](C:/Users/YOGA%207/Desktop/web3/opensource/Liquifact-backend/src/utils/retry.js).

### Key features

- Exponential backoff through `withRetry`
- Jitter of plus or minus 20 percent to reduce synchronized retries
- Security caps:
- `maxRetries` is capped at 10
- `maxDelay` is capped at 60,000 ms
- `baseDelay` is capped at 10,000 ms
- Contract integration through [src/services/soroban.js](C:/Users/YOGA%207/Desktop/web3/opensource/Liquifact-backend/src/services/soroban.js)

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

### How to run

```bash
npm test
npm run test:coverage
```

### Security assumptions

- the negative tests use a non-production test token and do not rely on external services
- the protected middleware path uses strict Bearer parsing and constant-time token comparison
- the rate limiter is an in-memory deterministic store used for local and CI-safe abuse-path testing
- the test harness routes are enabled only in test mode via `createApp({ enableTestRoutes: true })`

### Limitations

- the current auth model is a minimal Bearer-token gate for representative middleware testing, not a full JWT or session system
- the in-memory limiter validates rejection behavior and header semantics, but it is not a distributed production rate-limit backend

---

## CI/CD

GitHub Actions runs on push and pull requests to `main`:

- Lint: `npm run lint`
- Build check: `node --check src/index.js`

---

## Contributing

1. Fork the repo and clone your fork.
2. Create a branch from `main`.
3. Run `npm ci`.
4. Make focused changes and keep style consistent.
5. Run `npm run lint`, `npm test`, and any relevant local checks.
6. Push your branch and open a pull request.

---

## License

MIT (see root LiquiFact project for full license).
