# KYC Webhooks Operations Runbook

Operator runbook for the LiquiFact backend KYC webhook subsystem. This document covers configuration, common failure modes, alerting signals, and the recovery steps for the inbound webhook path at [src/routes/kyc.js](../src/routes/kyc.js), the provider transport logic in [src/services/kycService.js](../src/services/kycService.js), and the shared signature helpers in [src/services/webhooks.js](../src/services/webhooks.js).

---

## Architecture Overview

The KYC webhook flow is intentionally fail-closed:

```text
Provider -> POST /api/kyc/webhook
           |
           +-> authenticateToken
           +-> extractTenant
           +-> verifySignature
           +-> parse + validate payload
           +-> normalizeProviderStatus
           +-> persistKycRecord
```

Key behaviors:

- Requests must present a valid bearer token and a resolved tenant context.
- The incoming `X-Signature` header must verify against the configured provider secret.
- Unknown or unmapped provider statuses are rejected rather than silently persisted as `unknown`.
- Status writes invalidate the short-lived KYC status cache so a later revocation cannot be superseded by stale cache state.

---

## Configuration

All relevant settings are read from the process environment.

| Variable | Default | Purpose |
|----------|---------|---------|
| `KYC_PROVIDER_API_KEY` | unset | Enables the external provider path when paired with `KYC_PROVIDER_URL`. |
| `KYC_PROVIDER_URL` | unset | Base URL for the external KYC provider verification endpoint. |
| `KYC_PROVIDER_SECRET` | unset | Shared secret used to verify inbound webhook signatures and, optionally, outbound response signatures. |
| `KYC_PROVIDER_TIMEOUT_MS` | `5000` | Per-request timeout for outbound provider calls; clamped to `[100, 30000]`. |
| `KYC_PROVIDER_MAX_RETRIES` | `3` | Retry budget for transient provider failures; clamped to `[0, 10]`. |
| `KYC_PROVIDER_BASE_DELAY_MS` | `200` | Initial retry backoff in milliseconds. |
| `KYC_PROVIDER_MAX_DELAY_MS` | `5000` | Maximum retry backoff in milliseconds. |
| `KYC_PROVIDER_SIGN_REQUESTS` | `false` | When `true`, signs outbound requests with the same HMAC header format used by the inbound webhook route. |
| `KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE` | `false` | When `true`, requires a valid response signature header from the provider. |
| `KYC_PROVIDER_CB_FAILURE_THRESHOLD` | `5` | Number of consecutive provider failures before the KYC circuit breaker opens. |
| `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS` | `10000` | Time the breaker stays open before attempting recovery. |
| `KYC_STATUS_CACHE_TTL_SECONDS` | `30` | TTL for cached external KYC status lookups; `0` or invalid values disable caching. |
| `JWT_SECRET` | test/dev fallback | Required for JWT validation on the webhook route outside test/dev. |

### Operational checklist

1. Ensure `KYC_PROVIDER_API_KEY` and `KYC_PROVIDER_URL` are set together.
2. Ensure `KYC_PROVIDER_SECRET` matches the provider’s webhook signing secret.
3. Validate that the provider’s expected status values are covered by the provider-status mapping in [src/services/kycService.js](../src/services/kycService.js).
4. Confirm the auth secret and tenant context source are available for the calling system.

---

## Failure Modes

### 1. Webhook is rejected with 401 "Missing X-Signature header"

**Symptom:** provider sends a payload, but the backend responds `401`.

**Likely cause:** the upstream provider is not sending the expected `X-Signature` header or the signature was generated with a different secret.

**Check:**

- Confirm the provider is using the same shared secret configured as `KYC_PROVIDER_SECRET`.
- Confirm the raw request body is exactly what the provider signed.
- Compare the provider-side signature generation with the implementation in [src/services/webhooks.js](../src/services/webhooks.js).

**Recovery:** update the shared secret or fix the provider configuration. Do not relax the signature check in code.

### 2. Webhook is rejected with 401 "Invalid webhook signature"

**Symptom:** the route accepts the header but rejects it as invalid.

**Likely cause:** timestamp tolerance exceeded, wrong signing secret, or body mismatch.

**Check:**

- Verify the clock skew between the provider and the backend is within the tolerance used by the signature verifier.
- Verify that the provider is hashing the exact raw body bytes.
- Check for newline or serialization differences (for example, the provider sending a different JSON formatting than the backend receives).

**Recovery:** correct the provider-side signing implementation or rotate the shared secret and update both sides together.

### 3. Webhook is rejected with 400 "Unknown provider status"

**Symptom:** requests fail with `400` and the log includes the fail-closed unknown-status warning.

**Likely cause:** the provider is sending a status that is not covered by the status map in [src/services/kycService.js](../src/services/kycService.js).

**Check:**

- Inspect the provider payload for the incoming status value.
- Add the new provider status to the mapping if it is legitimate.
- If the provider is sending a temporary or invalid value, investigate upstream data quality before allowing it through.

**Recovery:** patch the mapping or correct the upstream payload; do not alter the fail-closed behavior.

### 4. Webhook is rejected with 400/403 for tenant mismatch

**Symptom:** the request reaches the route but returns `400` or `403` for tenant context or scope mismatch.

**Likely cause:** the caller is missing tenant context or sending a `tenantId` payload value that does not match the authenticated tenant.

**Check:**

- Confirm the caller sends a valid JWT with a `tenantId` claim or the `x-tenant-id` header.
- Confirm the payload tenant field (if present) matches the authenticated tenant.

**Recovery:** fix the calling service’s auth/tenant headers before retrying.

### 5. Provider is unavailable or timing out

**Symptom:** outbound KYC status lookups fail, and the service falls back to the persisted record or a pending status.

**Likely cause:** provider outage, misconfigured URL, TLS issue, or a network failure.

**Check:**

- Review the logs for `External KYC provider call failed` and the provider host.
- Inspect whether the KYC circuit breaker has opened.
- Check the provider endpoint and credentials.

**Recovery:**

1. Restore provider connectivity or fix the URL/API key.
2. If the breaker is open, wait for the recovery timeout or reset it deliberately after the upstream fix is confirmed.
3. Re-run the affected KYC check after the provider is healthy.

### 6. Circuit breaker is open

**Symptom:** the service fails fast with `CIRCUIT_OPEN` or a breaker-open error, and new provider calls stop immediately.

**Likely cause:** repeated transient failures exceeded the configured failure threshold.

**Check:**

- Review the breaker state in logs and metrics.
- Confirm the provider is healthy before clearing the breaker.

**Recovery:** after the upstream issue is resolved, allow the breaker to transition back or reset it deliberately from a maintenance window.

---

## Alerts and Signals

Watch for the following signals in logs and metrics:

| Signal | Meaning |
|--------|---------|
| `KYC webhook secret is not configured` | Inbound webhook ingestion is disabled because the secret is missing. |
| `Invalid KYC webhook signature` | Provider signing is failing or the payload/body has changed unexpectedly. |
| `KYC webhook received status outside PROVIDER_STATUS_MAP` | The provider is sending an unmapped status; investigate the mapping or upstream payload. |
| `External KYC provider call failed` | Provider transport is failing; inspect retry/circuit-breaker behavior. |
| Circuit breaker transition to `OPEN` | The provider dependency is failing repeatedly and the service is intentionally failing fast. |

The KYC circuit breaker is implemented in [src/utils/circuitBreaker.js](../src/utils/circuitBreaker.js) and used by the provider transport logic in [src/services/kycService.js](../src/services/kycService.js).

---

## Recovery Steps

### Restore inbound webhook ingestion

1. Confirm `KYC_PROVIDER_SECRET` is set correctly.
2. Confirm the provider is using the same secret and sending the raw body bytes that are being verified.
3. Confirm the caller is sending a valid bearer token and tenant context.
4. Retry the webhook after the fix is applied.

### Recover from a provider outage

1. Confirm the provider endpoint and credentials are correct.
2. Verify whether the service is in fallback mode due to missing provider availability.
3. If the breaker is open, wait for the recovery window or reset it after confirming the provider is healthy.
4. Retry the affected SME KYC lookup or webhook ingestion after the provider recovers.

### Add support for a new provider status

1. Identify the new status value from provider logs or payload samples.
2. Update the provider-to-internal mapping in [src/services/kycService.js](../src/services/kycService.js).
3. Re-run the relevant KYC tests and verify that the new status is handled as expected.
4. Re-test a real webhook payload to confirm it is no longer rejected as unknown.

---

## Cross-References

- [src/routes/kyc.js](../src/routes/kyc.js) — inbound webhook route and request validation.
- [src/services/kycService.js](../src/services/kycService.js) — provider config, status normalization, persistence, and circuit-breaker behavior.
- [src/services/webhooks.js](../src/services/webhooks.js) — signature creation and verification helpers.
- [src/utils/circuitBreaker.js](../src/utils/circuitBreaker.js) — breaker state machine and recovery semantics.
- [docs/configuration.md](./configuration.md) — full environment-variable reference.
