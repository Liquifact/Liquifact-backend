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

### Listing invoices (#1554)

`GET /api/invoices` now returns `{ data, count, total, nextCursor }`. `count`
still means page length; `total` counts all filtered invoices before the cursor.
The default page has at most 20 records, with `limit=1..100`. Pass the returned
opaque `nextCursor` as `cursor` with the same sort and filters to continue;
`nextCursor: null` ends traversal. This is live pagination, not a frozen snapshot:
updates to the underlying invoices between requests can change membership.

Available filters (all scalar, at most once per request):

- `status=open,funded` (any comma-separated subset of open/funded/settled/cancelled).
- `currency=USDC` (exact case-sensitive 1–12 alphanumeric asset code).
- `sme=acme` (case-insensitive substring, 1–120 characters).
- `minAmount`/`maxAmount` (inclusive non-negative decimal strings, at most 128
  characters; no exponent notation). Comparisons use scaled integers, not floats.
- `minYieldBps`/`maxYieldBps` (inclusive integers from 0 to 10000).
- `dueAfter`/`dueBefore` (inclusive real `YYYY-MM-DD` calendar dates).
- `onChain=true|false`.

`sort` accepts `createdAt`, `dueDate`, `yieldBps`, `amount`, or any of these
prefixed with `-` for descending order. Default: `-createdAt`. Ties always use
ascending `id`, independent of direction. Cursors carry the sort, last sort
value and id; they are read positions, not authentication credentials. Malformed
or sort-mismatched cursors return 400 `INVALID_CURSOR`. Unknown/repeated params,
invalid bounds and impossible dates return 400 `VALIDATION_FAILED` with errors
keyed by parameter in `details`. Inverted ranges are rejected.

Examples:

```text
/api/invoices?status=open,funded&currency=USDC&sort=-yieldBps&limit=2
/api/invoices?dueBefore=2027-03-01&minAmount=100.25&onChain=false
```

`?status=open` remains supported. Sorting/filtering do not mutate the store;
this remains an in-memory demo, with no database-level pagination or FX.

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
