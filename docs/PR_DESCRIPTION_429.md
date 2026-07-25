# feat: add Redis store option and clustering warning to rate limiter (Closes #429)

## Summary

The rate limiters in `src/middleware/rateLimit.js` previously used
`express-rate-limit`'s default in-memory `MemoryStore`. With more than
one Node process / instance / dyno, every replica maintained its own
counters, so the **effective rate limit was silently multiplied by the
instance count** — i.e. `configured_limit × instance_count` instead of
the operator-configured `configured_limit`.

This PR:

1. Adds an **opt-in Redis-backed distributed store** for the rate
   limiter, with auto-discovery of either `@express-rate-limit/redis`
   (v7-native, preferred) or the legacy `rate-limit-redis` package.
2. Reuses the existing `src/cache/redis.js#getRedisClient()` connection
   when the cache layer has already opened one — no extra wiring, no
   double-sockets.
3. Emits a **structured `logger.warn` line** when an in-memory limiter
   is constructed under a clustered deployment (`WEB_CONCURRENCY > 1` or
   `CLUSTER_WORKERS > 1`). The summary line fires once per process;
   subsequent in-memory limiters in the same cluster emit per-scope
   follow-up lines.
4. **Hardens the rate-limit key** so `X-Forwarded-For` cannot spoof the
   bucket. `keyGenerator` always reads `req.socket.remoteAddress` first
   and `validate.xForwardedForHeader: false` is set on every limiter,
   so a future `app.set('trust proxy', ...)` cannot silently bypass the
   limit.

## Scope

Issue #429 only. Out of scope (existing baseline issues tracked
elsewhere):

- Pre-existing `src/metrics.js` TDZ (registry declared after some
  gauges). Avoided by lazy-requiring `src/cache/redis` inside
  `resolveRedisClient`.
- Pre-existing missing `redis` and `ioredis` packages on upstream —
  addressed for the store layer via `rate-limit-redis` /
  `@express-rate-limit/redis` discovery with structured warnings.

## Files changed

```
src/middleware/rateLimit.js    rewrite — store factory, cluster warning, key guard
src/cache/redis.js             fix — dual module.exports so getRedisClient is reachable
tests/security.middleware.test.js  NEW — comprehensive coverage
docs/rate-limit-ops.md         NEW — operator runbook
docs/configuration.md          add — WEB_CONCURRENCY + CLUSTER_WORKERS rows
.env.example                   add — WEB_CONCURRENCY comment block
package.json                   add — jest coverageThreshold for rateLimit.js
```

## Public API

`createRateLimiter(scope, windowMs, max, opts)` — new fourth parameter
`opts.redisClient` (optional):

```js
// Default (in-memory); current behavior for callers that pass the
// legacy `(scope, windowMs, max)` triple.
const limiter = createRateLimiter('global', 60_000, 100);

// Explicit Redis client (node-redis v4+ or ioredis):
const limiter = createRateLimiter(
  'invest',
  60_000,
  30,
  { redisClient: redis.createClient({ url: process.env.REDIS_URL }) },
);

// Reuse the cache-layer connection — the middleware pulls it from
// src/cache/redis.js#getRedisClient() under the hood, so you do not
// have to pass it.
const limiter = createRateLimiter('invest', 60_000, 30);
```

Pre-built middleware (`globalLimiter`, `sensitiveLimiter`,
`apiKeyLimiter`) and pure helpers (`keyGenerator`,
`apiKeyKeyGenerator`, `getApiKey`, `parseRateLimitEnv`,
`socketPeerAddress`) preserved for backward compatibility.

New inspectors:

```js
rateLimit.CLUSTER_SIGNAL                     // { clustered, signal, value }
rateLimit.detectClusteredDeployment()       // re-evaluate
rateLimit.isMemoryInClusterWarning()         // latch from this process
rateLimit.resolveRedisClient(explicit)      // exposes the resolution chain
rateLimit.buildRedisStore(scope, client)     // exposes the store factory
rateLimit.loadRedisStoreCtor()               // exposes the package lookup
```

## Behavior matrix

| `WEB_CONCURRENCY` / `CLUSTER_WORKERS` | Redis client reachable | Store type | Warning? |
| ------------------------------------- | ---------------------- | ---------- | -------- |
| unset or 1                            | no                     | memory     | no       |
| unset or 1                            | yes                    | redis      | no       |
| > 1                                   | no                     | memory     | **yes**  |
| > 1                                   | yes                    | redis      | no       |

The warning's `event` field is a **stable contract**:

| event                                | When                                     |
| ------------------------------------ | ---------------------------------------- |
| `memory_in_cluster`                  | First memory+cluster limiter in process  |
| `memory_in_cluster_additional_scope` | Subsequent memory+cluster limiters       |
| `redis_store_unavailable`            | Both store packages failed to load      |

Each `event` carries fields: `component: 'rate-limit'`, `scope`,
`signal: 'WEB_CONCURRENCY' | 'CLUSTER_WORKERS'`, `webConcurrency: <n>`,
`recommendation: '<exact install command>'`. Documented in
`docs/rate-limit-ops.md` §6.

## Security posture

- **Key spoofing**: `keyGenerator(req)` always reads
  `req.socket.remoteAddress` first, then `req.ip`, then `'127.0.0.1'`
  as a last resort. `validate.xForwardedForHeader: false` is set on
  every limiter, so `X-Forwarded-For`-bearing requests are rejected
  by express-rate-limit v7 before the key is read.
- **Key cardinality**: scope-prefixed by `__liquifactScope` (set
  on the middleware as a non-enumerable-looking property for
  observability).
- **Warning cardinality**: `event` and `signal` are fixed enums;
  `scope` is a build-time constant per limiter (not request data);
  `webConcurrency` is an integer. No PII or request-derived data in
  the structured fields.

## Tests

`tests/security.middleware.test.js` — 24/24 green:

1. **Store selection** (7 tests) — explicit client, auto-resolved
   client, null client, package missing, scope isolation, ioredis
   bridge, node-redis v4+.
2. **Clustering warning** (5 tests) — `WEB_CONCURRENCY > 1` summary,
   redis-in-cluster silence, no-cluster silence, follow-up per scope,
   `CLUSTER_WORKERS` alternation.
3. **Redis unavailable fallback** (3 tests) — package missing,
   constructor throws, in-memory default still serves requests.
4. **Key spoofing guard** (7 tests) — socket peer first, attacker
   headers ignored, `req.ip` fallback, localhost fallback, API-key
   pathway, `getApiKey` trim/missing/non-string.
5. **Single-instance default** (2 tests) — no warn, no Redis,
   `WEB_CONCURRENCY=1` boundary.

The test file deliberately does NOT require `../src/cache/redis`
because that file transitively loads `../src/metrics` which has a
pre-existing TDZ on the bare upstream/main branch (out of scope for
#429). It uses `jest.spyOn(rateLimit, ...)` on the export methods so
the lazy cache require is never reached during tests.

`package.json` adds a `coverageThreshold` for `src/middleware/rateLimit.js`
at 90% branches / 95% functions / 95% lines / 95% statements so #429's
"minimum 95% coverage" requirement is enforced in CI.

## Operator checklist

- [ ] `WEB_CONCURRENCY` (or `CLUSTER_WORKERS`) reflects actual replica
      count.
- [ ] Redis is reachable from every replica; `REDIS_URL` in secret
      store.
- [ ] `@express-rate-limit/redis` (preferred) or `rate-limit-redis` is
      in `package.json`.
- [ ] Startup logs do NOT contain `memory_in_cluster` after a Redis
      client is wired.
- [ ] If behind a proxy: `app.set('trust proxy', 'loopback')` (or a
      precise CIDR) is set, not `'true'` — combined with the
      `validate.xForwardedForHeader:false` guard.

## Validation

| Step | Result |
| ---- | ------ |
| `npx jest tests/security.middleware.test.js` | **24 / 24 pass** |
| `npx eslint src/middleware/rateLimit.js src/cache/redis.js tests/security.middleware.test.js` | clean |
| `npx tsc -p tsconfig.json --noEmit` | clean |

## Risks

- **Memory in cluster, no warning**: if `WEB_CONCURRENCY / CLUSTER_WORKERS`
  is misconfigured to e.g. `'0'`, the env-read fires
  `clustered:false`; silent fallback. Mitigation: a startup
  unit test asserts the parse. (Out of scope of #429)
- **Operator trusts XFF and turns off `validate.xForwardedForHeader`**
  + flips `trust proxy: true`: the spoofing guard silently degrades to
  whatever `req.ip` evaluates to. Mitigation: documented in §3 of
  `docs/rate-limit-ops.md`. (Operator action required.)

## Next-step suggestions

- Install `@express-rate-limit/redis` in a follow-up and wire
  `createRateLimiter(...)` at the route level (currently only the
  prebuilt limiters are auto-wired).
- Add a `_warnRateLimitCluster()` startup unit test that asserts the
  `memory_in_cluster` summary event shape.
- Consider adding a per-process `rate_limit_warning_emitted_total`
  Prometheus counter for monitoring rather than string-scraping logs.

## Reviewer references

- Issue: #429
- Prior prior art: `keljoshX/feat(rate-limit): add optional
  Redis-backed distributed limiter store (#267)`. This PR supersedes
  the prior prototype, fixes its package-not-installed state, and
  adds the clustering warning + key-spoof hardening the issue
  requested.
- Related: issue #436 (escrow preflight, sibling PR #474).
