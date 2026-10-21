# LiquiFact Backend

## Live

- **Website:** https://liquifact-frontend.vercel.app
- **Docs:** https://liquifact-frontend.vercel.app/docs
- **API:** https://liquifact-backend.vercel.app (health: [/health](https://liquifact-backend.vercel.app/health))
- **API docs (Swagger UI):** https://liquifact-backend.vercel.app/docs
- **Contract (testnet):** [`CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P`](https://stellar.expert/explorer/testnet/contract/CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P)

LiquiFact is an invoice liquidity network on Stellar: SMEs submit invoices,
investors fund them, and a Soroban escrow contract holds funds until the debtor
settles. This repository is the HTTP API: a small Express app that runs as a
regular Node server locally and as a Vercel serverless function in production.

No database is required. Invoices live in an in-memory store seeded with demo
data (writes persist only for the lifetime of a warm instance). Escrow state is
read live from the deployed Soroban contract via RPC, with a deploy-time
snapshot as fallback.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | JSON index of all endpoints, contract and docs links |
| GET | `/health` | Liveness probe (`/healthz` alias) |
| GET | `/ready` | Readiness probe (Soroban RPC, network, ledger freshness, contract) |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3 document |
| GET | `/api/stats` | Marketplace totals |
| GET | `/api/invoices` | List invoices (`?status=open\|funded\|settled\|cancelled`) |
| GET | `/api/invoices/:id` | Get one invoice |
| POST | `/api/invoices` | Submit an invoice (`sme`, `debtor`, `amount`, `dueDate`, optional `currency`, `yieldBps`, `smeAddress`) |
| POST | `/api/invoices/:id/fund` | Record an investor contribution (`{ "amount": 100, "investor": "G..." }`) |
| GET | `/api/invoices/:id/contributions` | List contributions for an invoice (`?limit=50&cursor=...`) |
| GET | `/api/investors/:address/portfolio` | Investor portfolio summary and expected returns |
| GET | `/api/escrow` | Deployed escrow contract metadata |
| GET | `/api/escrow/live` | Live `get_escrow` read from Soroban RPC |

## Known Limitations

- **Wallet authentication:** Verification/cryptographic signatures for the `investor` address field on funding are tracked separately. Contributions currently trust the submitted Stellar address.

## Development

### Marketplace statistics migration (#1530)

`GET /api/stats` returns `byCurrency`, `byStatus`, `invoices`, `open` and
`generatedAt`. Each currency contains decimal-string `faceValue`, `funded` and
`outstanding`, plus an integer `weightedYieldBps`. Cancelled invoices count in
`invoices`/`byStatus` but are excluded from monetary totals and weighted yields.
Outstanding principal includes only invoices currently in `funded` status;
settled principal is not outstanding. A zero principal has yield zero.

Use `?currency=USDC` to scope the entire response, including the legacy counters.
Asset codes are case-sensitive, 1–12 alphanumeric characters. Unknown valid
codes return empty groups and zero counts; invalid/repeated codes return 400
`VALIDATION_FAILED`. No currencies are converted or added together in the new
groups. See `/openapi.json` for the complete schema.

For this release, the old `totalFaceValue`, `totalFunded` and `averageYieldBps`
fields are also grouped under `deprecated` with their original mixed-asset
semantics. Their top-level aliases are retained for this one migration release
so existing consumers do not break before they can migrate to `byCurrency`.
Both these aliases and the deprecated object are scheduled for removal in the
next release. Top-level `invoices` and `open` remain available.
These legacy mixed-asset fields must not be used as financial totals.

Aggregation uses scaled `BigInt` arithmetic, including the weighted-yield
numerator and rounding. Decimal strings retain their precision; existing
JavaScript-number records cannot recover precision already lost before storage.
This does not change invoice persistence, funding arithmetic or introduce FX.

Requires Node.js 20+.

```bash
npm ci
npm run dev        # http://localhost:3001
npm run lint
npm test
```

Configuration is optional; see [`.env.example`](.env.example).

### Readiness probe (#1543)

`GET /health` is a cheap liveness probe: it never touches a dependency and
always answers `200`. `GET /ready` is the dependency-aware probe. It runs four
checks in parallel against the configured Soroban RPC and answers `200` with
`{ "status": "ready", "checks": { ... } }`, or `503` with
`{ "status": "not_ready", "checks": { ... } }` when a check fails:

| Check | What it verifies | Failure code |
|-------|------------------|--------------|
| `rpc` | `getHealth()` reports `healthy` | `RPC_ERROR`, `TIMEOUT` |
| `network` | `getNetwork()` passphrase equals `STELLAR_NETWORK_PASSPHRASE` | `PASSPHRASE_MISMATCH` |
| `ledger` | the latest ledger is younger than `READY_MAX_LEDGER_AGE_SECONDS` | `STALE_LEDGER` |
| `contract` | the configured escrow contract is deployed | `CONTRACT_NOT_FOUND` |

Failing checks report a short code only; raw upstream messages are never
returned. The result is cached for `READY_CACHE_SECONDS` so that probes cannot
hammer the RPC, and every check is bounded by `READY_CHECK_TIMEOUT_MS`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `READY_CHECK_TIMEOUT_MS` | `2000` | Per-check timeout |
| `READY_MAX_LEDGER_AGE_SECONDS` | `60` | Maximum accepted age of the latest ledger |
| `READY_CACHE_SECONDS` | `10` | How long a probe result is reused (`0` disables caching) |

## Deployment (Vercel)

`api/index.js` exports the Express app and `vercel.json` rewrites every path
to it. `src/index.js` only calls `app.listen` when run directly.

```bash
vercel deploy --prod
```

## Project layout

```
api/index.js         Vercel serverless entry (exports the app)
src/app.js           Express app: routes, docs, error handling
src/index.js         Local server entry
src/config.js        Env-driven config with safe defaults
src/openapi.js       OpenAPI document
src/data/store.js    In-memory invoice store (demo seed data)
src/routes/          invoices and escrow routers
src/services/        marketplace stats and readiness checks
src/stellar/         escrow decoder and shared Soroban RPC client
tests/               Jest + supertest API tests
```

The canonical Soroban escrow contract lives in
[Liquifact-contracts](https://github.com/Liquifact/Liquifact-contracts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
