# Audit Log Service

## Overview
The Audit Log Service manages immutable audit records for invoice mutations,
backed by the `audit_log_events` table.

## Page Size Cap

`getAuditLogs` enforces a hard maximum page size of **100 records** per query
to prevent loading the entire audit table into memory and causing
out-of-memory errors or denial of service.

### Behaviour
- Default limit: `100`
- Maximum limit: `100` (any value above this is clamped)
- Passing `Infinity` or a value larger than `100` will return at most `100` records
- Negative or non-numeric limits are treated as the default (`100`)
- Zero limit is treated as the default (`100`)

## Pagination
To retrieve more than 100 records, use the `offset` parameter to paginate:

```js
// Page 1
getAuditLogs({ limit: 100, offset: 0 });

// Page 2
getAuditLogs({ limit: 100, offset: 100 });
```

## CSV Export Safety

Audit CSV exports use a header-first transform and escape every field before it
is written. Formula-injection leads are neutralized with a leading single quote
when the first non-whitespace character is `=`, `+`, `-`, `@`, `|`, tab, or
carriage return. Fields containing commas, quotes, newlines, or carriage returns
are then quoted with RFC 4180 double-quote escaping.

Tenant-scoped audit exports must filter at the database query level with
`metadata->>'tenantId' = ?` before rows enter the CSV stream. Empty result sets
still emit the CSV header row so downstream tools receive a valid file shape.

Metadata stored with audit events is recursively redacted for sensitive key
patterns including password, secret, token, API key, authorization, private key,
seed, and mnemonic.

## Hash-Chained Audit Store & File Persistence

Each entry in `src/audit/audit-log.js` carries a sequential `seq`, `prevHash`
(starting from `GENESIS_HASH`, sixty-four `'0'` characters), and
`hash = sha256(prevHash + canonicalJSON(entryWithoutHash))`.

### Store Backends

`createAuditLog({ store })` accepts a pluggable synchronous store:

- **In-memory store (`createMemoryStore({ maxEntries })`)** — default when
  `AUDIT_LOG_FILE` is not set. Retains at most `AUDIT_MAX_ENTRIES` entries in
  memory for the current process lifetime.
- **Durable file store (`createFileStore({ path, maxEntries, rotateBytes, onCorrupt })`)** —
  selected automatically when `AUDIT_LOG_FILE` is set.
  - **Append-only NDJSON**: each entry is serialized as a single `\n`-terminated
    JSON line and flushed with `fsyncSync` before `append()` returns.
  - **Immutable reads**: every returned entry is recursively frozen with
    `deepFreeze`.
  - **Boot replay & verification**: on startup, existing segment files
    (`<path>.1`, `<path>.2`, …, `<path>`) are replayed in order and checked
    with `verifyChain`. A hash mismatch, sequence gap, malformed JSON line, or
    truncated final line (missing trailing `\n`) throws `AuditIntegrityError`
    by default (`onCorrupt: 'throw'`) so the service refuses to start against a
    tampered log, or flags `verify()` as `{ valid: false, brokenAt }` when
    constructed with `onCorrupt: 'flag'`.
  - **Size-based segment rotation**: when `AUDIT_ROTATE_BYTES` (`rotateBytes`)
    is set and the active file would exceed that byte threshold, the active file
    is rotated to `<path>.<n>` and a new `<path>` is started whose first entry's
    `prevHash` links to the previous segment's final `hash`.

### Querying: `GET /api/audit`

Admin only (`Authorization: Bearer $ADMIN_API_TOKEN`). Returns
`{ data, count, nextAfter }`, oldest first. Every filter is optional and they
combine with AND.

| Parameter | Type | Description |
| --- | --- | --- |
| `resourceId` | string | Only entries for this resource, e.g. `INV_0002`. |
| `action` | string | Only this action, e.g. `invoice.fund`. |
| `actor` | string | Only entries by this actor (the API key id, or `anonymous`). |
| `outcome` | `success` \| `rejected` \| `error` | Only entries with this outcome. `error` is reserved; no entry records it yet, so it matches nothing today. |
| `from` | ISO 8601 timestamp | Only entries whose `at` is at or after this instant (inclusive). |
| `to` | ISO 8601 timestamp | Only entries whose `at` is at or before this instant (inclusive). |
| `limit` | integer 1–200 | Page size. Default `50`. |
| `after` | integer ≥ 0 | Only entries with `seq` greater than this. Pass the previous page's `nextAfter`. |

`from` and `to` must be full date-times with a time zone (`Z` or `±HH:MM`),
e.g. `2026-11-23T10:00:00Z` or `2026-11-23T11:00:00.000+01:00`. Each must be
a real calendar date and time. Any of these returns `400` with an `error`
message:

- a value that is not a valid timestamp, including a date with no time or a
  time with no zone
- `from` later than `to`
- an `outcome` outside the list above
- a parameter given more than once

Paging works the same with or without filters: the cursor is the `seq` of the
last entry returned, so keep the same filters on every page. `nextAfter` is
`null` on the last page.

```bash
# Rejected attempts by one API key during one hour
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "$BASE/api/audit?actor=partner-key-1&outcome=rejected&from=2026-11-23T10:00:00Z&to=2026-11-23T11:00:00Z&limit=100"
```

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AUDIT_MAX_ENTRIES` | `10000` | Positive integer capping how many recent entries are retained in memory. |
| `AUDIT_LOG_FILE` | *(unset)* | Path to the NDJSON audit log file. Unset keeps the default in-memory store. |
| `AUDIT_ROTATE_BYTES` | *(unset / `0`)* | Positive integer byte threshold at which the active audit log file rotates to `<AUDIT_LOG_FILE>.<n>`. |
| `ADMIN_API_TOKEN` | *(unset)* | Bearer token required for `GET /api/audit` and `GET /api/audit/verify`. |

