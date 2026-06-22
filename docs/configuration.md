# Configuration Reference

This reference maps the environment variables used by the backend configuration,
escrow submission, rate limiting, and metrics modules. It is aligned with
`.env.example` and calls out known drift so operators can keep deployment
configuration predictable.

Never commit a real `.env` file or production secret. Store secrets in a local
`.env` during development and in the deployment platform's secret manager in
production.

## Boot-Time Validation

`src/config/index.js` validates the core application configuration when
`validate()` is called during startup. The following variables can fail startup:

| Variable | Required | Default | Validation |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Must be `development`, `production`, or `test`. |
| `PORT` | No | `3001` | Number from `1` to `65535`. |
| `JWT_SECRET` | Yes | None | Minimum 32 characters. Treat as secret. |
| `CORS_ALLOWED_ORIGINS` | No | unset | Optional comma-separated origin list. |
| `SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Must be a valid URL. |
| `NETWORK_PASSPHRASE` | No | `Test SDF Network ; September 2015` | Stellar network passphrase used by `src/config/stellar.js`. |
| `SOROBAN_BATCH_CONCURRENCY` | No | `5` | Number from `1` to `50`. |
| `SOROBAN_BATCH_TIMEOUT_MS` | No | `5000` | Number from `100` to `30000`. |
| `ESCROW_INDEXER_ENABLED` | No | `false` | Must be `true` or `false`. |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | No | `300` | Number greater than or equal to `1`. |
| `KYC_PROVIDER_URL` | Conditional | unset | Optional valid URL. Required with `KYC_PROVIDER_API_KEY` outside tests. |
| `KYC_PROVIDER_API_KEY` | Conditional | unset | Required with `KYC_PROVIDER_URL` outside tests. Treat as secret. |
| `KYC_PROVIDER_SECRET` | No | unset | Optional provider signing secret. Treat as secret. |

## Environment Variables

| Variable | Type | Default | Required | Secret | Consumer |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | enum | `development` | No | No | `src/config/index.js` |
| `PORT` | number | `3001` | No | No | `src/config/index.js` |
| `JWT_SECRET` | string | None | Yes | Yes | `src/config/index.js` |
| `CORS_ALLOWED_ORIGINS` | string | unset | No | No | `src/config/index.js` |
| `SOROBAN_RPC_URL` | URL | `https://soroban-testnet.stellar.org` | No for config validation; required by live escrow submission | No | `src/config/index.js`, `src/services/escrowSubmit.js`, `src/config/stellar.js` |
| `NETWORK_PASSPHRASE` | string | `Test SDF Network ; September 2015` | No | No | `src/config/index.js`, `src/config/stellar.js` |
| `STELLAR_NETWORK_PASSPHRASE` | string | unset | Required for non-stubbed escrow submission | No | `src/services/escrowSubmit.js` |
| `ESCROW_SIGNING_MODE` | enum | `stubbed` | No | No | `src/services/escrowSubmit.js` |
| `ESCROW_PLATFORM_ADDRESS` | Stellar public key | unset | Required for `delegated` or `custodial` signing | No | `src/services/escrowSubmit.js` |
| `ESCROW_PLATFORM_SECRET` | Stellar secret key | unset | Required for `custodial` signing | Yes | `src/services/escrowSubmit.js` |
| `SOROBAN_BATCH_CONCURRENCY` | number | `5` | No | No | `src/config/index.js` |
| `SOROBAN_BATCH_TIMEOUT_MS` | number | `5000` | No | No | `src/config/index.js` |
| `ESCROW_INDEXER_ENABLED` | boolean string | `false` | No | No | `src/config/index.js` |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | number | `300` | No | No | `src/config/index.js` |
| `KYC_PROVIDER_URL` | URL | unset | Conditional | No | `src/config/index.js` |
| `KYC_PROVIDER_API_KEY` | string | unset | Conditional | Yes | `src/config/index.js` |
| `KYC_PROVIDER_SECRET` | string | unset | No | Yes | `src/config/index.js` |
| `RATE_LIMIT_WINDOW_MS` | number | `900000` | No | No | `src/middleware/rateLimit.js` |
| `RATE_LIMIT_MAX_REQUESTS` | number | `100` | No | No | `src/middleware/rateLimit.js` |
| `RATE_LIMIT_SENSITIVE_WINDOW_MS` | number | `3600000` | No | No | `src/middleware/rateLimit.js` |
| `RATE_LIMIT_SENSITIVE_MAX` | number | `40` | No | No | `src/middleware/rateLimit.js` |
| `RATE_LIMIT_API_KEY_WINDOW_MS` | number | `900000` | No | No | `src/middleware/rateLimit.js` |
| `RATE_LIMIT_API_KEY_MAX` | number | `1000` | No | No | `src/middleware/rateLimit.js` |
| `METRICS_BEARER_TOKEN` | string | unset | No | Yes | `src/metrics.js` |

## Security Notes

- `JWT_SECRET`, `ESCROW_PLATFORM_SECRET`, `KYC_PROVIDER_API_KEY`,
  `KYC_PROVIDER_SECRET`, and `METRICS_BEARER_TOKEN` must never be committed.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `API_KEYS`, Sentry DSNs, and KYC
  credentials appear in `.env.example` as operator guidance. Treat live values as
  secrets even when the current files listed above do not consume them directly.
- `ESCROW_PLATFORM_SECRET` is only read inside the custodial signing path and is
  expected to stay in memory for a single request.
- If `METRICS_BEARER_TOKEN` is unset, `src/metrics.js` only allows loopback
  scrapes. Production deployments should set a long random token.

## Drift Against `.env.example`

The current `.env.example` mostly covers the variables above, with the following
items to keep in mind:

| Drift | Detail |
| --- | --- |
| `NETWORK_PASSPHRASE` missing from `.env.example` | `src/config/index.js` and `src/config/stellar.js` use this name, while `.env.example` documents `STELLAR_NETWORK_PASSPHRASE`. |
| `STELLAR_NETWORK_PASSPHRASE` absent from config schema | `src/services/escrowSubmit.js` requires this variable for non-stubbed submission, but it is not part of `ConfigSchema`. |
| Duplicate example keys | `.env.example` contains repeated entries for `SOROBAN_RPC_URL`, `ESCROW_ADDR_BY_INVOICE`, and `JWT_SECRET` comments. |
| Extra example-only variables | `.env.example` includes storage, Sentry, API key, database, audit, and indexer settings that are consumed outside the files scoped by this reference or are deployment placeholders. |

When adding or renaming configuration, update `.env.example` and this reference
in the same pull request.
