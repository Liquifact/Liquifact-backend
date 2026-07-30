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
