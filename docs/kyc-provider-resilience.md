# KYC provider resilience contract

KYC verification is an idempotent read of provider state. The service uses a bounded timeout, a conservative retry classifier, and a circuit breaker owned by the KYC dependency. The breaker is not shared with Redis, Soroban, email, or any other upstream.

## Retry policy

Only transport failures and provider statuses that conventionally indicate a transient condition are retried: timeouts, connection resets/refusals, DNS retry signals, 408, 425, 429, and 5xx responses. Permanent 4xx responses, malformed JSON, bad response signatures, and invalid requests are not retried. The attempt count and delay bounds come from environment configuration but are clamped to safe limits. The shared retry helper adds ±20% jitter to avoid a synchronized retry storm.

The provider verification call is a safe read. Any future method that creates a provider-side case or otherwise has a non-idempotent effect must not reuse this retry policy without a provider idempotency key and an explicit safe-operation predicate.

## Circuit states

The per-KYC breaker starts `CLOSED`. Each exhausted transient call counts as one dependency failure; after the configured threshold it becomes `OPEN`. While open, calls fail before `fetch` is invoked. After the recovery timeout one request is allowed as a `HALF_OPEN` probe. A successful probe closes and resets the breaker; a failed probe reopens it.

The externally stable error is:

```json
{
  "code": "upstream_unavailable",
  "status": 503
}
```

The internal `CIRCUIT_OPEN` marker is never the application contract. `getKycStatus` may fall back to a persisted status, but it never turns an unavailable provider into an approval.

## Configuration

| Variable | Default | Safe bounds |
| --- | ---: | ---: |
| `KYC_PROVIDER_TIMEOUT_MS` | 5000 ms | 100–30000 |
| `KYC_PROVIDER_MAX_RETRIES` | 3 retries | 0–10 |
| `KYC_PROVIDER_BASE_DELAY_MS` | 200 ms | 0–10000 |
| `KYC_PROVIDER_MAX_DELAY_MS` | 5000 ms | 0–60000 |
| `KYC_PROVIDER_CB_FAILURE_THRESHOLD` | 5 calls | 1–100 |
| `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS` | 10000 ms | 100–60000 |

## Observability and safety

Breaker transitions emit the existing labelled Prometheus state-transition metric with `breaker_name=kyc`. `getKycProviderResilienceState()` returns only dependency name, state, failure count, and next probe time; credentials, URLs, request bodies, and provider response bodies are excluded. Logs contain a safe provider host and stable reason, never API keys or signing secrets.
