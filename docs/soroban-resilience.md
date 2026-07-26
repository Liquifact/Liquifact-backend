# Soroban RPC Resilience & Retry Budget Documentation

This document outlines the resilience architecture, retry budget policies, circuit breaker integration, and observability metrics for Soroban RPC operations in LiquiFact backend services.

---

## Overview

All Soroban contract interactions are wrapped using the resilience wrapper in [`src/services/soroban.js`](../src/services/soroban.js). The wrapper provides:
1. **Exponential Backoff with Jitter**: Prevents thundering-herd issues against Soroban RPC nodes during transient network degradation.
2. **Cumulative Elapsed-Time Budget (`maxElapsedMs`)**: Enforces a strict time budget across all retry attempts so slow retries do not exceed HTTP caller timeouts.
3. **Circuit Breaker Integration**: Fails fast during sustained network or node outages to protect upstream callers and prevent resource exhaustion.
4. **Bounded Prometheus Observability**: Emits metrics for latency, retry causes, and budget exhaustion with bounded cardinality labels.

---

## Retries & Cumulative Time Budget (`maxElapsedMs`)

### Execution Flow

When an operation is executed via `callSorobanContract(operation, config)` or `withRetry(operation, config)`:

```
[Start callSorobanContract]
       │
       ▼
[Circuit Breaker Execution] ──► (Breaker OPEN?) ──► Throw CircuitOpen Error
       │
       ▼ (Breaker CLOSED / HALF_OPEN)
[withRetry loop - Attempt 0]
       │
       ├──► Operation Succeeded? ──► Return result
       │
       └──► Operation Threw Error:
                │
                ├──► Permanent / Non-retryable error? ──► Surface error immediately
                │
                ├──► Attempt limit reached (attempt == maxRetries)? ──► Surface error
                │
                ├──► Cumulative elapsed time >= maxElapsedMs?
                │        │
                │        ├──► Increment soroban_retry_budget_exhausted_total
                │        └──► Surface last user-safe error immediately
                │
                └──► Compute backoff delay (exponential + ±20% jitter)
                         │
                         ├──► Increment soroban_rpc_retry_causes_total{cause}
                         ├──► Sleep for delay
                         └──► Loop to Attempt N+1
```

### Configuration Environment Variables

| Variable | Type | Default | Hard Security Cap | Description |
|---|---|---|---|---|
| `SOROBAN_MAX_RETRIES` | integer | `3` | `10` | Maximum number of retry attempts per call. |
| `SOROBAN_BASE_DELAY` | ms | `200` | `10 000` | Initial exponential backoff delay. |
| `SOROBAN_MAX_DELAY` | ms | `5000` | `60 000` | Maximum delay ceiling per backoff step. |
| `SOROBAN_MAX_ELAPSED_MS` | ms | `10000` | `120 000` | Cumulative elapsed-time budget for all attempts. |

---

## Circuit Breaker Behavior

A shared circuit breaker instance (`sharedBreaker`) protects all Soroban RPC calls:
- **Failure Threshold**: Default `5` consecutive failures trip the breaker to `OPEN`.
- **Recovery Timeout**: Default `10000` ms (10 seconds) before attempting a single probe in `HALF_OPEN` state.
- **Fail-Fast**: While `OPEN`, calls fail fast with `CIRCUIT_OPEN` error code without attempting network requests.

---

## Observability & Prometheus Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `soroban_rpc_call_duration_seconds` | Histogram | `method`, `outcome` | Latency of Soroban RPC calls in seconds. `outcome` is `success`, `error`, or `circuit_open`. |
| `soroban_rpc_retry_causes_total` | Counter | `cause` | Number of retries triggered by transient causes (`429`, `5xx`, `timeout`). |
| `soroban_retry_budget_exhausted_total` | Counter | *(none)* | Total number of retry loops aborted due to cumulative time budget exhaustion. |
| `soroban_circuit_breaker_state_transitions_total` | Counter | `breaker_name`, `from_state`, `to_state` | Circuit breaker state transitions (`CLOSED` ↔ `OPEN` ↔ `HALF_OPEN`). |

---

## Security Considerations

1. **User-Safe Error Surfacing**: When retries abort due to budget exhaustion or non-retryable status, the original error (such as status `503` or `429`) is surfaced directly. Internal stack traces or raw node secrets are never exposed.
2. **Multi-word Pattern Matching**: Message pattern classification uses strict multi-word regexes to prevent message-injection attacks where user-controlled input (e.g. account names) could force illegal retries.
3. **Cardinality Bounding**: All Prometheus metric labels (`method`, `cause`, `outcome`) are strictly normalized against bounded enums.
