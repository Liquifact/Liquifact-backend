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

3. **Configure environment** (optional for local dev)

   ```bash
   cp .env.example .env
   # Edit .env if you need Stellar/Horizon/DB settings
   ```

---

## Environment Configuration

All environment variables are **validated at startup**. The application will fail immediately with actionable error messages if required or invalid variables are detected.

### Validation Behavior

- **Required Variables**: None are strictly required; all have secure defaults.
- **Fast Failure**: Invalid configurations are caught at startup before the server starts.
- **Security**: Sensitive values (database URLs, credentials) are **never logged** in error messages.
- **Type Safety**: Environment variables are coerced to correct types (number, boolean, URL) and validated.

### Environment Variables

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `PORT` | number | No | `3001` | HTTP server port (1-65535) |
| `NODE_ENV` | string | No | `development` | Runtime environment (development, production, test) |
| `STELLAR_NETWORK` | string | No | `testnet` | Stellar network (testnet, public) |
| `HORIZON_URL` | url | No | `https://horizon-testnet.stellar.org` | Horizon API base URL |
| `SOROBAN_RPC_URL` | url | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint URL |
| `DATABASE_URL` | url | No | null | PostgreSQL database connection URL (optional) |
| `REDIS_URL` | url | No | null | Redis cache connection URL (optional) |

### Configuration Examples

**Development (local)**
```bash
PORT=3001
NODE_ENV=development
STELLAR_NETWORK=testnet
HORIZON_URL=http://localhost:11626
SOROBAN_RPC_URL=http://localhost:8000
```

**Production**
```bash
PORT=8080
NODE_ENV=production
STELLAR_NETWORK=public
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://soroban.stellar.org
DATABASE_URL=postgresql://user:pass@db.example.com:5432/liquifact
REDIS_URL=redis://:password@redis.example.com:6379
```

### Validation Rules

| Variable | Rules |
|----------|-------|
| `PORT` | Must be an integer between 1 and 65535 |
| `NODE_ENV` | Must be one of: `development`, `production`, `test` |
| `STELLAR_NETWORK` | Must be one of: `testnet`, `public` |
| `HORIZON_URL` | Must be a valid HTTP/HTTPS URL |
| `SOROBAN_RPC_URL` | Must be a valid HTTP/HTTPS URL |
| `DATABASE_URL` | Must be a valid database URL (postgresql, mysql, mongodb) |
| `REDIS_URL` | Must be a valid Redis URL |

### Error Examples

If configuration is invalid, the service will fail at startup with actionable messages:

```
Environment validation failed:
  • Invalid type for PORT: Cannot convert to number: "abc"
  • STELLAR_NETWORK must be one of: testnet, public
  • HORIZON_URL must be a valid URL

Please check your environment configuration.
```

No sensitive values (passwords, URLs) are shown in error messages for security.

---

## Development

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Start API with watch mode      |
| `npm run start`| Start API (production-style)  |
| `npm run lint` | Run ESLint on `src/`          |
| `npm test`     | Run Jest tests with coverage   |

Default port: **3001**. After starting:

- Health: [http://localhost:3001/health](http://localhost:3001/health)
- API info: [http://localhost:3001/api](http://localhost:3001/api)

---

## Project structure

```
liquifact-backend/
├── src/
│   ├── config/
│   │   ├── env.js      # Environment validation schema and loader
│   │   └── env.test.js # Comprehensive env validation tests
│   ├── services/
│   │   └── soroban.js  # Contract interaction wrappers
│   ├── utils/
│   │   └── retry.js    # Exponential backoff utility
│   └── index.js        # Express app, routes, startup validation
├── .env.example        # Env template
├── eslint.config.js
└── package.json
```

---

## Testing

This project maintains **95%+ test coverage** using Jest.

### Running Tests

```bash
# Run all tests with coverage report
npm test

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- src/config/env.test.js
```

### Test Coverage

The test suite includes:

- **Configuration Validation** (`src/config/env.test.js`)
  - Valid configurations (minimal, full, production, development)
  - Type coercion and validation
  - Port range validation (1-65535)
  - Environment name validation
  - Stellar network validation
  - URL format and protocol validation
  - Database URL validation (PostgreSQL, MySQL, MongoDB)
  - Redis URL validation
  - Error messages and security
  - Edge cases (empty strings, whitespace, special characters)
  - Missing and invalid variables
  - Multiple validation errors

- **Retry Utility** (`src/utils/retry.test.js`)
  - Success on first try
  - Retry on transient failures
  - Failure after retries exhausted
  - Security caps validation
  - Jitter and backoff calculations

### Security Notes

**Environment Validation Security**:

1. **Secure Defaults**: All variables either have safe defaults or are optional.
2. **No Credential Logging**: Database URLs, Redis URLs, and API keys are NEVER logged in error messages.
3. **Type Safety**: Values are coerced and validated to prevent injection attacks.
4. **Scope Isolation**: Environment variables are validated in isolation with no cross-script dependencies.
5. **Stderr Output**: Validation errors are sent to stderr, not stdout, preventing accidental logging to access logs.
6. **Fast Failure**: Invalid configurations are caught at startup, preventing degraded operation.
7. **Bounded Retries**: The retry utility has hard-capped retry counts and delays to prevent resource exhaustion.

**Best Practices**:

- Use strong, unique passwords in database/cache URLs.
- Rotate credentials regularly.
- Never commit `.env` files to version control.
- Use a secrets manager (AWS Secrets Manager, HashiCorp Vault) in production.
- Log validation errors to a secure audit trail, not to standard logs.

---

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

## CI/CD

GitHub Actions runs on every push and pull request to `main`:

- **Lint** — `npm run lint`
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
   - Add or update tests as needed (see Testing section).
5. **Run tests**: `npm test` to ensure all tests pass and coverage remains at 95%+.
6. **Commit** with clear messages (e.g. `feat: add X`, `fix: Y`).
7. **Push** to your fork and open a **Pull Request** to `main`.
8. Wait for CI to pass and address any review feedback.

We welcome docs improvements, bug fixes, and new API endpoints aligned with the LiquiFact product (invoices, escrow, Stellar integration).

---

## License

MIT (see root LiquiFact project for full license).
