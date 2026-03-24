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

## Development

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Start API with watch mode      |
| `npm run start`| Start API (production-style)  |
| `npm run lint` | Run ESLint on `src/`          |

Default port: **3001**. After starting:

- Health: [http://localhost:3001/health](http://localhost:3001/health)
- API info: [http://localhost:3001/api](http://localhost:3001/api)

---

## Project structure

```
liquifact-backend/
├── src/
<<<<<<< HEAD
│   ├── app.js          # App configuration
│   ├── index.js        # Server entry point
│   ├── routes/         # API routes
│   ├── services/       # Business logic / DB interaction
│   └── tests/          # Unit and integration tests
├── .env.example
=======
│   ├── services/
│   │   └── soroban.js  # Contract interaction wrappers
│   ├── utils/
│   │   └── retry.js    # Exponential backoff utility
│   └── index.js        # Express app, routes
├── .env.example        # Env template
>>>>>>> main
├── eslint.config.js
└── package.json
```

---

<<<<<<< HEAD
## API Endpoints

### Invoices

#### `GET /api/invoices/:id`
Retrieve a single invoice.
- **Requires header**: `x-user-id` (mock user identification).
- **Responses**:
  - `200 OK`: Returns the invoice data.
  - `400 Bad Request`: Invalid or missing ID.
  - `401 Unauthorized`: Missing `x-user-id` header.
  - `403 Forbidden`: User does not have access to the invoice.
  - `404 Not Found`: Invoice with specified ID doesn't exist.
=======
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
>>>>>>> main

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
5. **Commit** with clear messages (e.g. `feat: add X`, `fix: Y`).
6. **Push** to your fork and open a **Pull Request** to `main`.
7. Wait for CI to pass and address any review feedback.

We welcome docs improvements, bug fixes, and new API endpoints aligned with the LiquiFact product (invoices, escrow, Stellar integration).

---

## License

MIT (see root LiquiFact project for full license).
