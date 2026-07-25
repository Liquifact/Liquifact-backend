# Request lifecycle

Liquifact processes HTTP requests through the following layers (simplified):

1. **Express bootstrap** (`app.js`) — body parsers, trust proxy, global error handler registration.
2. **Correlation / logging** — request id and structured log context attached early.
3. **Rate limiting & security headers** — applied before route matching on API paths.
4. **Authentication** — `authenticateToken` on protected routes; JWT algorithm allowlist, issuer, audience.
5. **Tenant extraction** — `extractTenant` after auth for multi-tenant routes.
6. **Route handler** — business logic; errors thrown as `AppError` (RFC 7807).
7. **Error middleware** — serializes `AppError` and unexpected failures consistently.

Deprecated routes may mount `deprecation` middleware to emit `Deprecation`, `Sunset`, and `Link` headers (RFC 8594).

See also: `src/middleware/stacks.js` for composed middleware chains per route group.
