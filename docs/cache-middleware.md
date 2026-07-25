# Response cache middleware

The cache middleware stores idempotent GET responses keyed by route and
tenant context. Invalidation hooks fire when underlying invoice or escrow
records mutate so callers never observe stale funded/settled states.

Configuration:

- TTL per route class (see `src/middleware/cache.js`)
- `Cache-Control` headers echo max-age to downstream CDNs
- Manual purge via admin endpoints documented in `docs/configuration.md`

When extending caching, ensure PII is never cached on authenticated routes
without `private` directives.
