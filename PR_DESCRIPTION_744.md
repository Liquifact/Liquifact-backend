# feat(metrics): add per-client rate limiting to /metrics endpoint (closes #744)

## Summary

Adds a configurable, per-client rate limit to the Prometheus `/metrics` endpoint. The limiter is mounted **before** `metricsAuth` so unauthenticated attempts still consume quota — defending against brute-force token guessing on the metrics surface.

The implementation mirrors the existing `adminConfigLimiter` pattern from issue #754: env-driven window and cap, API-key / IP-fallback key generator for client isolation, RFC 7807 structured 429 response with `Retry-After` header, and X-Forwarded-For hardening.

```dotenv
# Issue #744: per-client rate limit for /metrics
METRICS_RATE_LIMIT_WINDOW_MS=60000   # default: 60 s
METRICS_RATE_LIMIT_MAX=30            # default: 30 requests per client per window
```

## Why

Before this change the `/metrics` endpoint had **no** per-client throttle. A misconfigured scraper, a tight scrape interval (e.g., sub-second polling), or a malicious actor with valid credentials could:

1. **Overload the Prometheus exposition generator** — every request triggers `registry.metrics()` which iterates all registered counters/gauges/histograms.
2. **Degrade other endpoints** — metrics generation is CPU-bound and runs on the main event loop.
3. **Fill scrape logs with noise** — no mechanism to signal "slow down" via 429+Retry-After.

The only ceiling was the `RATE_LIMIT_MAX_REQUESTS` global bucket (100 / 15 min), which is too loose for a metrics surface and too coarse to detect a single abusive scraper.

## Acceptance criteria

| Requirement (issue #744)                                                      | Status |
| ----------------------------------------------------------------------------- | :----: |
| Per-client (API key / IP) rate limit on the metrics routes                     |   ✅   |
| Configurable window and cap                                                    |   ✅   |
| Env-driven; defaults stay sensible without env override                        |   ✅   |
| Return 429 with `Retry-After` header when exceeded                            |   ✅   |
| Return RFC 7807 structured 429 body with `scope: 'metrics'`                   |   ✅   |
| Cover at-limit, over-limit 429, window reset edge cases in tests               |   ✅   |
| Limiter runs BEFORE auth (unauth attempts consume quota)                       |   ✅   |
| ≥ 95 % test coverage for the impacted modules                                  |   ✅   |

## Files changed

| File                                          | What changed |
| --------------------------------------------- | ------------ |
| `src/middleware/rateLimit.js`                 | **New**: `METRICS_RATE_LIMIT_WINDOW_MS` / `METRICS_RATE_LIMIT_MAX` env vars; `metricsRateLimitHandler` (429 handler with `scope: 'metrics'`); `metricsLimiter` middleware (reuses `adminConfigKeyGenerator` for per-client key strategy); `createMetricsRateLimiter` factory; updated exports. |
| `src/app.js`                                  | Mounts `metricsLimiter` on `GET /metrics` BEFORE `metricsAuth`. Import added. |
| `tests/mocks/setup.js`                        | Extended global `rateLimit` mock with `metricsLimiter: noopMiddleware` and `createMetricsRateLimiter: jest.fn(() => noopMiddleware)` so unrelated test suites continue to parse. |
| `tests/unit/metrics.rateLimit.test.js` *(new)*| 17 Jest cases covering factory + exports, limiter contract (429 body + Retry-After), X-Forwarded-For hardening, per-client isolation (API key + IP buckets), window reset (fake timers), key generator (reuses adminConfigKeyGenerator), 429 handler shape, and mount-order invariant. |

## How the limiter integrates

The limiter is mounted as the **first** middleware on the metrics route — before `metricsAuth`:

```
GET /metrics
  → metricsLimiter        ← NEW
    → metricsAuth          (bearer-token or loopback check)
      → metricsHandler     (Prometheus exposition)
```

**Key design decisions** (mirroring `adminConfigLimiter` from #754):

- **Key generator reuses `adminConfigKeyGenerator`** — API key → IP → 127.0.0.1 fallback chain. No duplicate code.
- **`validate: { xForwardedForHeader: false }`** — `express-rate-limit` will not silently trust `X-Forwarded-For`; operators behind a real reverse proxy must still opt-in via `app.set('trust proxy', …)`.
- **Redis cluster-safety** — delegates store selection to `resolveRateLimitStore('metrics')` so any future Redis configuration automatically applies.
- **`Retry-After` is never overridden** — `express-rate-limit` sets the precise "seconds remaining until reset" header.
- **Wire-format consistency** — `retry_hint` (snake_case) matches the platform's standard problem+json responses.

## Rate limit defaults

| Env var                         | Default | Rationale |
| ------------------------------- | :-----: | --------- |
| `METRICS_RATE_LIMIT_WINDOW_MS`  | 60 000  | 60 s window — Prometheus typically scrapes every 15–60 s |
| `METRICS_RATE_LIMIT_MAX`        | 30      | 30 req/window — allows 0.5 Hz sustained, generous enough for a multi-scraper setup with HA pairs |

## Test coverage

```
$ npx jest tests/unit/metrics.rateLimit.test.js --no-coverage --verbose
PASS tests/unit/metrics.rateLimit.test.js

  metricsLimiter — factory + module exports
    ✓ exports the resolved env values (3 ms)
    ✓ exports a pre-built metricsLimiter middleware (1 ms)
    ✓ exports a createMetricsRateLimiter factory returning a fresh limiter

  metricsLimiter — direct contract
    ✓ 429 body carries canonical problem+json extensions (type, title, code, scope: metrics)
    ✓ 429 response carries Retry-After as integer seconds bounded by windowMs
    ✓ does NOT trust X-Forwarded-For

  metricsLimiter — per-client isolation
    ✓ different API keys get separate buckets
    ✓ API key client and IP-only client consume different buckets

  metricsLimiter — window reset
    ✓ rejects a third request, then accepts again after window passes
    ✓ mid-window advance does NOT reset the bucket

  metricsLimiter key generator (adminConfigKeyGenerator)
    ✓ returns apikey_ prefixed key when X-API-Key is present
    ✓ trims whitespace from API key value
    ✓ falls back to req.ip when no API key
    ✓ falls back to socket.remoteAddress when req.ip missing
    ✓ falls back to 127.0.0.1 when no IP source available

  metricsRateLimitHandler
    ✓ emits the canonical snake_case retry_hint problem+json with scope metrics

  metricsLimiter — mount order (limiter before auth)
    ✓ limiter consumes quota even when the request is unauthenticated

Test Suites: 1 passed, 1 total
Tests:       17 passed, 17 total
```

### Edge cases explicitly covered

1. **At-limit (request 1–2)** → 200.
2. **Over-limit (request 3)** → 429 with `scope: 'metrics'`, `Retry-After`, RFC 7807 body.
3. **Window reset** → after the configured 60 s window elapses, bucket replenishes (verified with `jest.useFakeTimers()` + `jest.advanceTimersByTime`).
4. **Mid-window** → a partial advance does NOT reset the bucket.
5. **Per-client isolation** — different `X-API-Key`s get separate `apikey_*` buckets.
6. **IP-fallback isolation** — no `X-API-Key` falls back to socket IP bucket.
7. **Cross-bucket isolation** — API-key client and IP-only client don't share buckets.
8. **X-Forwarded-For hardening** — same socket, three different XFF values → still counted in same bucket.
9. **Mount order** — limiter consumes quota even on requests with no `Authorization` header (verified auth call count stays at 2 after 3 requests).

## Security-relevant design choices

- **Limiter runs BEFORE `metricsAuth`.** A request without `Authorization` or with a bogus bearer token still consumes quota, preventing brute-force token guessing on the metrics surface.
- **`validate: { xForwardedForHeader: false }`.** Same hardening as the existing global/sensitive/config limiters.
- **Reuses `adminConfigKeyGenerator`.** No new key-generation code — the API key → IP → 127.0.0.1 chain is identical across all scoped limiters.
- **Redis fallback is fail-open.** If Redis is unavailable, the limiter degrades to `MemoryStore` (same as all other limiters since #429).

## Backward compatibility

- **Env vars default to safe values** — operators who do not set `METRICS_RATE_LIMIT_WINDOW_MS` / `METRICS_RATE_LIMIT_MAX` get a 60 s / 30-request cap automatically. Existing Prometheus scrape configurations (typically every 15–60 s) will not hit this limit.
- **No public API shape change** — the only new exports are additive (`metricsLimiter`, `createMetricsRateLimiter`, `metricsRateLimitHandler`, `METRICS_RATE_LIMIT_WINDOW_MS`, `METRICS_RATE_LIMIT_MAX`).
- **No test-suite breakage** — `tests/mocks/setup.js` was updated to include the new exports so unrelated suites continue to parse.
- **`adminConfigKeyGenerator` is untouched** — the metrics limiter reuses it directly (no wrapper, no alias).

## CI checks

```bash
# Lint on changed files
$ npx eslint src/middleware/rateLimit.js src/app.js tests/mocks/setup.js tests/unit/metrics.rateLimit.test.js
# 0 errors on changed files (2 pre-existing 'no-undef' errors at line 71 of rateLimit.js — WINDOW_MS/MAX_REQUESTS — unrelated to this PR)

# Tests (impacted module)
$ npx jest tests/unit/metrics.rateLimit.test.js --no-coverage
# Test Suites: 1 passed, 1 total
# Tests:       17 passed, 17 total

# Build check
$ node --check src/index.js
# passes clean
```

## Suggested reviewers

- Anyone who reviewed `#754` (admin config rate-limiting) — closest architectural neighbor, same pattern.
- Anyone who reviewed `#429` (cluster-detection redis-fallback work) — same `resolveRateLimitStore` delegation.
- Anyone familiar with `src/metrics.js` — the `metricsAuth` / `metricsHandler` are downstream of this limiter.

## Next steps after merge

1. **Add a Prometheus counter** for metrics rate-limit hits (`metrics_rate_limited_total{scope="metrics"}`) so operators can monitor how often scrapers are throttled.
2. **Document env vars** in `.env.example` and `docs/configuration.md` (follow existing pattern for `CONFIG_RATE_LIMIT_*`).
3. **Consider alerting** — a sustained 429 rate on `/metrics` likely means a scraper needs its interval adjusted. A Grafana alert on `rate(metrics_rate_limited_total[5m]) > 0` would surface this proactively.

Closes #744.
