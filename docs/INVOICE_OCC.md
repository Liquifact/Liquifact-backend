# Invoice optimistic concurrency

Invoice reads include a positive integer `version` and a strong `ETag` header
derived from it (`"<version>"`). Every state-changing mutation (`fund`,
`settle`, `cancel`, escrow link) increments `version` atomically with the state
change and returns the new `version` in the body and as a fresh `ETag`.

Clients may send `If-Match: "<version>"` (or the weak form `W/"<version>"`) on
those mutations. When the header is present and does not match the current
version, the service returns `412 Precondition Failed` as `application/problem+json`
with code `PRECONDITION_FAILED` and performs no mutation. When the deployment sets
`REQUIRE_IF_MATCH=true` and the header is absent, the service returns
`428 Precondition Required` with the same problem envelope and performs no mutation.

The service performs one tenant-scoped `UPDATE` with both `invoice_id` and
`version` in its predicate (when a precondition is supplied), and writes
`version + 1` in the same statement. The affected-row count is the
compare-and-set result. A read followed by an unconditional write is
deliberately not used, because two workers could both pass that check.

A stale `If-Match` revision returns `412` with `PRECONDITION_FAILED`; the
response is safe for retry: callers must re-read, merge intentionally, and
submit the new revision. Missing precondition headers return `428` only when
`REQUIRE_IF_MATCH=true`; otherwise the mutation proceeds unconditionally.
Malformed `If-Match` values return `400`; there is no implicit “latest” mode.

The migration initializes legacy rows to version 1 and adds a covering tenant
index. Version values are not an audit history and are not reusable across
tenants. Soft deletes and state-transition guards remain in the same guarded
write path.

## Failure-mode matrix

| Input | Result | Side effect |
| --- | --- | --- |
| current version | 200, incremented version | one update |
| stale version | 412 `PRECONDITION_FAILED` | none |
| future version | 412 `PRECONDITION_FAILED` | none |
| missing header, `REQUIRE_IF_MATCH=true` | 428 `PRECONDITION_REQUIRED` | none |
| missing header, `REQUIRE_IF_MATCH=false` | proceeds unconditionally | one update |
| malformed or unsafe version | 400 typed error | none |
| missing tenant or invoice | 404/tenant-safe result | none |

The public response always includes the fresh version after a successful
update, so a client never needs to infer it from timestamps.
