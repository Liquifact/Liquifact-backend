# Environment variable reference

This reference maps the variables in `.env.example` and the configuration code to their defaults, consumers, and required status. Do not commit `.env` files or real secret values.

## Boot-time required variables

| Variable | Type | Default | Consumer | Required | Secret | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `JWT_SECRET` | string, min 32 chars | none | `src/config/index.js`, `src/middleware/auth.js` | Yes outside intentionally stubbed local tests | Yes | Signs and verifies JWTs. Generate a long random value and store it in a secrets manager. |
| `NODE_ENV` | `development`, `production`, or `test` | `development` | `src/config/index.js`, app/bootstrap helpers | No | No | Controls development CORS fallback, stack traces, and test behavior. |
| `PORT` | integer, 1-65535 | `3001` | `src/config/index.js`, `src/index.js`, `src/server.js` | No | No | HTTP listen port. |
| `SOROBAN_RPC_URL` | URL | `https://soroban-testnet.stellar.org` | `src/config/index.js`, `src/config/stellar.js`, `src/services/escrowSubmit.js`, health checks | Required for live Soroban flows | No | Must match the selected Stellar network. |
| `NETWORK_PASSPHRASE` | string | `Test SDF Network ; September 2015` | `src/config/stellar.js` | No | No | Validated config passphrase consumed by `getStellarConfig()`. |
| `STELLAR_NETWORK_PASSPHRASE` | string | none | `src/services/escrowSubmit.js` | Required when `ESCROW_SIGNING_MODE` is `delegated` or `custodial` | No | Used directly when building the funding transaction. Keep aligned with the RPC network. |
| `STELLAR_NETWORK` | `TESTNET`, `MAINNET`, or `FUTURENET` | `TESTNET` in `.env.example` | Stellar boot validation described in `README.md` | Required when boot validation is enabled | No | Must match `SOROBAN_RPC_URL`; custom RPC URLs are intentionally rejected. |

## Core application and security

| Variable | Type | Default | Consumer | Required | Secret | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | comma-separated origins | development fallback origins in dev, empty otherwise | `src/config/index.js`, `src/config/cors.js` | Production recommended | No | Preferred CORS allowlist variable in `.env.example`. |
| `CORS_ORIGINS` | comma-separated origins | same as above | `src/config/cors.js` | No | No | Backward-compatible alias. |
| `HELMET_CSP` | boolean-like string | implementation default | app security middleware | No | No | Set `false` locally when CSP blocks development tooling. |
| `LOG_LEVEL` | string | `info` | `src/logger.js` | No | No | Controls application log verbosity. |
| `API_KEYS` | semicolon-separated JSON objects | empty registry | `src/config/apiKeys.js` | Required only for API-key clients | Yes | Entries contain raw API keys. Each key must start with `lf_`, be at least 10 chars, and include `clientId` plus non-empty scopes. |
| `API_KEYS_DB_PATH` | filesystem path | `data/api_keys.db` | `src/middleware/apiKey.js` | No | No | SQLite path for API-key middleware storage. |
| `IDEMPOTENCY_KEY_TTL_HOURS` | positive number | middleware default | `src/middleware/idempotency.js` | No | No | TTL for idempotency keys. |

## Request limits and rate limits

| Variable | Type | Default | Consumer | Required | Secret | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `BODY_LIMIT_JSON` | size string | `100kb` | `src/middleware/bodySizeLimits.js` | No | No | Default JSON body cap. |
| `BODY_LIMIT_URLENCODED` | size string | `50kb` | `src/middleware/bodySizeLimits.js` | No | No | URL-encoded body cap. |
| `BODY_LIMIT_RAW` | size string | `1mb` | `src/middleware/bodySizeLimits.js` | No | No | Raw/binary body cap. |
| `BODY_LIMIT_INVOICE` | size string | `512kb` | `src/middleware/bodySizeLimits.js`, `src/services/storage.js` | No | No | Invoice upload body and file-size cap. |
| `RATE_LIMIT_WINDOW_MS` | integer ms | `900000` | `src/middleware/rateLimit.js` | No | No | Global limiter window. |
| `RATE_LIMIT_MAX_REQUESTS` | integer | `100` | `src/middleware/rateLimit.js` | No | No | Global requests per window. |
| `RATE_LIMIT_SENSITIVE_WINDOW_MS` | integer ms | `3600000` | `src/middleware/rateLimit.js` | No | No | Sensitive endpoint limiter window. |
| `RATE_LIMIT_SENSITIVE_MAX` | integer | `40` | `src/middleware/rateLimit.js` | No | No | Sensitive requests per window. |
| `RATE_LIMIT_API_KEY_WINDOW_MS` | integer ms | `900000` | `src/middleware/rateLimit.js` | No | No | API-key limiter window. |
| `RATE_LIMIT_API_KEY_MAX` | integer | `1000` | `src/middleware/rateLimit.js` | No | No | API-key requests per window. |

## Soroban and escrow submission

| Variable | Type | Default | Consumer | Required | Secret | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `ESCROW_SIGNING_MODE` | `delegated`, `custodial`, or `stubbed` | `stubbed` in code, `delegated` in `.env.example` | `src/services/escrowSubmit.js` | No | No | `delegated` returns unsigned XDR; `custodial` signs and submits server-side; `stubbed` skips chain submission. |
| `ESCROW_PLATFORM_ADDRESS` | Stellar public key | none | `src/services/escrowSubmit.js` | Required for delegated/custodial funding | No | Source account for funding transactions. |
| `ESCROW_PLATFORM_SECRET` | Stellar secret key | none | `src/services/escrowSubmit.js` | Required only for custodial signing | Yes | Never commit. Prefer KMS or deployment secret storage. |
| `ESCROW_ADDR_BY_INVOICE` | JSON mapping | empty | `src/config/escrowMap.js` | Required only for mapped invoice escrow lookup | No | Maps invoice IDs to escrow contract addresses for early phases. |
| `LIQUIFACT_ESCROW_CONTRACT_ID` | Soroban contract ID | none | documented in `.env.example` | Deployment-specific | No | Contract ID for the Liquifact escrow deployment. |
| `ESCROW_CONTRACT_ID` | Soroban contract ID | none | `src/config/escrowVersions.js` | Required by escrow version helpers when no explicit ID is passed | No | Code-level name for the active escrow contract ID. |
| `ESCROW_CUSTODIAL_SIGNING_ENABLED` | boolean-like string | `false` | documented in `.env.example` | No | No | Reference flag for custodial signing posture. |
| `ESCROW_CUSTODIAL_KMS_PROVIDER` | string | none | documented in `.env.example` | No | No | KMS provider name for custodial signing plans. |
| `ESCROW_CUSTODIAL_KEY_ID` | string | none | documented in `.env.example` | Required only for KMS-backed custody | Yes | KMS key identifier, not a raw secret key. |
| `ESCROW_DOCUMENT_CUSTODIAL_KEY_ID` | string | none | documented in `.env.example` | Required only for document custody | Yes | KMS key identifier for document custody. |
| `SOROBAN_MAX_RETRIES` | integer | `3` | `src/services/soroban.js` | No | No | Retry attempts for Soroban service calls. |
| `SOROBAN_BASE_DELAY` | integer ms | `200` | `src/services/soroban.js` | No | No | Base retry delay. |
| `SOROBAN_MAX_DELAY` | integer ms | `5000` | `src/services/soroban.js` | No | No | Max retry delay. |
| `SOROBAN_BATCH_CONCURRENCY` | integer, 1-50 | `5` | `src/config/index.js` | No | No | Concurrency for batched on-chain reads. |
| `SOROBAN_BATCH_TIMEOUT_MS` | integer, 100-30000 | `5000` | `src/config/index.js` | No | No | Per-read timeout for batched on-chain reads. |
| `SOROBAN_TX_SUBMIT_MAX_RETRIES` | integer | `3` | `src/workers/txSubmitter.js` | No | No | Worker retry cap. |
| `SOROBAN_TX_SUBMIT_BASE_DELAY_MS` | integer ms | `500` | `src/workers/txSubmitter.js` | No | No | Worker base retry delay. |
| `SOROBAN_TX_SUBMIT_MAX_DELAY_MS` | integer ms | `20000` | `src/workers/txSubmitter.js` | No | No | Worker max retry delay. |
| `SOROBAN_TX_FEE_BUMP_MULTIPLIER` | number | `2` | `src/workers/txSubmitter.js` | No | No | Fee-bump multiplier, clamped by code. |

## Cache, indexer, database, and storage

| Variable | Type | Default | Consumer | Required | Secret | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `ESCROW_CACHE_TTL_SECONDS` | positive integer seconds | `30` | `src/config/cache.js` | No | No | In-memory escrow cache TTL. |
| `REDIS_ESCROW_CACHE_ENABLED` | boolean-like string | `false` | `src/cache/redis.js` | No | No | Redis cache is only enabled when this is `true` and `REDIS_URL` is set. |
| `REDIS_URL` | Redis URL | none | `src/cache/redis.js` | Required only when Redis cache is enabled | Yes | May include credentials. Store as a secret. |
| `REDIS_ESCROW_CACHE_TTL_SECONDS` | integer, clamped 5-300 | `30` | `src/cache/redis.js` | No | No | Redis escrow summary TTL. |
| `REDIS_ESCROW_LEDGER_GAP_THRESHOLD` | integer, clamped 1-1000 | `3` | `src/cache/redis.js` | No | No | Invalidates cache when ledger gap exceeds this value. |
| `DATABASE_URL` | PostgreSQL URL | none | health checks, migrations, DB clients | Required for persistent DB-backed deployments | Yes | Usually contains credentials. |
| `AUDIT_LOG_ENABLED` | boolean-like string | implementation default | documented in `.env.example` | No | No | Enables audit logging when supported by deployment. |
| `AUDIT_LOG_FAIL_CLOSED` | boolean-like string | implementation default | documented in `.env.example` | No | No | Use with care; fail-closed audit behavior can block writes. |
| `STELLAR_HORIZON_URL` | URL | `https://horizon-testnet.stellar.org` | `src/jobs/escrowIndexer.js` | No | No | Horizon endpoint for escrow event indexing. |
| `ESCROW_INDEXER_ENABLED` | `true` or `false` | `false` | `src/config/index.js`, indexer startup | No | No | Feature flag for the background escrow indexer. |
| `ESCROW_INDEXER_POLL_INTERVAL_MS` | integer ms | indexer default, `.env.example` uses `15000` | `src/jobs/escrowIndexer.js` | No | No | Poll interval. |
| `ESCROW_INDEXER_BATCH_SIZE` | integer | indexer default, `.env.example` uses `100` | `src/jobs/escrowIndexer.js` | No | No | Event batch size. |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | positive integer seconds | `300` | `src/config/index.js` | No | No | Readiness degradation threshold for stale cursors. |
| `AWS_REGION` | string | `us-east-1` | `src/services/storage.js` | Required for S3 uploads | No | Region for S3-compatible storage. |
| `S3_ENDPOINT` | URL | provider default when unset | `src/services/storage.js` | Deployment-specific | No | S3-compatible endpoint. |
| `AWS_ACCESS_KEY_ID` | string | none | `src/services/storage.js` | Required for S3 uploads | Yes | Store as a secret. |
| `AWS_SECRET_ACCESS_KEY` | string | none | `src/services/storage.js` | Required for S3 uploads | Yes | Store as a secret. |
| `S3_BUCKET` | string | `liquifact-invoices` | `src/services/storage.js` | Required for S3 uploads | No | Bucket for invoice documents. |

## Observability, metrics, KYC, email, and webhooks

| Variable | Type | Default | Consumer | Required | Secret | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `SENTRY_DSN` | DSN URL | unset | `src/observability/sentry.js` | No | Secret-adjacent | Public DSN style, but treat deployment observability config as sensitive. |
| `SENTRY_RELEASE` | string | package version or `liquifact-backend@unknown` | `src/observability/sentry.js` | No | No | Release tag. |
| `SENTRY_ENVIRONMENT` | string | `NODE_ENV` or `development` | `src/observability/sentry.js` | No | No | Environment tag. |
| `METRICS_BEARER_TOKEN` | string | loopback-only access when unset | `src/metrics.js` | Production recommended | Yes | Required for non-loopback Prometheus scraping. |
| `KYC_PROVIDER_URL` | HTTPS URL | unset | `src/config/index.js`, `src/services/kycService.js` | Required with `KYC_PROVIDER_API_KEY` in non-test envs | No | Both URL and API key must be set together. |
| `KYC_PROVIDER_API_KEY` | string | unset | `src/config/index.js`, `src/services/kycService.js` | Required with `KYC_PROVIDER_URL` in non-test envs | Yes | Provider credential. |
| `KYC_PROVIDER_SECRET` | string | unset | `src/config/index.js`, `src/services/kycService.js` | Optional | Yes | Optional provider HMAC/signing secret. |
| `SMTP_HOST` | hostname | unset | `src/jobs/maturityReminders.js` | Required for email reminders | No | Enables SMTP transport when set. |
| `SMTP_PORT` | integer | `587` | `src/jobs/maturityReminders.js` | No | No | SMTP port. |
| `SMTP_USER` | string | unset | `src/jobs/maturityReminders.js` | Required when SMTP auth is needed | Yes | SMTP credential. |
| `SMTP_PASS` | string | unset | `src/jobs/maturityReminders.js` | Required when SMTP auth is needed | Yes | SMTP credential. |
| `SMTP_FROM` | email | `noreply@liquifact.com` | `src/jobs/maturityReminders.js` | No | No | Sender address. |
| `WEBHOOK_MAX_RETRIES` | integer | `3` | `src/services/webhooks.js` | No | No | Delivery retry attempts. |
| `WEBHOOK_BASE_DELAY` | integer ms | `500` | `src/services/webhooks.js` | No | No | Base retry delay. |
| `WEBHOOK_MAX_DELAY` | integer ms | `10000` | `src/services/webhooks.js` | No | No | Max retry delay. |
| `WEBHOOK_TIMEOUT_MS` | integer ms | `5000` | `src/services/webhooks.js` | No | No | Per-delivery timeout. |

## Sync audit

Variables present in `.env.example` but not directly read by the scanned runtime files:

- `HELMET_CSP`
- `LIQUIFACT_ESCROW_CONTRACT_ID`
- `ESCROW_CUSTODIAL_SIGNING_ENABLED`
- `ESCROW_CUSTODIAL_KMS_PROVIDER`
- `ESCROW_CUSTODIAL_KEY_ID`
- `ESCROW_DOCUMENT_CUSTODIAL_KEY_ID`
- `AUDIT_LOG_ENABLED`
- `AUDIT_LOG_FAIL_CLOSED`

Variables read by code but missing from `.env.example` and worth adding when the owning feature is promoted:

- `NETWORK_PASSPHRASE`
- `CORS_ORIGINS`
- `LOG_LEVEL`
- `API_KEYS_DB_PATH`
- `ESCROW_PLATFORM_ADDRESS`
- `ESCROW_PLATFORM_SECRET`
- `ESCROW_CONTRACT_ID`
- `SOROBAN_TX_SUBMIT_MAX_RETRIES`
- `SOROBAN_TX_SUBMIT_BASE_DELAY_MS`
- `SOROBAN_TX_SUBMIT_MAX_DELAY_MS`
- `SOROBAN_TX_FEE_BUMP_MULTIPLIER`
- `IDEMPOTENCY_KEY_TTL_HOURS`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `WEBHOOK_MAX_RETRIES`
- `WEBHOOK_BASE_DELAY`
- `WEBHOOK_MAX_DELAY`
- `WEBHOOK_TIMEOUT_MS`

