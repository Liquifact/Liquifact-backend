# Invoice optimistic concurrency

Invoice reads include a positive integer `version`. A client must send that
value back as `version` when patching an invoice. The API also accepts a weak
`If-Match: W/"<version>"` value for clients that keep revisions in HTTP
metadata; the body value takes precedence when both are present.

The service performs one tenant-scoped `UPDATE` with both `invoice_id` and
`version` in its predicate, and writes `version + 1` in the same statement.
The affected-row count is the compare-and-set result. A read followed by an
unconditional write is deliberately not used, because two workers could both
pass that check.

A stale or future revision returns `409` with `version_conflict`, the expected
revision, and the current revision. The response is safe for retry: callers
must re-read, merge intentionally, and submit the new revision. Missing or
malformed revisions return `400`; there is no implicit “latest” mode.

The migration initializes legacy rows to version 1 and adds a covering tenant
index. Version values are not an audit history and are not reusable across
tenants. Soft deletes and state-transition guards remain in the same guarded
write path.

## Failure-mode matrix

| Input | Result | Side effect |
| --- | --- | --- |
| current version | 200, incremented version | one update |
| stale version | 409 `version_conflict` | none |
| future version | 409 `version_conflict` | none |
| missing/blank version | 400 typed error | none |
| malformed or unsafe version | 400 typed error | none |
| missing tenant or invoice | 404/tenant-safe result | none |

The public response always includes the fresh version after a successful
update, so a client never needs to infer it from timestamps.
