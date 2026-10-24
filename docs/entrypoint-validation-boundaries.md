# Entrypoint validation boundaries

`src/index.js` is the process entry point. It performs boot configuration
validation, resolves the port, binds the HTTP listener, starts the background
workers, and registers the listener for graceful shutdown. This document
defines the boundaries that module enforces and the behaviour operators can
expect for valid, invalid, duplicate, and boundary-case input.

## Why the listen port needs a boundary

`net.Server.listen()` dispatches on the *type* of its first argument, not on
its content. A string that is not a valid decimal port is interpreted as a Unix
domain socket path. Passing a raw `process.env.PORT` string to `app.listen()`
therefore produced these outcomes, none of which is an error:

| `PORT` value | Behaviour before this boundary              |
|--------------|---------------------------------------------|
| `not-a-port` | silently binds a Unix socket at `./not-a-port` |
| `8080abc`    | silently binds a Unix socket at `./8080abc`   |
| `-1`         | silently binds a Unix socket at `./-1`        |
| `0x1f`       | silently binds **TCP port 31** (hex is parsed) |
| `3001.5`     | throws `ERR_SOCKET_BAD_PORT`, unhandled       |

A typo in a deployment manifest must not be able to create a stray socket file
in the working directory, move the service to a port that no proxy or health
check targets, or escape as an unhandled exception with no redacted context.
`src/config/listenPort.js` is the single place where this input is accepted or
rejected, and both entry points (`src/index.js` and `src/server.js`) use it.

## Accepted input

`resolvePortFromEnv(value)` accepts:

- `undefined`, `null`, or a blank string: the default port `3001` is used. This
  preserves the previous `process.env.PORT || 3001` behaviour, where an unset
  variable was the only way to reach the default.
- A run of decimal digits, optionally surrounded by whitespace, whose numeric
  value is in `[1, 65535]`.

`validatePortArgument(value)` accepts `undefined` or `null` (meaning "no
override") and otherwise requires a real JavaScript number in `[0, 65535]`.
A string is rejected rather than coerced: coercion is the mechanism that
produced the silent misbindings above, so a string argument is treated as a
call-site bug instead of being interpreted.

`0` is accepted as an explicit argument because "let the OS choose an ephemeral
port" is a legitimate in-process and test affordance. It is **not** accepted
from the environment: a deployment that asked for an ephemeral port is a
misconfiguration, and failing loudly at boot is more useful than starting a
service that nothing can reach.

## Rejected input

Rejection is total. Nothing is clamped, coerced, or defaulted, because silently
correcting a port hides the misconfiguration and can move traffic to a port the
operator did not choose. Every rejection throws a `PortValidationError` with a
stable `code` from `PORT_VALIDATION_CODES`:

| Code                    | Cause                                                    |
|-------------------------|----------------------------------------------------------|
| `PORT_TYPE_INVALID`     | value was not a string (env) or a number (argument)      |
| `PORT_NOT_A_NUMBER`     | `NaN` or a non-finite number                             |
| `PORT_NOT_AN_INTEGER`   | value had a fractional part                              |
| `PORT_FORMAT_INVALID`   | env string was not a bare run of decimal digits          |
| `PORT_BELOW_MINIMUM`    | below `1` from the environment, below `0` as an argument |
| `PORT_ABOVE_MAXIMUM`    | above `65535`                                            |

Signs, radix prefixes (`0x`, `0b`), decimal points, exponent notation, and
trailing characters are all `PORT_FORMAT_INVALID`, because each is a *different*
value to `Number()` and to `net` than the operator most likely intended.

The range `[1, 65535]` matches `ConfigSchema.PORT` in `src/config/index.js`.
The entry-point boundary is a strict subset: it never accepts a value the
schema would reject, so the two can never disagree in the direction that
matters. The schema is the coarser of the two because it coerces with
`z.coerce.number()`; the entry point additionally rejects non-canonical strings.
`tests/index.bootValidation.test.js` asserts this relationship so a future change
to either definition cannot silently diverge.

## Startup order and invariants

`startServer(portOverride)` performs these steps in order. Each one is a
boundary that can stop the boot before the next side effect happens.

1. **Boot configuration.** `validate()` and `validateDependencies()` run first.
   On failure the redacted summary is logged, `process.exit(1)` is called, and
   the boot is abandoned. The function returns a boolean rather than relying on
   `process.exit()` to terminate: tests and some APM wrappers replace
   `process.exit` with a no-op, and on those code paths a rejected
   configuration used to reach `app.listen()` anyway. Boot validation is still
   skipped when `NODE_ENV=test`, which preserves lazy loading for the suite.
2. **Listen port.** Resolved from the explicit argument when one is given, and
   from the environment otherwise. The environment is read and validated at the
   moment of binding rather than from the cached config object, so the port that
   is bound is the port that was checked even when boot validation was skipped.
   A rejected port throws before the storage probe, the socket, or any log line
   that could be read as a successful start.
3. **Duplicate start.** The process holds at most one live listener. A second
   call to `startServer()` while a listener is running does not bind again: it
   logs `http_server_start_ignored` and returns the running server. This is
   deliberate. A second bind fails asynchronously with `EADDRINUSE` on an
   unhandled `error` event, and it would overwrite the server registered with
   the shutdown coordinator, leaving the first listener unclosed for the life of
   the process.
4. **Bind and register.** The listener is registered with the shutdown
   coordinator and signal handlers are installed. The startup storage probe is
   scheduled only after the socket exists, so a rejected port leaves no
   background work behind.
5. **Lifecycle.** A closed listener releases the single-listener slot, so a
   restart after shutdown is possible. `getHttpServer()` reports the current
   listener, or `null`.

## Failure modes

| Failure | Behaviour                                                                    |
|---------|------------------------------------------------------------------------------|
| Invalid configuration | Redacted summary on `console.error`, `process.exit(1)`, no listener bound |
| Invalid `PORT`        | `PortValidationError` thrown, no socket, no background work started        |
| `EADDRINUSE` / `EACCES` | `http_server_error` logged with the error code, `process.exit(1)` so the orchestrator restarts the process |
| Synchronous `listen()` throw | `http_server_bind_failed` logged, error rethrown to the caller, slot left free so the call is retryable |

None of these paths can produce a partially started process: either a listener
exists and is registered for shutdown, or the process is on its way out.

## Observability

Failures are diagnosable from the log without exposing sensitive data. The
entry point emits structured events on the standard logger: `http_server_starting`,
`http_server_start_ignored`, `http_server_bind_failed`, `http_server_error`,
and `http_server_closed`. Every payload carries `component: 'entrypoint'`, the
resolved `port`, and its `source` (`env` or `argument`); error payloads carry
`errorCode` and `errorName` instead of the error message, so a bind failure
never copies an environment-specific detail into the log.

Rejected values are rendered by `describeValue()`: strings are JSON-quoted,
which neutralises embedded newlines so a hostile `PORT` cannot forge a log
line; long values are truncated; and non-strings are described by `typeof`
alone, so an object or function is never serialised.

No Prometheus metric is emitted from the entry point. A process that fails its
boot validation or its bind never serves `/metrics`, so the counter would be
unreachable exactly when it mattered. The orchestrator's restart count and the
readiness probe are the intended signals, and the structured log carries the
reason.

## Compatibility

The public interface is unchanged. `module.exports` still exposes the Express
app plus `createApp`, `startServer`, and `resetStore`; `getHttpServer` and
`PortValidationError` were added. `startServer()` called with no argument
behaves as before for every value that was already valid.

Two behaviours change deliberately, and both were previously incorrect:

- `startServer(0)` now binds an ephemeral port. The argument used to be
  discarded, so a caller that asked for port 0 got the default port 3001 and
  could collide with any other process holding it.
- A rejected `PORT` now throws instead of binding something else. The
  `PORT` values that previously "worked" here were the ones that were silently
  wrong.

`src/server.js`, the legacy entry point, resolves its port through the same
module so the two cannot drift.

## Fencing token for purge workers

`src/index.js` generates a UUID v4 token with `crypto.randomUUID()` at boot
time and passes it to both purge workers as `{ fencingToken }`. Each worker
validates the token before starting:

- In non-test environments the token must be a well-formed UUID v4 string.
  Passing `undefined`, an empty string, a non-UUID string, a number, or a
  UUID from any version other than v4 throws a `TypeError` immediately, so a
  call-site regression fails at boot rather than silently.
- In `NODE_ENV=test` the check is skipped. `crypto.randomUUID()` is not
  available in all Node 16 Jest configurations and the token provides no safety
  invariant inside an isolated test process.

The token itself is not a distributed lease: it does not prevent a concurrently
running worker in another process from writing.  Its purpose is to make the
call site in `src/index.js` an enforced contract — if the argument is ever
removed or mistyped the server refuses to start rather than silently running
a worker with no traceability.  The token value is logged as `[present]` (never
echoed) so it is traceable without being exposed in log output.

`tests/index.bootValidation.test.js` section 13 asserts this boundary for both
purge workers across valid, invalid, missing, and wrong-version token inputs.
