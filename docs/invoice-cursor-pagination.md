# Invoice cursor pagination

`GET /api/invoices` supports opaque cursor pagination while retaining the
existing offset parameters for clients that have not migrated yet. Cursor mode
is the recommended mode for long-running scans and synchronizers.

## Request

```http
GET /api/invoices?limit=50&sortBy=created_at&order=desc
```

The first request omits `cursor`. If the response reports `meta.hasMore: true`,
pass its `meta.nextCursor` unchanged to the next request:

```http
GET /api/invoices?limit=50&sortBy=created_at&order=desc&cursor=<opaque-value>
```

The cursor is a signed, base64url-encoded position. It contains the selected
sort value, the unique database `id` tiebreaker, and an issued-at timestamp.
Clients must treat it as opaque: do not parse it, generate it, or use it as an
offset. The signature means a changed or truncated cursor is rejected rather
than interpreted as a different position.

## Stable ordering

The service always orders by two columns:

1. the requested sort column (`created_at`, `date`, or `amount`); and
2. `id` in the same direction as the primary sort.

The second key is required even when the primary value is unique in current
data. It makes ties deterministic and lets the keyset predicate resume after
one exact row:

```text
ascending:  sort_key > cursor_key OR (sort_key = cursor_key AND id > cursor_id)
descending: sort_key < cursor_key OR (sort_key = cursor_key AND id < cursor_id)
```

When a new row is inserted after page one, a descending scan does not jump
backward to include it in the already-issued scan. Existing rows after the
cursor remain eligible once, and the database does not pay the cost of a large
offset. Start a new scan when newly inserted rows should be included.

## Page size and response

`limit` is a positive integer. The HTTP validator clamps values above 100 to
100, and the service applies the same bound for non-HTTP callers. Missing or
unusable values use the default of 10. This prevents a script or internal job
from bypassing the endpoint limit.

Cursor responses keep the established envelope:

```json
{
  "data": [],
  "meta": {
    "total": 123,
    "limit": 50,
    "hasMore": true,
    "nextCursor": "opaque-value"
  },
  "message": "Invoices retrieved successfully."
}
```

At the end of the result set, `hasMore` is `false` and `nextCursor` is
`null`. The total is informational and may change between requests; it is not
used to calculate the cursor position.

## Sort and cursor compatibility

The sort alias and direction must remain constant for a cursor scan. A cursor
created for one sort field is rejected when it is supplied with another sort
field. Filters are applied before the keyset predicate, so a scan should keep
the same filters across requests. To change filters, direction, or sort field,
start over without a cursor.

Malformed, expired, tampered, or sort-incompatible cursors return HTTP 400
with the cursor field error. No internal query, offset, or database details are
included in that response.

## Migration from offset mode

Offset requests remain available for backward compatibility:

```http
GET /api/invoices?page=3&limit=50
```

New consumers should prefer the cursor flow. Offset mode can drift when rows
are inserted or removed during a scan and becomes increasingly expensive as
the page number grows. Cursor mode is bounded, resumable, and suitable for
large exports.
