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

No database is required. By default invoices live in an in-memory repository
seeded with demo data (writes persist only for the lifetime of a warm instance).
Set `DATABASE_URL` to use Postgres instead (see below). Escrow state is
read live from the deployed Soroban contract via RPC, with a deploy-time
snapshot as fallback.

### Postgres (optional)

```bash
docker run -d --name lfpg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres
npm run db:migrate && npm run db:seed   # db:rollback undoes the last batch
npm run dev
TEST_DATABASE_URL=$DATABASE_URL npm test   # also runs the HTTP suite on Postgres
```

- `DATABASE_URL` selects the Postgres repository; unset means in-memory.
- `PGSSLMODE=require` turns TLS on (certificate is not verified).
- Database outages answer `503 { "code": "DB_UNAVAILABLE" }` on data routes.
- Money (`amount`, `fundedAmount`) is returned as a decimal string.

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
| POST | `/api/invoices/:id/fund` | Record an investor contribution (`{ "amount": 100 }`) |
| GET | `/api/escrow` | Deployed escrow contract metadata |
| GET | `/api/escrow/live` | Live `get_escrow` read from Soroban RPC |

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
src/data/            Async invoice repository (memory + Postgres/knex)
migrations/, seeds/  knex migrations and demo seed
src/routes/          invoices and escrow routers
tests/               Jest + supertest API tests
```

The canonical Soroban escrow contract lives in
[Liquifact-contracts](https://github.com/Liquifact/Liquifact-contracts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
