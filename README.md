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
| `npm test` | Run load helper tests |
| `npm run test:coverage` | Run load helper tests with coverage |
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

### Reports

Each run generates:

- a JSON artifact
- a Markdown artifact
- a console summary

By default, reports are written to:

```text
tests/load/reports/
```

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

We welcome docs improvements, bug fixes, and new API endpoints aligned with LiquiFact product goals.

---

## License

MIT (see root LiquiFact project for full license).
