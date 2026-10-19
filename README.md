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

Requires Node.js 20+.

```bash
npm ci
npm run dev        # http://localhost:3001
npm run lint
npm test
```

Configuration is optional; see [`.env.example`](.env.example).

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
tests/               Jest + supertest API tests
```

The canonical Soroban escrow contract lives in
[Liquifact-contracts](https://github.com/Liquifact/Liquifact-contracts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
