# Sliding-window rate limiting

Mutating endpoints, admin-token endpoints, and the internal cron trigger use an
in-process per-client sliding-window rate limiter (`src/middleware/rate-limit.js`).
This prevents brute-force attacks and request floods while keeping memory usage
strictly bounded.

## Protected routes

- **Invoices**: `POST /api/invoices`, `POST /api/invoices/:id/fund`, `POST /api/invoices/:id/settle`, `POST /api/invoices/:id/cancel`, `POST /api/invoices/:id/escrow`
- **Documents**: `POST /api/invoices/:id/document`
- **SMEs**: `POST /api/smes`, `POST /api/smes/:id/review`
- **Webhooks**: `POST /api/webhooks`, `DELETE /api/webhooks/:id`
- **Admin & Cron Guards**: `requireAdminToken` and `requireCronSecret` (`POST /api/internal/indexer/run`) enforce a separate, stricter IP-keyed bucket for failed authentication attempts.

## Identity

For mutating routes, the middleware gives a presented API key (`Authorization: Bearer <key>` or `X-API-Key: <key>`) priority over the client IP. API keys are hashed with SHA-256 before they become map keys (`mutating:apikey:<sha256hex>`), so raw secrets never appear in limiter state, logs, or diagnostic output.

Requests without an API key use `req.ip`, falling back to `req.socket.remoteAddress` (`mutating:ip:<ip>`). Two different API keys therefore retain independent budgets even when they share a NAT address, while anonymous requests from one IP share one budget.

For failed admin/cron authentication attempts, the stricter bucket is keyed strictly by IP (`admin-auth-fail:ip:<ip>`) so rotating invalid tokens cannot bypass brute-force protection.

## Sliding-window algorithm

Each tracked client has a constant-size record with four numeric fields:

```text
currentWindowStart, currentCount,
previousWindowStart, previousCount
```

The current counter covers one configured window. The immediately previous
counter is weighted by the remaining fraction of the current window:

```text
estimated = currentCount + previousCount * (1 - elapsed / windowMs)
```

A request is allowed only when `estimated < max`. On success, `currentCount` is
incremented synchronously. A rejected request does not mutate counters.

### Bounded memory and eviction

The store caps the number of tracked client identities at `RATE_LIMIT_MAX_CLIENTS`.
When a new client arrives at capacity:

1. Expired records (where both current and previous windows have elapsed) are pruned.
2. If still at capacity, the least-recently-active client is evicted (LRU).

## HTTP contract

Allowed and rejected requests expose:

- `RateLimit-Limit`: the configured maximum;
- `RateLimit-Remaining`: conservative whole-request capacity remaining;
- `RateLimit-Reset`: seconds until capacity is released.

An exceeded request returns status `429`, `Content-Type: application/problem+json`,
a positive `Retry-After` header (in seconds), and an RFC 7807 problem body:

```json
{
  "type": "https://liquifact-backend.vercel.app/errors/RATE_LIMIT_EXCEEDED",
  "title": "Too Many Requests",
  "status": 429,
  "code": "RATE_LIMIT_EXCEEDED",
  "instance": "/api/invoices",
  "detail": "Rate limit exceeded. Maximum 60 requests per 60 seconds.",
  "retryAfter": 60,
  "error": "Too Many Requests"
}
```

## Configuration

All rate-limit settings are validated at startup in `src/config.js` (invalid values
throw `ConfigError`):

| Environment variable              | Default  | Bounds            | Purpose                                              |
| --------------------------------- | -------- | ----------------- | ---------------------------------------------------- |
| `RATE_LIMIT_WINDOW_MS`            | `60000`  | `1` – `86400000`  | Sliding-window duration (ms) for mutating routes     |
| `RATE_LIMIT_MAX`                  | `60`     | `1` – `1000000`   | Max requests per window per client                   |
| `RATE_LIMIT_MAX_CLIENTS`          | `10000`  | `1` – `1000000`   | Maximum tracked client entries before eviction       |
| `ADMIN_AUTH_RATE_LIMIT_WINDOW_MS` | `60000`  | `1` – `86400000`  | Sliding-window duration (ms) for failed admin auth   |
| `ADMIN_AUTH_RATE_LIMIT_MAX`       | `10`     | `1` – `1000000`   | Max failed admin/cron auth attempts per window per IP |

## Failure and boundary guarantees

- Counter check and increment are synchronous in one Node event loop turn.
- A process restart clears the in-memory map. For horizontally scaled deployments,
  enforce a shared edge quota or plug in a distributed store.
- The `prune()` and `reset()` hooks are exposed on limiter middleware instances
  for deterministic lifecycle management and tests.
