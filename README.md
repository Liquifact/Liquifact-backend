# LiquiFact Backend

API gateway and server for **LiquiFact** — the global invoice liquidity network on Stellar. This repo provides the Express-based REST API for invoice uploads, escrow state, and (future) Stellar/Horizon integration.

Part of the LiquiFact stack: **frontend** (Next.js) | **backend** (this repo) | **contracts** (Soroban).

---

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** 9+

---

## Setup

1. **Clone the repo**

   ```bash
   git clone <this-repo-url>
   cd liquifact-backend
   ```

2. **Install dependencies**

   ```bash
   npm ci
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env for CORS, Stellar/Horizon, or future DB settings
   ```

---

## Development

| Command               | Description                             |
|-----------------------|-----------------------------------------|
| `npm run dev`         | Start API with watch mode               |
| `npm run start`       | Start API (production-style)           |
| `npm run lint`        | Run ESLint on `src/`                   |
| `npm run lint:fix`    | Auto-fix linting issues                |
| `npm test`            | Run unit tests (Vitest)                |
| `npm run test:coverage`| Run tests with coverage report         |

Default port: **3001**. After starting:

- Health: [http://localhost:3001/health](http://localhost:3001/health)
- API info: [http://localhost:3001/api](http://localhost:3001/api)
- Invoices: [http://localhost:3001/api/invoices](http://localhost:3001/api/invoices)
  - `GET /api/invoices` - List active invoices
  - `GET /api/invoices?includeDeleted=true` - List all invoices
  - `POST /api/invoices` - Create invoice
  - `DELETE /api/invoices/:id` - Soft delete invoice
  - `PATCH /api/invoices/:id/restore` - Restore deleted invoice

---

## Code Quality & Testing

### ESLint Rule Hardening
We enforce strict linting rules using `eslint:recommended` and `eslint-plugin-security`. All code must include JSDoc comments for better maintainability.

- **Local Workflow**: Before committing, run `npm run lint:fix` to automatically address style issues.
- **CI Enforcement**: The CI pipeline will fail if linting errors are present or if test coverage falls below **95%**.

### Testing
We use **Vitest** and **Supertest** for testing.
- Run tests: `npm test`
- Check coverage: `npm run test:coverage`

Current coverage targets: **>95% Lines and Statements**.

---

## Authentication

Protected endpoints (such as invoice mutations and escrow operations) require a JSON Web Token (JWT) in the `Authorization` header:

```http
Authorization: Bearer <jwt_token_here>
```

The middleware authenticates the token against the `JWT_SECRET` environment variable (defaults to `test-secret` for local development). Unauthenticated requests will be rejected with a `401 Unauthorized` status.

---

## Rate Limiting

The API implements request throttling to prevent abuse:

- **Global Limit**: 100 requests per 15 minutes per IP or User ID.
- **Sensitive Operations**: (Invoice uploads, Escrow writes) 10 requests per hour per IP.

Clients exceeding these limits will receive a `429 Too Many Requests` response. Check the standard `RateLimit-*` headers for your current quota and reset time.

---

## Configuration

### CORS Allowlist

The API enforces an environment-driven CORS allowlist for browser-originated requests.

- `CORS_ALLOWED_ORIGINS`: Comma-separated list of trusted frontend origins.
- Example:
  `CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com`

Behavior:
- Requests without an `Origin` header are allowed, as it can be curl, postman, etc. 
- Requests from allowed origins receive normal CORS headers.
- Requests from disallowed origins are rejected with `403 Forbidden`.
- Origin matching is exact only. Wildcards and regex patterns are not supported.

Development default:
- If `NODE_ENV=development` and `CORS_ALLOWED_ORIGINS` is not set, common local development origins are allowed by default.

Production default:
- If `CORS_ALLOWED_ORIGINS` is not set outside development, browser origins are denied by default.

---

## Project structure

```
liquifact-backend/
├── src/
│   ├── config/
│   │   └── cors.js     # CORS allowlist parsing and policy
│   ├── services/
│   │   └── soroban.js  # Contract interaction wrappers
│   ├── utils/
│   │   └── retry.js    # Exponential backoff utility
│   ├── app.js          # Express app, middleware, routes
│   └── index.js        # Runtime bootstrap
├── .env.example        # Env template
├── eslint.config.js
└── package.json
```

---

## Resiliency & Retries

To ensure reliable communication with Soroban contract provider APIs, this backend implements a robust **Retry and Backoff** mechanism (`src/utils/retry.js`). 

### Key Features
- **Exponential Backoff (`withRetry`)**: Automatically retries transient errors (e.g., HTTP 429, 502, 503, 504, network timeouts).
- **Jitter**: Adds ±20% randomness to the delay to prevent thundering herd problems.
- **Security Caps**:
  - `maxRetries` is hard-capped at 10 to prevent unbounded retry loops.
  - `maxDelay` is hard-capped to 60,000ms (1 minute).
  - `baseDelay` is hard-capped to 10,000ms.
- **Contract Integration**: `src/services/soroban.js` wraps raw API calls securely with this utility, ensuring all escrow and invoice state interactions are fault-tolerant.

---

## Logging & Request Correlation

To simplify debugging and tracing requests across services, the API implements **Request Correlation IDs**.

### Key Features
- **RequestId Middleware (`src/middleware/requestId.js`)**: Automatically generates a unique UUID (v4) for every incoming request if the `X-Request-Id` header is missing.
- **Propagation**: The ID is returned in the `X-Request-Id` response header and propagated through all logs associated with that request.
- **Async Context Logging (`src/utils/logger.js`)**: Uses Node.js `AsyncLocalStorage` to automatically inject the current correlation ID into every log message without needing to pass it manually through function arguments.
- **JSON Structured Logs**: All logs are output in structured JSON format, including `timestamp`, `level`, `requestId`, and `message`, making them easily searchable in centralized logging systems (e.g., ELK, CloudWatch, Datadog).

Example log format:
```json
{"level":"info","timestamp":"2026-03-25T23:00:00.000Z","requestId":"550e8400-e29b-41d4-a716-446655440000","message":"Invoice uploaded successfully."}
```

## CI/CD

GitHub Actions runs on every push and pull request to `main`:

- **Lint** — `npm run lint`
- **Tests** — `npm test`
- **Build check** — `node --check src/index.js` (syntax)

Ensure your branch passes these before opening a PR.

---

## Contributing

1. **Fork** the repo and clone your fork.
2. **Create a branch** from `main`: `git checkout -b feature/your-feature` or `fix/your-fix`.
3. **Setup locally**: `npm ci`, optionally `cp .env.example .env`.
4. **Make changes**. Keep the style consistent:
   - Run `npm run lint` and fix any issues.
   - Use the existing Express/route patterns in `src/index.js`.
5. **Commit** with clear messages (e.g. `feat: add X`, `fix: Y`).
6. **Push** to your fork and open a **Pull Request** to `main`.
7. Wait for CI to pass and address any review feedback.

We welcome docs improvements, bug fixes, and new API endpoints aligned with the LiquiFact product (invoices, escrow, Stellar integration).

---

## License

MIT (see root LiquiFact project for full license).
