# Observability: Request Context Logging

## Overview

Every log line emitted inside the lifecycle of an HTTP request is automatically enriched with four correlation identifiers — `requestId`, `correlationId`, `tenantId`, and `userId` — without any call site needing to pass them explicitly.

This is implemented using Node.js [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage), which propagates a context object across the entire async call chain of a request.

---

## How it works

```
Incoming request
      │
      ▼
requestId middleware   → seeds context:  { requestId }
      │
      ▼
correlationId middleware → merges:        { correlationId }
      │
      ▼
tenant middleware        → merges:        { tenantId }
      │
      ▼
Route handler / services / jobs
      │
      ▼
logger.info('something happened')
 → auto-enriched to: { requestId, correlationId, tenantId, …caller fields }
```

The context is stored in `src/requestContext.js` and read by the `src/logger.js` Proxy on every log call.

---

## Ambient fields

| Field           | Set by                    | Source                                        |
|-----------------|---------------------------|-----------------------------------------------|
| `requestId`     | `requestId` middleware    | `X-Request-Id` header or generated UUID       |
| `correlationId` | `correlationId` middleware| `X-Correlation-Id` header or generated id     |
| `tenantId`      | `tenant` middleware       | `X-Tenant-Id` header or JWT `tenantId` claim  |
| `userId`        | application code (opt.)   | `set({ userId })` after auth                  |

---

## Using the context API

### `src/requestContext.js`

```js
const { run, get, set, ALLOWED_KEYS } = require('./requestContext');
```

#### `run(initialValues, fn)`

Start a new context scope. Call inside middleware **before** calling `next()`.

```js
// requestId middleware does this:
run({ requestId: id }, next);
```

#### `set(fields)`

Merge additional fields into the **current** active context. Safe to call from any middleware or service that runs within the same request. No-ops when there is no active store (background jobs).

```js
// correlationId middleware does this:
set({ correlationId });

// After authentication resolves the user:
set({ userId: req.user.id });
```

#### `get()`

Read the current context. Returns an empty object when there is no active store.

```js
const { requestId, tenantId } = get();
```

#### `ALLOWED_KEYS`

A `ReadonlySet<string>` of the keys that the context accepts. Currently:
`requestId`, `correlationId`, `tenantId`, `userId`.

Any key not in this set is silently dropped by both `run()` and `set()`.

---

## Logger behaviour

`src/logger.js` wraps the underlying pino instance in a `Proxy`. Every log-level method (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) automatically merges the ambient context before forwarding to pino.

**Explicit per-call fields override ambient values:**

```js
// Ambient context: { requestId: 'r1', tenantId: 'acme' }

logger.info('ordinary message');
// → { requestId: 'r1', tenantId: 'acme', msg: 'ordinary message', … }

logger.warn({ tenantId: 'override' }, 'switching tenant');
// → { requestId: 'r1', tenantId: 'override', msg: 'switching tenant', … }
```

**Background jobs** that never call `run()` receive an empty context — the logger passes their arguments through unchanged, so existing job logs continue to work without modification.

---

## Adding `userId` after authentication

The `auth` middleware runs after `requestId` and `correlationId`, so the context is already active. Add a single `set()` call after verifying the token:

```js
// src/middleware/auth.js (example)
const { set } = require('../requestContext');

function authenticateToken(req, res, next) {
  // … verify JWT …
  req.user = decoded;
  set({ userId: decoded.sub });   // ← add this line
  next();
}
```

---

## Background jobs

Jobs dispatched outside of an HTTP request have no active `AsyncLocalStorage` store. The logger detects this via `get()` returning `{}` and logs without merging any ambient fields — **no changes are required in existing job code**.

To add structured correlation to a specific job run, wrap the job body in `run()`:

```js
const { run } = require('../requestContext');
const logger = require('../logger');

async function runReconcileJob(jobId) {
  run({ requestId: jobId }, async () => {
    logger.info('reconcile job started');  // → { requestId: jobId, … }
    await doWork();
    logger.info('reconcile job finished'); // → { requestId: jobId, … }
  });
}
```

---

## Security

- **Only** `requestId`, `correlationId`, `tenantId`, and `userId` are admitted into the ambient context. All other keys passed to `run()` or `set()` are silently dropped (`ALLOWED_KEYS` allowlist).
- Values must be non-empty strings; `null`, numbers, objects, and empty strings are ignored.
- This prevents passwords, tokens, or any other PII from inadvertently entering every log line via the ambient store.

---

## Middleware mount order

The three wiring middlewares must be mounted in this order for the context to be fully populated before route handlers run:

```js
// src/app.js
app.use(requestId);        // 1. seeds context with requestId
app.use(correlationId);    // 2. merges correlationId
// … auth …
app.use(extractTenant);    // 3. merges tenantId (requires auth for JWT path)
```

See [`docs/request-lifecycle-middleware-order.md`](./request-lifecycle-middleware-order.md) for the full middleware stack.

---

## Testing

Unit and integration tests live in `tests/logger.context.test.js` and cover:

- `requestContext` API (`run`, `get`, `set`, `ALLOWED_KEYS`)
- Ambient enrichment at every log level
- Explicit override semantics
- Background-job path (no context → clean logging)
- Nested async call isolation
- Concurrent request isolation
- PII / disallowed-key guard
- Middleware wiring (`requestId`, `correlationId`, `tenant`)

Run with:

```bash
npm test -- --testPathPattern=logger.context
```
