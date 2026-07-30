# Rate Limiting — Operator Runbook (Issue #429)

The rate-limit middleware in [`src/middleware/rateLimit.js`](../src/middleware/rateLimit.js)
defaults to **per-process in-memory counters**. That default is correct for
local development, staging, and any single-instance deployment — but in
production with multiple replicas (Heroku `WEB_CONCURRENCY > 1`, Kubernetes
replicas, PM2 cluster mode, etc.), each replica maintains its own counter
and the **effective rate limit is `configured_limit × instance_count`**.

This runbook explains how to:

1. Detect the in-memory cluster condition.
2. Wire a Redis-backed distributed store when running multi-instance.
3. Keep key extraction unspoofable behind a proxy.
4. Verify the warning fires in CI / smoke tests.

---

## 1. Detecting the multi-instance condition

The middleware reads these env vars at process start:

| Variable            | Signal                   |
| ------------------- | ------------------------ |
| `WEB_CONCURRENCY`   | Heroku-style multi-dyno |
| `CLUSTER_WORKERS`   | PM2 / Kubernetes cluster mode |

If either is set to an integer greater than `1`, the process is considered
"clustered." Suppressed under `NODE_ENV === 'test'` so unit tests stay quiet.

When a limiter ends up with an **in-memory** store in a clustered
deployment, the very first such limiter emits exactly one summary line:
[`logger.warn`](logging is the Pino logger in `src/logger.js`):

```text
rate-limit: in-memory store active in clustered deployment — effective limits are multiplied by instance count
{
  "component": "rate-limit",
  "event": "memory_in_cluster",
  "scope": "global",
  "signal": "WEB_CONCURRENCY",
  "webConcurrency": 4,
  "recommendation": "Install @express-rate-limit/redis (preferred) or rate-limit-redis and provide a Redis client via createRateLimiter(scope, win, max, { redisClient }) so counters are shared across instances."
}
```

Subsequent in-memory limiters in the same process emit
`memory_in_cluster_additional_scope` so you can see exactly which scopes
are still unprotected without log spam.

---

## 2. Wiring a Redis-backed store

The race order inside `createRateLimiter(scope, windowMs, max, opts)` is:

1. `opts.redisClient` — only used if it exposes `sendCommand(...args)`.
   Compatible with `node-redis` v4+, `ioredis`, or any compatible client.
2. `src/cache/redis.js#getRedisClient().client` — reuses the cache-layer
   Redis connection if it's connected.
3. `null` — falls back to in-memory with the cluster warning.

Install either package (your pick):

```bash
npm install @express-rate-limit/redis
# or
npm install rate-limit-redis
```

The middleware tries `@express-rate-limit/redis` first, then
`rate-limit-redis`; the load is cached for the process lifetime.

### Code patterns

```js
// Option A — explicit client
const redis = require('redis');          // or: const Redis = require('ioredis');
const client = redis.createClient({ url: process.env.REDIS_URL });

const limiter = createRateLimiter('invest', 60_000, 30, {
  redisClient: client,
});
```

```js
// Option B — let the middleware reuse the cache-layer connection
// (no opts.redisClient needed; createRateLimiter calls
// src/cache/redis.js#getRedisClient() under the hood)
const limiter = createRateLimiter('invest', 60_000, 30);
```

When the store is wired successfully, the returned middleware carries
`limiter.__liquifactStoreType === 'redis'` and `limiter.__liquifactScope`.
Use these in tests and `/metrics`-adjacent code paths for observability.

### Key prefixing

Redis keys use `rate-limit:<scope>:` as the prefix. Scopes are stable
identifiers (`global`, `sensitive`, `api-key`, `invest`, ...) picked at
build-time and never include request data.

---

## 3. Anti-spoofing posture (proxy-aware)

`keyGenerator(req)` reads the **direct TCP socket peer**
(`req.socket.remoteAddress`), never the attacker-controlled
`X-Forwarded-For` header. In addition, every limiter is constructed with:

```js
expressRateLimit({
  validate: { xForwardedForHeader: false },
  // ...
});
```

Express-rate-limit v7 will throw at the first XFF-bearing request when
this validation is `false`. So a future `app.set('trust proxy', ...)`
cannot silently turn the limiter into a per-attacker no-op.

If you genuinely need XFF-aware keying behind a trusted load balancer,
enable `app.set('trust proxy', 'loopback')` (or an exact CIDR list) and
remove the `validate.xForwardedForHeader: false` line — but **only**
when the proxy is trusted. The default is the safe one.

---

## 4. Verifying the warning in CI / smoke tests

The test suite at [`tests/security.middleware.test.js`](../tests/security.middleware.test.js)
covers:

| Scenario                                              | Assertion |
| ------------------------------------------------------ | --------- |
| Single instance, no Redis, default config              | No warn, memory store. |
| `WEB_CONCURRENCY=4`, no Redis                          | Warn fires once; details correct. |
| `WEB_CONCURRENCY=4`, Redis available                   | No warn. |
| `CLUSTER_WORKERS=8`, no Redis                          | Warn fires, signal=`CLUSTER_WORKERS`, value=8. |
| `opts.redisClient` exposes `sendCommand`               | Store resolved as Redis. |
| `opts.redisClient` lacks `sendCommand`                 | Fall back to memory. |
| Redis store ctor throws                                | Fall back to memory, no crash. |
| No Redis package installed (`loadRedisStoreCtor`=null) | Fall back to memory, no crash. |
| `X-Forwarded-For` set in request                      | Key reads socket peer; XFF ignored. |
| Second memory scope under same cluster                 | Follow-up warn recorded. |

Run them in isolation:

```bash
npx jest tests/security.middleware.test.js --runInBand --forceExit --no-coverage
```

---

## 5. Production checklist

- [ ] `WEB_CONCURRENCY` (or `CLUSTER_WORKERS`) reflects the actual replica count.
- [ ] Redis is reachable from every replica; `REDIS_URL` is in the secret store.
- [ ] `@express-rate-limit/redis` (preferred) or `rate-limit-redis` is in `package.json`.
- [ ] Startup logs do **not** contain
      `memory_in_cluster` after a Redis client is wired.
- [ ] `/metrics` shows no rate-limit failures when Redis is down
      (the cache-circuit-breaker fail-open path keeps the limiter serving).
- [ ] If behind a proxy, `app.set('trust proxy', 'loopback')` (or a precise CIDR list)
      is set; **never** leave trust-proxy on "true" for a public ingress
      without an upstream filter — the spoofing guard will reject XFF anyway
      but it is the wrong posture.

---

## 6. Log events for alerting

The middleware emits structured `logger.warn` lines you can key alerts on.
All event names are stable contracts (issue #429):

| `event` field                              | Trigger                                       | When to alert                                        |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| `memory_in_cluster`                        | First limiter in this process is memory+cluster | **Page ops**: install the Redis package now.       |
| `memory_in_cluster_additional_scope`       | Subsequent memory limiters in same cluster    | Informational. Inspect scope list before deploy.   |
| `redis_store_unavailable`                  | Neither `@express-rate-limit/redis` nor `rate-limit-redis` resolved | **Page ops**: install the Redis package.            |

The summary event includes a `recommendation` field with the exact install
command; surface that string in your internal runbook runner. Example grep
for capacity escalations:

```bash
# On a structured-JNSON pino log stream:
jq -c 'select(.component=="rate-limit" and .event | startswith("memory_in_cluster"))'
```

---

## 7. Client compatibility

`buildRedisStore(scope, redisClient)` accepts any of:

| Client package                       | API shape                              | Adapter used                            |
| ------------------------------------ | -------------------------------------- | --------------------------------------- |
| `node-redis` v4+                     | `client.sendCommand(args)`             | direct passthrough                       |
| `ioredis`                            | `client.call(cmd, restArgs)`           | bridges to `sendCommand(...args)`        |
| Anything else exposing `sendCommand`  | `client.sendCommand(args)`             | direct passthrough                       |

A client missing both `sendCommand` and `call` makes the limiter fall back
to in-memory with a structured warning, no crash.
