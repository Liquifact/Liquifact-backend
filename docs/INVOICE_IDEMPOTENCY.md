# Invoice creation idempotency

`POST /v1/invoices` accepts an `Idempotency-Key` after tenant extraction. The
key is required for this endpoint, normalized by trimming outer whitespace, and
restricted to 8–128 URL-safe characters. Requests without a key cannot be
mistakenly assigned an implicit replay identity.

The in-memory store uses a composite tenant/key identity. Its fingerprint is a
SHA-256 digest of the method, route, tenant, and recursively canonicalized JSON
body. Consequently, two tenants may safely choose the same key, while two
different invoice payloads in one tenant cannot reuse one key. The body itself
is never persisted in the idempotency record.

## State machine

| State | Meaning | HTTP behavior |
| --- | --- | --- |
| claimed | first request owns the key | handler executes once |
| pending | another request is executing | 409 `request_in_progress` |
| completed | response has been captured | original status/body replayed |
| conflict | fingerprint differs | 409 `idempotency_conflict` |
| expired | TTL elapsed | key is eligible for a fresh claim |

Claiming is a synchronous map insertion before `next()` runs. This is the
atomic boundary for the shipped in-memory implementation: a second request
cannot observe an absent key and then insert its own record during the same
event-loop turn. A response is marked completed only after the invoice handler
has selected its status and body. If a connection closes before completion,
the pending claim is abandoned so a retry is not permanently blocked.

The default retention is 24 hours. The interface is intentionally small so a
transactional or Redis-backed implementation can replace the in-memory store
without changing the route contract. Such an implementation must preserve the
same atomic claim semantics and tenant scope.

Clients should replay only the same canonical payload. A conflict requires a
new key; changing the body under an existing key is never treated as a retry.

### Operational notes

The store exposes `purge()` for a scheduled cleanup hook and evicts the oldest
entry when its configured safety bound is reached. Production deployments
that run more than one API process should provide a shared implementation;
the local store is safe for a single process and is deliberately not presented
as cross-process durability.

The middleware returns stable error codes rather than exception text from a
database driver. This lets SDKs distinguish a retryable in-progress response,
a client correction required for a conflict, and a malformed request.

Metrics should count claims, replays, conflicts, and in-progress responses
separately so operators can detect unhealthy retry storms.
