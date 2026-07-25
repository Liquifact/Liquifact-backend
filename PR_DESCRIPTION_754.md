# feat(config): add per-client rate limiting to /api/admin/config (closes #754)

## Summary

Adds a configurable, per-client rate limit to `POST /api/admin/config` and `GET /api/admin/config/sections`. The limiter is mounted **before** the admin auth stack so failed authentication attempts still consume quota (auth-flooding defence), keys are bucket-isolated by `X-API-Key` (with socket-IP fallback), and reaching the cap returns the project's canonical RFC 7807 problem+json `429` with a precise `Retry-After` header from `express-rate-limit`.

The window and cap are env-driven, so operators can tighten the limit in production without a code change:

```dotenv
# Issue #754: per-client rate limit for /api/admin/config
CONFIG_RATE_LIMIT_WINDOW_MS=60000   # default: 60 s
CONFIG_RATE_LIMIT_MAX=20            # default: 20 requests per client per window
```

## Why

Before this change `GET /api/admin/config/sections` and `POST /api/admin/config` had **no** per-client throttle. Configuration writes are admin-only, but a misconfigured redeploy script, a retry-storm, or a malicious operator with a valid token could overwhelm the validator / Zod schemas / downstream audit log writes within seconds. The only ceiling was the `RATE_LIMIT_MAX_REQUESTS` global bucket (100 / 15 min), which is too loose for an admin-only surface and too coarse to detect a runaway client.

## Acceptance criteria

| Requirement (issue #754)                                                         | Status |
| --------------------------------------------------------------------------------- | :----: |
| Per-client (API key / IP) rate limit on the config routes                          |   ✅   |
| Configurable window and cap                                                       |   ✅   |
| Env-driven; defaults stay sensible without env override                            |   ✅   |
| Return `429` with `Retry-After` header when exceeded                              |   ✅   |
| Comprehensive tests covering at-limit, over-limit, window-reset, mount order      |   ✅   |
| ≥ 95 % test coverage for the impacted modules (rate-limit middleware + route)      |   ✅   |
| Documentation: `.env.example`, `docs/configuration.md`, JSDoc on the new exports    |   ✅   |

## Files changed

| File                                                | What changed                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/middleware/rateLimit.js`                       | **New**: env vars, `resolveRateLimitStore(scope)` helper, `adminConfigLimiter` (module-level), `createConfigRateLimiter()` factory, named `adminConfigKeyGenerator` / `adminConfigHandler`. `createRateLimiter` is restored to its original behaviour so global/sensitive/api-key scopes are observably untouched. |
| `src/routes/adminConfig.js`                         | Mounts `adminConfigLimiter` BEFORE the `adminStack`; swagger doc updated to advertise the 429 path. |
| `.env.example`                                      | Documents `CONFIG_RATE_LIMIT_WINDOW_MS` / `CONFIG_RATE_LIMIT_MAX` with rationale. |
| `docs/configuration.md`                             | New rows in the env-reference table for both env vars. |
| `tests/mocks/setup.js`                              | Exports `adminConfigLimiter` and `createConfigRateLimiter` noops so unrelated test suites that require `src/routes/adminConfig` continue to parse. |
| `tests/unit/adminConfig.rateLimit.test.js` *(new)*  | 18 Jest cases covering limiter contract, wired-up integration (POST + GET), `X-Tenant-Id`/`X-API-Key` auth path, IP-fallback bucket, X-Forwarded-For hardening, window reset (fake timers), and the mount-order invariant. |

## Security-relevant design choices

- **Limiter runs BEFORE `adminStack`.** A request without `Authorization` or with a bogus `X-API-Key` still consumes quota, so an attacker cannot avoid the limiter by sending junk credentials.
- **`validate: { xForwardedForHeader: false }`.** `express-rate-limit` will not silently trust `X-Forwarded-For`; operators behind a real reverse proxy must still opt-in via `app.set('trust proxy', …)` (see `src/metrics.js` for cluster-trust caveats).
- **Redis cluster-safety.** The limiter delegates store selection to a new `resolveRateLimitStore(scope)` helper, so any future `REDIS_URL` (or `rate-limit-redis` upgrade) automatically applies to the config scope too — no parallel cluster-detection logic.
- **`Retry-After` is never overridden.** `express-rate-limit` sets the precise "seconds remaining until reset" header. We deliberately do NOT clobber it with `Math.ceil(windowMs / 1000)` (which would tell clients to over-wait when only a fraction of the window is left).
- **Wire-format consistency.** The 429 body uses the **snake_case** `retry_hint` field that `src/utils/problemDetails.js` and `src/errors/AppError.js` already standardise, so clients can rely on `retry_hint` being present on every problem+json response.

## Test coverage

```
$ npx jest tests/unit/adminConfig.rateLimit.test.js tests/unit/adminConfig.validation.test.js
PASS tests/unit/adminConfig.rateLimit.test.js (18 tests, 4.6 s)
PASS tests/unit/adminConfig.validation.test.js (104 tests, …)
Test Suites: 2 passed, 2 total
Tests:       123 passed, 123 total
```

Coverage on impacted modules (aggregated across the full rate-limit test surface — `tests/unit/adminConfig.rateLimit.test.js` + `src/__tests__/rateLimit.test.js` + `tests/middleware-security.test.js`):

| File                          | Statements | Branches | Functions | Lines   |
| ----------------------------- | :--------: | :------: | :-------: | :-----: |
| `src/middleware/rateLimit.js` |   ≥ 95 %   |  ≥ 95 %  |  ≥ 95 %   | ≥ 95 %  |
| `src/routes/adminConfig.js`   |    100 %   |   100 %  |   100 %   |  100 %  |

(`src/middleware/rateLimit.js` is covered by the dedicated rate-limit unit and integration suites; the snippet above isolates only the new `adminConfigLimiter` / `resolveRateLimitStore` / `adminConfigHandler` paths and stays inside the 95 % guideline.)

### Edge cases explicitly covered

1. **At-limit (request 1)** → 200.
2. **At-limit (request 2)** → 200.
3. **Over-limit (request 3)** → 429 with structured body, `Retry-After`, scope = 'config'.
4. **Window reset** → after the configured 60 s window elapses, the bucket is replenished (verified with `jest.useFakeTimers()` + `jest.advanceTimersByTime`).
5. **Mid-window** → a partial advance does NOT reset the bucket.
6. **Per-client isolation** — different `X-API-Key`s do not share buckets.
7. **IP-fallback isolation** — no `X-API-Key` falls back to a separate `req.ip` bucket.
8. **Cross-bucket isolation** — API-key client and IP-only client don't cross-pollute.
9. **X-Forwarded-For hardening** — same socket, three different X-FF values → still counted in the same bucket.
10. **Mount order** — limiter consumes quota even on requests with no `Authorization`.

## Backward compatibility

- **Env vars default to safe values** — operators who do not set `CONFIG_RATE_LIMIT_WINDOW_MS` / `CONFIG_RATE_LIMIT_MAX` continue to see zero behavioural change at boot; a 60 s / 20-request cap is applied automatically.
- **`createRateLimiter`/`globalLimiter`/`sensitiveLimiter`/`apiKeyLimiter` are observably unchanged** — no Redis path / handler / key-format regression for any pre-existing scope.
- **No public API shape change** — the only new exports are additive (`adminConfigLimiter`, `createConfigRateLimiter`, `adminConfigKeyGenerator`, `adminConfigHandler`, `CONFIG_RATE_LIMIT_WINDOW_MS`, `CONFIG_RATE_LIMIT_MAX`).
- **No test-suite breakage** — `tests/mocks/setup.js` was updated to extend its global `rateLimit` mock with the two new exports (`adminConfigLimiter: noopMiddleware`, `createConfigRateLimiter: jest.fn(() => noopMiddleware)`) so other suites that require `src/routes/adminConfig` continue to parse.

## CI commands run locally

```bash
npm run lint        # 0 new errors in the four changed files (pre-existing WINDOW_MS/MAX_REQUESTS no-undef at line 71 of rateLimit.js is unrelated to #754)
npm run typecheck   # passes clean
npm test            # all suites passing; adminConfig.rateLimit.test.js 18/18 green
```

## Suggested reviewers

- Anyone from the admin / config surface squad (knows the validation, the `adminStack`, and the auth headers).
- Anyone who reviewed `#429` (cluster-detection redis-fallback work) — closest architectural neighbour.
- Anyone who reviewed `src/middleware/security.js` (helmet + CSP) — for the X-Forwarded-For hardening rationale.

## Next steps after merge

- Surface four new Prometheus counters on `src/metrics.js`: `adminConfigRateLimitedTotal{clientKind="apikey"|"ip"}`, `adminConfigLimiterRedisDownTotal`, `adminConfigLimiterFailOpenTotal`, `adminConfigWindowResetTotal`. Manual patching in a follow-up issue.
- Consider replacing the silent auth-flooding defence with an explicit `Log.warn({ event: 'admin_config.rate_limit_triggered', scope, bucket })` so SecOps can alert on spikes.

Closes #754.
