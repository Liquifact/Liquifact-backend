# Persistence endpoint rate limiting

Persistence writes use a per-client sliding-window limiter. The limiter is
implemented in-process and is intended to prevent abuse and accidental local
overload while keeping the existing persistence API response contract stable.

## Identity

The middleware gives an authenticated API key priority over the client IP. API
keys are hashed with SHA-256 before they become map keys, so the live secret
never appears in limiter state, logs, or diagnostic output. The key is
namespaced with `persistence:apikey:` to prevent collisions with IP identities.

Requests without an API key use `req.ip`, falling back to the socket address.
Applications behind a proxy must configure Express trust boundaries correctly;
the limiter does not independently trust arbitrary forwarded headers. Two
different API keys therefore retain separate budgets even when they share a
NAT address, while anonymous requests from one client share one budget.

## Sliding-window algorithm

Each client has a bounded record with four numeric fields:

```text
currentWindowStart, currentCount,
previousWindowStart, previousCount
```

The current counter covers one configured window. The immediately previous
counter is weighted by the remaining fraction of that window:

```text
estimated = currentCount + previousCount * (1 - elapsed / windowMs)
```

The request is allowed only when the estimate is below the configured maximum.
On success, the current counter is incremented synchronously. A rejected
request does not change either counter. This removes the fixed-window edge
burst where a caller could spend a complete quota just before and after a
boundary.

The old implementation delegated to `express-rate-limit`'s fixed-window
store. The new implementation stores constant-size state per identity and
does not retain one timestamp for every request. Idle records are removed
lazily after both counter windows expire. A process restart clears the map,
which is the documented behavior for the in-memory implementation.

## HTTP contract

Allowed and rejected requests expose:

- `RateLimit-Limit`: the configured maximum;
- `RateLimit-Remaining`: conservative whole-request capacity;
- `RateLimit-Reset`: seconds until capacity is released.

An exceeded request returns status `429`, `Retry-After`, and the existing
legacy fields alongside the stable structured marker:

```json
{
  "error": "Too Many Requests",
  "type": "rate_limited",
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded. Maximum 10 requests per 60 seconds.",
  "retryAfter": 60
}
```

Keeping `error` and `code` avoids breaking clients that already consume the
persistence middleware response. New clients can use `type: rate_limited` as
the stable category without parsing the message text. Retry values are always
positive and are repeated in the `Retry-After` header.

## Configuration

`PERSISTENCE_RATE_LIMIT_WINDOW_MS` controls the window duration and defaults to
60,000 milliseconds. `PERSISTENCE_RATE_LIMIT_MAX_REQUESTS` controls the quota
and defaults to 10. Invalid, zero, fractional, negative, or oversized values
fall back to those safe defaults. The accepted maximum window is 24 hours and
the maximum request count is one million, preventing accidental unbounded
memory or retry behavior from a malformed environment setting.

The configuration is read when a limiter is created, matching the existing
middleware factory behavior. The factory accepts the historical Redis-client
argument for source compatibility; this issue intentionally keeps the active
implementation in memory. A future distributed adapter must preserve the same
atomic decision, two-counter semantics, hashed identity, and response fields.

## Failure and boundary guarantees

The counter check and increment are synchronous in one Node event loop turn.
Competing requests in the same process cannot both observe the same available
slot and then overrun the limit. A process-local map cannot provide a global
guarantee across workers, so a horizontally scaled deployment should enforce a
shared edge quota or provide an atomic shared store before treating this as a
tenant-wide limit.

At a window boundary, the previous count starts with full weight and decays
continuously. At the end of the next window, the old count is discarded. This
makes the boundary behavior deterministic and avoids a sudden double budget.
The `prune` hook is exposed on the returned limiter for controlled lifecycle
maintenance and deterministic tests; normal requests also prune stale records
before deciding.

## Verification matrix

The unit and integration suites cover:

| Scenario                 | Expected result                           |
| ------------------------ | ----------------------------------------- |
| Under-limit requests     | 2xx/201 with correct remaining header     |
| Exact limit              | Next request is 429 with structured error |
| End/start boundary burst | Previous pressure remains weighted        |
| Previous-window decay    | Capacity returns gradually                |
| Full expiry              | New request starts a clean bounded record |
| Two API keys             | Independent per-tenant budgets            |
| Anonymous clients        | IP-scoped budget                          |
| API-key identity         | Secret is hashed and never stored raw     |
| Invalid configuration    | Safe bounded defaults                     |
| Repeated rejection       | No counter or map growth                  |
| Custom store             | Caller can inspect or manage lifecycle    |

## Compatibility and rollback

The middleware factory name, optional argument, environment variables, key
precedence, 429 status, legacy error fields, and `Retry-After` behavior remain
compatible. The internal map shape is new and exists only in process memory,
so there is no database migration. Rolling back to the previous release is
safe after restarting the process, which clears the compact records.

This change is deliberately limited to persistence rate limiting. It does not
alter unrelated global, KYC, Redis, queue, invoice, or webhook rate-limit
policies. Those controls may have different operational scopes and should be
migrated separately if they need the same sliding-window semantics.
