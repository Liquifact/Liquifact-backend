# Configuration Reference

This reference is aligned with [`.env.example`](../.env.example). It lists every environment variable in that template, the expected type, the default or fallback behavior, whether startup validation requires it, and the primary consumer.

Secret values are marked **Secret** and must come from local `.env` files, deployment secret stores, or a KMS. Do not commit real secret values.

For operations guidance and incident response on the configuration subsystem, see [runbook-config.md](./runbook-config.md).

## Boot-Time Validation

- `JWT_SECRET` is required by [`src/config/index.js`](../src/config/index.js) and must be at least 32 characters.
- `CURSOR_SECRET` is optional when `JWT_SECRET` is available, but production cursor signing must never fall back to the public development/test cursor secret.
- `STELLAR_NETWORK` and `SOROBAN_RPC_URL` are documented as a required boot-time pair in the Stellar validation section of the [README](../README.md#stellar-network-configuration). The expected pairs are `TESTNET` with `https://soroban-testnet.stellar.org`, `MAINNET` with `https://soroban.stellar.org`, and `FUTURENET` with `https://rpc-futurenet.stellar.org`.
- `KYC_PROVIDER_URL` and `KYC_PROVIDER_API_KEY` must either both be set or both be absent outside `NODE_ENV=test`.
- `ESCROW_PLATFORM_ADDRESS` is required only when `ESCROW_SIGNING_MODE` is `delegated` or `custodial` in [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js).
- `ESCROW_PLATFORM_SECRET` is required only when `ESCROW_SIGNING_MODE=custodial`. It is a Stellar secret key and must never be committed.

## OpenAPI Server URLs

The published OpenAPI spec derives its `servers` array from `PUBLIC_API_BASE_URL` rather than hardcoding a value. This ensures generated clients, SDK generators, and Swagger UI always call the correct host.

| Environment | `PUBLIC_API_BASE_URL` set? | Spec `servers[0].url` |
| --- | --- | --- |
| `production` | Yes (required) | The configured value |
| `production` | No | **Startup fails** — config validation aborts with a clear error message |
| `development` / `test` | Yes | The configured value |
| `development` / `test` | No | `http://localhost:3001` (safe fallback) |

**Production constraints** (enforced by both `src/config/index.js` at boot time and `src/openapi/openapiSpec.js` as a defense-in-depth guard):

1. `PUBLIC_API_BASE_URL` must be present.
2. Must use the `https:` scheme — plaintext `http:` is rejected.
3. Must not resolve to a loopback address (`localhost`, `127.x.x.x`, `::1`).

Any violation causes a fast startup failure with a clear, redacted error message logged to stderr. The spec is never built with an invalid or insecure server entry.

## Environment Variables

<!-- env-reference:start -->
| Variable | Type | Default / Fallback | Required | Secret | Consumer |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | enum: `development`, `production`, `test` | `development` | No | No | [`src/config/index.js`](../src/config/index.js), [`src/app.js`](../src/app.js), [`src/index.js`](../src/index.js) |
| `PORT` | integer port | `3001` | No | No | [`src/config/index.js`](../src/config/index.js), [`src/index.js`](../src/index.js), [`src/server.js`](../src/server.js) |
| `PUBLIC_API_BASE_URL` | HTTPS URL | `http://localhost:3001` fallback in development/test | Required in production | No | [`src/config/index.js`](../src/config/index.js), [`src/openapi/openapiSpec.js`](../src/openapi/openapiSpec.js) |
| `HELMET_CSP` | boolean string | `false` in template; app defaults vary by environment | No | No | [`src/app.js`](../src/app.js) |
| `JWT_SECRET` | string, min 32 chars for config validation | None | Yes | **Secret** | [`src/config/index.js`](../src/config/index.js), [`src/middleware/auth.js`](../src/middleware/auth.js) |
| `CURSOR_SECRET` | string, min 32 chars when set | Falls back to `JWT_SECRET`; public dev fallback only in development/test | No | **Secret** | [`src/config/index.js`](../src/config/index.js), [`src/utils/cursorPagination.js`](../src/utils/cursorPagination.js) |
| `CURSOR_TTL_ENABLED` | boolean string | `false` | No | No | [`src/config/index.js`](../src/config/index.js), [`src/utils/cursorPagination.js`](../src/utils/cursorPagination.js) |
| `CURSOR_TTL_SECONDS` | integer seconds | `3600` | No | No | [`src/config/index.js`](../src/config/index.js), [`src/utils/cursorPagination.js`](../src/utils/cursorPagination.js) |
| `CORS_ORIGINS` | comma-separated origins | Development localhost fallback; production denies when unset | No | No | [`src/config/cors.js`](../src/config/cors.js) |
| `CORS_ALLOWED_ORIGINS` | comma-separated origins | Optional alias preferred over `CORS_ORIGINS` | No | No | [`src/config/index.js`](../src/config/index.js), [`src/config/cors.js`](../src/config/cors.js) |
| `CORS_MAX_AGE` | integer seconds | `600` | No | No | [`src/config/cors.js`](../src/config/cors.js) |
| `SENTRY_DSN` | URL | Sentry disabled when unset | No | **Secret** | [`src/observability/sentry.js`](../src/observability/sentry.js) |
| `SENTRY_RELEASE` | string | package version or `liquifact-backend@unknown` | No | No | [`src/observability/sentry.js`](../src/observability/sentry.js) |
| `SENTRY_ENVIRONMENT` | string | `NODE_ENV` or `development` | No | No | [`src/observability/sentry.js`](../src/observability/sentry.js) |
| `ESCROW_CACHE_TTL_SECONDS` | integer seconds | `30` | No | No | [`src/config/cache.js`](../src/config/cache.js) |
| `REDIS_ESCROW_CACHE_ENABLED` | boolean string | `false` | No | No | [`src/cache/redis.js`](../src/cache/redis.js) |
| `REDIS_URL` | Redis URL | Redis cache disabled when unset | No | **Secret** | [`src/cache/redis.js`](../src/cache/redis.js) |
| `REDIS_ESCROW_CACHE_TTL_SECONDS` | integer seconds | `30`, clamped to `5..300` | No | No | [`src/cache/redis.js`](../src/cache/redis.js) |
| `REDIS_ESCROW_LEDGER_GAP_THRESHOLD` | integer ledgers | `3` | No | No | [`src/cache/redis.js`](../src/cache/redis.js) |
| `BODY_LIMIT_JSON` | size string | `100kb` | No | No | [`src/middleware/bodySizeLimits.js`](../src/middleware/bodySizeLimits.js) |
| `BODY_LIMIT_URLENCODED` | size string | `50kb` | No | No | [`src/middleware/bodySizeLimits.js`](../src/middleware/bodySizeLimits.js) |
| `BODY_LIMIT_RAW` | size string | `1mb` | No | No | [`src/middleware/bodySizeLimits.js`](../src/middleware/bodySizeLimits.js) |
| `BODY_LIMIT_INVOICE` | size string | `512kb` | No | No | [`src/middleware/bodySizeLimits.js`](../src/middleware/bodySizeLimits.js), [`src/services/storage.js`](../src/services/storage.js) |
| `INVOICE_FILE_MAX_SIZE` | size string | `5mb` | No | No | [`src/routes/invoiceFile.js`](../src/routes/invoiceFile.js) |
| `ESCROW_SIGNING_MODE` | enum: `delegated`, `custodial`, `stubbed` | `stubbed` in code; `delegated` in template | No | No | [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js) |
| `STELLAR_NETWORK_PASSPHRASE` | string | None in escrow submission | Required outside `stubbed` escrow mode | No | [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js) |
| `NETWORK_PASSPHRASE` | string | `Test SDF Network ; September 2015` | No | No | [`src/config/index.js`](../src/config/index.js), [`src/config/stellar.js`](../src/config/stellar.js) |
| `LIQUIFACT_ESCROW_CONTRACT_ID` | Stellar contract ID | None | Required for escrow funding stubs that resolve a contract | No | [`tests/escrowSubmit.stub.test.js`](../tests/escrowSubmit.stub.test.js) |
| `ESCROW_PLATFORM_ADDRESS` | Stellar public key | None | Required outside `stubbed` escrow mode | No | [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js) |
| `ESCROW_PLATFORM_SECRET` | Stellar secret key | None | Required for `custodial` escrow mode | **Secret** | [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js) |
| `ESCROW_ADDR_BY_INVOICE` | JSON mapping | Empty mapping | No | No | [`src/config/escrowMap.js`](../src/config/escrowMap.js) |
| `ESCROW_CUSTODIAL_SIGNING_ENABLED` | boolean string | `false` | No | No | [`tests/escrowSubmit.stub.test.js`](../tests/escrowSubmit.stub.test.js) |
| `ESCROW_CUSTODIAL_KMS_PROVIDER` | string | None | Required only when custodial KMS signing is enabled | No | [`tests/escrowSubmit.stub.test.js`](../tests/escrowSubmit.stub.test.js) |
| `ESCROW_CUSTODIAL_KEY_ID` | KMS key identifier | None | Required only when custodial KMS signing is enabled | **Secret** | [`tests/escrowSubmit.stub.test.js`](../tests/escrowSubmit.stub.test.js) |
| `ESCROW_DOCUMENT_CUSTODIAL_KEY_ID` | KMS key identifier | None | No | **Secret** | [`.env.example`](../.env.example) |
| `STELLAR_NETWORK` | enum: `TESTNET`, `MAINNET`, `FUTURENET` | None for README boot validation | Yes, per README Stellar validation | No | [README Stellar validation](../README.md#stellar-network-configuration) |
| `STELLAR_NETWORK_PASSPHRASE` | string | `Test SDF Network ; September 2015` | No | No | [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js) |
| `SOROBAN_RPC_URL` | URL | `https://soroban-testnet.stellar.org` in config | Yes, per README Stellar validation | No | [`src/config/index.js`](../src/config/index.js), [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js), [`src/services/health.js`](../src/services/health.js) |
| `SOROBAN_MAX_RETRIES` | integer | `3` | No | No | [`src/services/soroban.js`](../src/services/soroban.js) |
| `SOROBAN_BASE_DELAY` | integer milliseconds | `200` | No | No | [`src/services/soroban.js`](../src/services/soroban.js) |
| `SOROBAN_MAX_DELAY` | integer milliseconds | `5000` | No | No | [`src/services/soroban.js`](../src/services/soroban.js) |
| `DATABASE_URL` | database URL | Development/test local fallbacks; production requires deployment value | Required for production DB/migrations | **Secret** | [`knexfile.js`](../knexfile.js), [`migrator-config.js`](../migrator-config.js), [`src/services/health.js`](../src/services/health.js) |
| `AUDIT_LOG_ENABLED` | boolean string | Feature default | No | No | [`.env.example`](../.env.example) |
| `AUDIT_LOG_FAIL_CLOSED` | boolean string | `false` | No | No | [`.env.example`](../.env.example) |
| `AWS_REGION` | string | `us-east-1` | No | No | [`src/services/storage.js`](../src/services/storage.js) |
| `S3_ENDPOINT` | URL | AWS S3 endpoint | No | No | [`src/services/storage.js`](../src/services/storage.js) |
| `AWS_ACCESS_KEY_ID` | string | None | Required for S3 uploads | **Secret** | [`src/services/storage.js`](../src/services/storage.js) |
| `AWS_SECRET_ACCESS_KEY` | string | None | Required for S3 uploads | **Secret** | [`src/services/storage.js`](../src/services/storage.js) |
| `S3_BUCKET` | string | `liquifact-invoices` | No | No | [`src/services/storage.js`](../src/services/storage.js) |
| `S3_HEALTHCHECK_ENABLED` | boolean string | enabled | No | No | [`src/services/storage.js`](../src/services/storage.js), [`src/services/health.js`](../src/services/health.js) |
| `STORAGE_IN_MEMORY` | boolean string | unset; auto-on when `NODE_ENV=test` | No | No | [`src/services/storage.js`](../src/services/storage.js) |
| `STORAGE_HEALTHCHECK_TIMEOUT_MS` | integer milliseconds | `5000` | No | No | [`src/services/storage.js`](../src/services/storage.js) |
| `METRICS_BEARER_TOKEN` | string | Loopback-only metrics access when unset | Recommended in production | **Secret** | [`src/metrics.js`](../src/metrics.js) |
| `API_KEYS` | semicolon-separated JSON objects | Empty registry | Required for API-key clients | **Secret** | [`src/config/apiKeys.js`](../src/config/apiKeys.js), [`src/middleware/apiKeyAuth.js`](../src/middleware/apiKeyAuth.js) |
| `RATE_LIMIT_WINDOW_MS` | integer milliseconds | `900000` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) |
| `RATE_LIMIT_MAX_REQUESTS` | integer | `100` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) |
| `RATE_LIMIT_SENSITIVE_WINDOW_MS` | integer milliseconds | `3600000` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) |
| `RATE_LIMIT_SENSITIVE_MAX` | integer | `40` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) |
| `RATE_LIMIT_API_KEY_WINDOW_MS` | integer milliseconds | `900000` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) |
| `RATE_LIMIT_API_KEY_MAX` | integer | `1000` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) |
| `CONFIG_RATE_LIMIT_WINDOW_MS` | integer milliseconds | `60000` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) — issue #754 per-client limit on `/api/admin/config` (mounted before `adminStack` so failed auth still counts) |
| `CONFIG_RATE_LIMIT_MAX` | integer (≥ 1) | `20` | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) — issue #754 per-client cap, paired with `CONFIG_RATE_LIMIT_WINDOW_MS` |
| `WEB_CONCURRENCY` | integer | `1` (single-instance default) | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) — issues #429 cluster-detection signal |
| `INVOICE_FRAUD_CEILING` | number > 0 | `10000000` | No | No | [`src/config/verificationThresholds.js`](../src/config/verificationThresholds.js) |
| `INVOICE_MANUAL_REVIEW_THRESHOLD` | number > 0, `<= INVOICE_FRAUD_CEILING` | `1000000` | No | No | [`src/config/verificationThresholds.js`](../src/config/verificationThresholds.js) |
| `INVOICE_TENANT_THRESHOLDS` | JSON object of per-tenant overrides | Empty (defaults apply to all tenants) | No | No | [`src/config/verificationThresholds.js`](../src/config/verificationThresholds.js) |
| `CLUSTER_WORKERS` | integer | `1` (single-instance default) | No | No | [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js) — issues #429 alt cluster-detection signal |
| `SOROBAN_BATCH_CONCURRENCY` | integer, `1..50` | `5` | No | No | [`src/config/index.js`](../src/config/index.js) |
| `SOROBAN_BATCH_TIMEOUT_MS` | integer milliseconds, `100..30000` | `5000` | No | No | [`src/config/index.js`](../src/config/index.js) |
| `ESCROW_INDEXER_ENABLED` | boolean string | `false` | No | No | [`src/config/index.js`](../src/config/index.js) |
| `ESCROW_INDEXER_POLL_INTERVAL_MS` | integer milliseconds | `15000` | No | No | [`src/jobs/escrowIndexer.js`](../src/jobs/escrowIndexer.js) |
| `ESCROW_INDEXER_BATCH_SIZE` | integer | `100` | No | No | [`src/jobs/escrowIndexer.js`](../src/jobs/escrowIndexer.js) |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | integer seconds | `300` | No | No | [`src/config/index.js`](../src/config/index.js) |
| `STELLAR_HORIZON_URL` | URL | `https://horizon-testnet.stellar.org` | No | No | [`src/jobs/escrowIndexer.js`](../src/jobs/escrowIndexer.js) |
| `KYC_PROVIDER_URL` | HTTPS URL | External KYC disabled when unset | Required with `KYC_PROVIDER_API_KEY` outside test | No | [`src/config/index.js`](../src/config/index.js), [`src/services/kycService.js`](../src/services/kycService.js) |
| `KYC_PROVIDER_API_KEY` | string | External KYC disabled when unset | Required with `KYC_PROVIDER_URL` outside test | **Secret** | [`src/config/index.js`](../src/config/index.js), [`src/services/kycService.js`](../src/services/kycService.js) |
| `KYC_PROVIDER_SECRET` | string | Optional webhook/request HMAC validation | No | **Secret** | [`src/config/index.js`](../src/config/index.js), [`src/services/kycService.js`](../src/services/kycService.js) |
| `LIQUIFACT_ESCROW_CONTRACT_ID` | Stellar contract ID | None | Required for escrow funding stubs that resolve a contract | No | [`tests/escrowSubmit.stub.test.js`](../tests/escrowSubmit.stub.test.js) |
| `IDEMPOTENCY_KEY_TTL_HOURS` | integer hours | `24` | No | No | [`src/middleware/idempotency.js`](../src/middleware/idempotency.js) |
| `IDEMPOTENCY_PURGE_BATCH_SIZE` | integer, `1..10000` | `1000` | No | No | [`src/jobs/idempotencyPurge.js`](../src/jobs/idempotencyPurge.js) |
| `IDEMPOTENCY_PURGE_INTERVAL_MS` | integer milliseconds, min `60000` | `3600000` | No | No | [`src/jobs/idempotencyPurge.js`](../src/jobs/idempotencyPurge.js) |
| `IDEMPOTENCY_PURGE_MAX_BATCHES` | integer, `1..1000` | `100` | No | No | [`src/jobs/idempotencyPurge.js`](../src/jobs/idempotencyPurge.js) |
<!-- env-reference:end -->

## Invoice Verification Thresholds

The invoice-verification service ([`src/services/invoiceVerification.js`](../src/services/invoiceVerification.js)) screens invoice amounts against two configurable thresholds, resolved by [`src/config/verificationThresholds.js`](../src/config/verificationThresholds.js):

| Threshold | Decision when matched | Comparison | Env var | Default |
| --- | --- | --- | --- | --- |
| Fraud ceiling | `REJECTED` | `amount > fraudCeiling` (strictly greater) | `INVOICE_FRAUD_CEILING` | `10000000` |
| Manual-review threshold | `MANUAL_REVIEW` | `amount >= manualReviewThreshold` (at or above) | `INVOICE_MANUAL_REVIEW_THRESHOLD` | `1000000` |

The defaults reproduce the previously hardcoded behavior, so an existing deployment that sets neither variable observes no change.

**Validation.** Each value must be a finite number greater than `0`, and `manualReviewThreshold` must be `<= fraudCeiling` (otherwise the manual-review band is unreachable). Invalid configuration is rejected: `resolveThresholds()` throws a `VerificationConfigError`, and the verification service **fails closed** — it returns `MANUAL_REVIEW` with reason code `CONFIG_UNAVAILABLE` rather than auto-approving or hard-rejecting.

### Per-Tenant Overrides

`INVOICE_TENANT_THRESHOLDS` is a JSON object keyed by tenant id. Each entry may override either or both fields; omitted fields fall back to the global defaults. Overrides are validated with the same rules as the globals.

```json
{
  "tenant-acme":   { "fraudCeiling": 5000000, "manualReviewThreshold": 500000 },
  "tenant-globex": { "manualReviewThreshold": 250000 }
}
```

In the example above, `tenant-acme` gets a stricter ceiling and review threshold, while `tenant-globex` only tightens the review threshold and keeps the default `10000000` fraud ceiling. A tenant id with no entry — and a request with no tenant id — uses the global defaults.

**Security.** Thresholds and overrides come exclusively from configuration set by an operator/admin via the environment. The per-tenant map is parsed into a `Map`, so prototype-pollution keys such as `__proto__` cannot be resolved as tenants. The tenant id passed to `verifyInvoice(payload, { tenantId })` must originate from the **trusted authenticated context** — never from the untrusted invoice payload. Any `tenantId` (or threshold-like field) present on the payload itself is ignored.

### Reason Codes

Every non-approval decision carries a stable, machine-readable `reasonCode` (in addition to the human-readable `reason`) so downstream handlers can branch reliably without string matching. `VERIFIED` outcomes carry no reason code.

| `reasonCode` | Status | Meaning |
| --- | --- | --- |
| `INVALID_PAYLOAD` | `REJECTED` | Payload missing or not an object. |
| `INVALID_AMOUNT` | `REJECTED` | Amount not a positive, finite number. |
| `INVALID_CUSTOMER` | `REJECTED` | Customer missing, not a string, or empty/whitespace. |
| `AMOUNT_EXCEEDS_FRAUD_CEILING` | `REJECTED` | Amount exceeded the resolved fraud ceiling. |
| `MANUAL_REVIEW_REQUIRED` | `MANUAL_REVIEW` | Amount met or exceeded the resolved manual-review threshold. |
| `SUSPICIOUS_CUSTOMER` | `REJECTED` | Customer string contained injection characters (`< > { } $`). |
| `CONFIG_UNAVAILABLE` | `MANUAL_REVIEW` | Threshold configuration was invalid; failed closed to manual review. |

These codes are part of the service contract: existing values must not be renamed or repurposed.

## Outbound Config Event Webhooks (Issue #975)

Whenever runtime configuration sections are updated via `POST /api/admin/config`, LiquiFact emits an outbound signed `config.updated` webhook event to tenant subscribers.

- **Signature Format**: `X-Signature: t=<timestamp>,v1=<hmac_sha256_hex>`
- **Payload Bounding**: Config payload size is bounded by `MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES` (32 KB / 32,768 bytes). If a section configuration exceeds 32 KB, the payload `config` object is truncated with `_summary` and `keys` arrays, and `truncated: true` is set.
- **Retry & Backoff**: Retries on transient HTTP 5xx or network errors using exponential backoff.
- **Dead-Letter Queue (DLQ)**: Persists failed attempts to `webhook_dead_letters` upon retry exhaustion.

## Sync Notes

- The reference table above is tested against `.env.example` by [`tests/config.envReference.test.js`](../tests/config.envReference.test.js). Add a row here whenever `.env.example` gains a key.
- The scoped code consumers from issue #288 are covered: [`src/config/index.js`](../src/config/index.js), [`src/services/escrowSubmit.js`](../src/services/escrowSubmit.js), [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js), and [`src/metrics.js`](../src/metrics.js).
- Drift found while documenting: `.env.example` had duplicate `SOROBAN_RPC_URL`, `ESCROW_ADDR_BY_INVOICE`, `JWT_SECRET`, and `API_KEYS` entries. Those duplicates were removed. It also lacked `NETWORK_PASSPHRASE`, `ESCROW_PLATFORM_ADDRESS`, and `ESCROW_PLATFORM_SECRET`, which are consumed by the scoped configuration code; those keys were added without real secret values.

