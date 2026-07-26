# Configuration Subsystem Operations Runbook

Operator runbook for the LiquiFact backend configuration subsystem: the
centralized environment-driven config validator and the admin runtime-config
surface used to accept validated configuration updates.

> **Scope note.** This runbook covers the runtime configuration flow implemented
> in [src/config/index.js](../src/config/index.js), the admin route in
> [src/routes/adminConfig.js](../src/routes/adminConfig.js), and the startup
> validation gate in [src/index.js](../src/index.js). It does not cover the
> unrelated CORS or persistence subsystems.

---

## Architecture Overview

```text
Process startup
  │
  ▼
runBootConfigValidation()
  │
  ▼
validate() in src/config/index.js
  │
  ├─ parses env vars with Zod
  ├─ applies defaults and coercions
  ├─ rejects invalid or unsafe values
  └─ stores the validated config for later access
```

The main execution path is:

1. [src/index.js](../src/index.js) runs boot-time validation before the HTTP
   server starts.
2. [src/config/index.js](../src/config/index.js) validates the environment with
   Zod and applies defaults for many values.
3. [src/routes/adminConfig.js](../src/routes/adminConfig.js) accepts admin-only
   runtime configuration updates for named sections, but only after strict
   schema validation.

---

## Configuration

All settings are read from the process environment. The validator in
[src/config/index.js](../src/config/index.js) enforces the rules below.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Must be `development`, `production`, or `test`. |
| `PORT` | `3001` | Must be a valid TCP port between `1` and `65535`. |
| `JWT_SECRET` | none | Required and must be at least 32 characters. |
| `JWT_ALGORITHMS` | `HS256` | Comma-separated algorithm allowlist. |
| `JWT_ISSUER` | unset | Optional issuer claim to enforce. |
| `JWT_AUDIENCE` | unset | Optional audience claim to enforce. |
| `CURSOR_SECRET` | unset | Required in production if `JWT_SECRET` is also absent. |
| `CURSOR_TTL_ENABLED` | `false` | Boolean-like string (`true`/`false`). |
| `CURSOR_TTL_SECONDS` | `3600` | Positive integer. |
| `CORS_ALLOWED_ORIGINS` | unset | Optional comma-separated browser-origin allowlist. |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Must be a valid URL. |
| `NETWORK_PASSPHRASE` | Testnet default | Network identifier. |
| `SOROBAN_BATCH_CONCURRENCY` | `5` | Integer in the range `1-50`. |
| `SOROBAN_BATCH_TIMEOUT_MS` | `5000` | Integer in the range `100-30000`. |
| `ESCROW_INDEXER_ENABLED` | `false` | Boolean-like string (`true`/`false`). |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | `300` | Positive integer. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Integer in the range `0+`. |
| `KYC_PROVIDER_URL` | unset | Optional URL; must be paired with `KYC_PROVIDER_API_KEY` in non-test envs. |
| `KYC_PROVIDER_API_KEY` | unset | Optional key; must be paired with `KYC_PROVIDER_URL` in non-test envs. |
| `KYC_PROVIDER_SECRET` | unset | Optional, but accepted only when the URL/key pair is present. |
| `KYC_PROVIDER_TIMEOUT_MS` | `5000` | Integer in the range `100-30000`. |
| `KYC_PROVIDER_MAX_RETRIES` | `3` | Integer in the range `0-10`. |
| `KYC_PROVIDER_BASE_DELAY_MS` | `200` | Integer in the range `0-10000`. |
| `KYC_PROVIDER_MAX_DELAY_MS` | `5000` | Integer in the range `0-60000`. |
| `KYC_PROVIDER_SIGN_REQUESTS` | `false` | Boolean-like string (`true`/`false`). |
| `KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE` | `false` | Boolean-like string (`true`/`false`). |
| `KYC_PROVIDER_CB_FAILURE_THRESHOLD` | `5` | Integer in the range `1-100`. |
| `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS` | `10000` | Integer in the range `100-60000`. |
| `PUBLIC_API_BASE_URL` | unset | Required in production; must be HTTPS and not loopback. |
| `INVOICE_FILE_MAX_SIZE` | `5mb` | Must match a size pattern such as `512kb` or `5mb`. |

### Production-specific safeguards

The validator deliberately fails startup when production settings are unsafe:

- `CURSOR_SECRET` or `JWT_SECRET` must be present.
- `PUBLIC_API_BASE_URL` must be set and must be an HTTPS URL that is not a
  loopback address.
- `KYC_PROVIDER_URL` and `KYC_PROVIDER_API_KEY` must be provided together in
  non-test environments.

---

## Common Failure Modes

### 1. Startup exits during boot validation

**Symptom:** the process exits immediately during startup with a redacted
configuration summary.

**Likely causes:**

- `JWT_SECRET` is missing or shorter than 32 characters.
- `PUBLIC_API_BASE_URL` is missing or invalid in production.
- `KYC_PROVIDER_URL` and `KYC_PROVIDER_API_KEY` are only partially configured.
- A value is malformed (for example, bad numeric input or a non-URL value).

**Recovery:**

1. Inspect the redacted error output for the exact failing key.
2. Fix the environment value in the deployment manifest or secrets store.
3. Restart the process.

### 2. Admin config writes are rejected

**Symptom:** `POST /api/admin/config` returns a `400` with structured
`fieldErrors`.

**Likely causes:**

- The request body is missing `section` or `config`.
- The `section` is not one of the supported sections.
- The submitted values do not satisfy the section schema (for example, invalid
  enum values or out-of-range integers).

**Recovery:**

1. Verify the request body against the supported section names.
2. Align the payload with the schema and the expected types.
3. Retry the same request once the values are corrected.

### 3. Admin config writes are rate-limited

**Symptom:** `POST /api/admin/config` returns `429` with a `Retry-After` header.

**Likely causes:**

- The client is sending too many config updates in a short interval.
- A redeploy loop is repeatedly hitting the endpoint.

**Recovery:**

1. Wait for the rate-limit window to reset.
2. Confirm the deployment or automation is no longer hammering the endpoint.
3. Retry after the window expires.

### 4. Configuration is silently accepted in development but rejected in production

**Symptom:** the same env values pass locally but fail in production.

**Likely causes:**

- The app is running with `NODE_ENV=production` and the validator is enforcing
  stronger requirements.
- The value is acceptable in test/development but not in production.

**Recovery:**

1. Compare the runtime `NODE_ENV` value.
2. Ensure production-specific variables such as `PUBLIC_API_BASE_URL` are set
   correctly.
3. Re-run startup validation after the fix.

---

## Alerts and Monitoring

The configuration subsystem is mostly surfaced through startup failures and
request failures rather than dedicated Prometheus alerts.

Monitor for:

- Process exit during startup with a configuration-validation error.
- Repeated `400` responses from `POST /api/admin/config`.
- Repeated `429` responses from the admin config endpoint, especially during
  deployment automation.
- Unexpected log lines from the startup validation path describing malformed
  configuration values.

The most actionable signal is the redacted validation summary emitted by
[src/config/index.js](../src/config/index.js) during startup failures.

---

## Recovery Steps

### Restore a service after a startup validation failure

1. Read the redacted error output and identify the failing configuration key.
2. Correct the value in the deployment environment or secrets manager.
3. Restart the process.
4. Confirm the service reaches the listening state without exiting.

### Fix a rejected admin config payload

1. Confirm that the section name is one of the supported names returned by
   `GET /api/admin/config/sections`.
2. Verify that each field matches the target schema and that values are within
   the allowed ranges.
3. Retry the request once the payload is corrected.

### Recover from repeated rate limiting

1. Stop the repeated automation or deployment loop that is hitting the endpoint.
2. Wait for the `Retry-After` window to expire.
3. Re-run the update once the traffic has subsided.

### Validate the environment before deploy

Before deployment, confirm the following values are present and sane:

- `JWT_SECRET` is available and at least 32 characters.
- `PUBLIC_API_BASE_URL` is set in production and uses HTTPS.
- Any KYC provider settings are provided consistently.
- Numeric knobs such as `PORT` and `KYC_PROVIDER_TIMEOUT_MS` are valid numbers.

---

## Cross-References

- [src/config/index.js](../src/config/index.js) — centralized validator, defaults,
  and redacted startup-error logging.
- [src/index.js](../src/index.js) — startup validation gate and process exit
  behavior.
- [src/routes/adminConfig.js](../src/routes/adminConfig.js) — strict admin-only
  runtime config write endpoint.
- [src/schemas/config.js](../src/schemas/config.js) — section-specific schema
  definitions used by the admin config route.
- [docs/configuration.md](./configuration.md) — broader environment-variable
  inventory.
