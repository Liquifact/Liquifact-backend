# Metrics Request Input Validation

How the SME metrics endpoints validate and bound incoming request data, and what
a client receives when validation fails.

- Schemas: [`src/schemas/metrics.js`](../src/schemas/metrics.js)
- Error codes: [`src/constants/metricsValidationCodes.js`](../src/constants/metricsValidationCodes.js)
- Routes: [`src/routes/sme/metrics.js`](../src/routes/sme/metrics.js)

## Design rule

**Reject, don't repair.** Validation runs in middleware ahead of every handler,
so a malformed payload never reaches `invoiceService` or the database. Where the
old code quietly substituted a value for bad input — clamping an oversized
`limit`, or dropping a non-numeric one — it now returns a structured `400`. A
silently repaired request is indistinguishable from a correct one to the caller,
which hides client bugs and makes a request's effective parameters unauditable.

The one deliberate exception is **unknown query parameters**, which are stripped
rather than rejected: proxies, load balancers and analytics tooling routinely
append their own (`utm_source`, and similar), and rejecting them would break
legitimate traffic. Unknown fields in a request *body* are rejected, because
nothing appends to a JSON body in transit.

## Bounds

| Endpoint | Field | Type | Bound |
| --- | --- | --- | --- |
| `GET /api/sme/metrics` | `cursor` | string, optional | 1–512 chars (trimmed) |
| `GET /api/sme/metrics` | `limit` | integer string, optional | 1–100 inclusive |
| `POST /api/sme/metrics/bulk` | `operations` | array, required | 1–25 items |
| `POST /api/sme/metrics/bulk` | `operations[].tenantId` | string, required | 1–128 chars (trimmed) |
| `POST /api/sme/metrics/bulk` | `operations[].userId` | string, required | 1–128 chars (trimmed) |

Bounds are exported as constants (`GET_METRICS_LIMIT_MIN`,
`GET_METRICS_LIMIT_MAX`, `GET_METRICS_CURSOR_MAX_LENGTH`,
`MAX_BULK_OPERATIONS`, `BULK_METRICS_ID_MAX_LENGTH`) so tests and callers assert
against the same source as the schema.

Lengths are measured **after** trimming, so surrounding whitespace does not
consume a field's budget. Type coercion is off: `tenantId: 123` is a type error,
not the string `"123"`.

`limit` must be a bare, optionally-signed integer. A regex gate (`/^-?\d+$/`)
runs before numeric parsing, so `20abc`, `1e5`, `10.5`, `0x10`, `Infinity` and
whitespace-only values are all rejected — `parseInt` would have accepted the
first two and `Number` the fourth.

## Failure response

Validation failures are RFC 7807 `problem+json` documents:

```json
{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "code": "METRICS_VALIDATION_ERROR",
  "fieldErrors": {
    "operations.0.userId": ["userId must not exceed 128 characters"]
  },
  "fieldCodes": {
    "operations.0.userId": ["FIELD_TOO_LONG"]
  }
}
```

`fieldErrors` and `fieldCodes` share the same keys — a dotted path to the
offending field, so array items are addressable (`operations.2.tenantId`).
Unknown-key issues are expanded to one entry per offending key, so the response
names *which* field was rejected rather than only its parent object.

### Why both maps

`fieldErrors` carries human-readable messages whose wording is free to change.
`fieldCodes` carries stable codes. Clients should branch on codes; messages are
for display and logs. Before this, distinguishing "wrong type" from "too long"
required string-matching a message, which breaks silently on any rewording.

### Codes

| Code | Meaning |
| --- | --- |
| `FIELD_REQUIRED` | Required field absent or `undefined` |
| `FIELD_TYPE_INVALID` | Present but wrong JSON type |
| `FIELD_TOO_SHORT` | String below minimum length (includes empty/whitespace-only) |
| `FIELD_TOO_LONG` | String above maximum length |
| `VALUE_BELOW_MINIMUM` | Number below its minimum |
| `VALUE_ABOVE_MAXIMUM` | Number above its maximum |
| `VALUE_NOT_INTEGER` | Non-integer where an integer is required |
| `ARRAY_TOO_SMALL` | Array below minimum item count |
| `ARRAY_TOO_LARGE` | Array above maximum item count |
| `UNKNOWN_FIELD` | Field not declared in the schema |
| `FIELD_FORMAT_INVALID` | String failed a format/pattern check |
| `FIELD_INVALID` | Fallback for anything not covered above |

The top-level `code` is always `METRICS_VALIDATION_ERROR`; the table above lists
per-field codes. Array and string size failures map to distinct codes, so a
26-item `operations` array (`ARRAY_TOO_LARGE`) is never confused with a
129-character id (`FIELD_TOO_LONG`).

Codes are a bounded, frozen set. A schema raising a custom Zod issue can name
its own code via `params.metricsCode`, but an unrecognised value is discarded
and falls back to normal classification, so a typo cannot reach the wire.

## Status codes

`400` for validation failures, from both the body and query validators. Note
that `src/middleware/metricsErrorHandler.js` maps its own
`VALIDATION_ERROR` code to `422`; that handler covers a different set of
metrics routes and is not in this path. The SME metrics validators return `400`,
matching the documented Swagger contract and the pre-existing behaviour.

## Tests

| File | Scope |
| --- | --- |
| [`tests/unit/metricsValidationCodes.test.js`](../tests/unit/metricsValidationCodes.test.js) | Zod-issue-to-code mapping, both Zod 3 (`type`) and Zod 4 (`origin`) size spellings, fallbacks |
| [`tests/unit/metrics.inputHardening.test.js`](../tests/unit/metrics.inputHardening.test.js) | Bounds at exact boundaries, wrong types, unknown fields, `fieldCodes` assembly |
| [`tests/sme.metrics.validation.test.js`](../tests/sme.metrics.validation.test.js) | End-to-end HTTP behaviour, plus assertions that the store is never queried on invalid input |
| [`tests/unit/metrics.schema.test.js`](../tests/unit/metrics.schema.test.js) | Pre-existing schema surface (updated for the new `limit` semantics) |
| [`tests/sme.metrics.test.js`](../tests/sme.metrics.test.js) | Pre-existing route behaviour (updated for the new `limit` semantics) |

Boundary coverage is symmetric: each bound is tested at the last accepted value
and the first rejected one (128/129 chars, 512/513 chars, 1 and 100 for `limit`,
25/26 operations).
