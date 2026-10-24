# PATCH Invoice Field Guard

> **Source of truth:** `src/middleware/patchInvoice.js`
> Applied to `PATCH /v1/invoices/:id` via `validatePatchFields`.

## Overview

The field guard middleware enforces strict field-level mutability rules on
invoice update requests. It runs before the route handler and performs three
jobs:

1. **Prototype-pollution defence** — rejects any body that owns a dangerous
   key (`__proto__`, `constructor`, `prototype`) before any other checks.
2. **Unknown field rejection** — any key not in `MUTABLE_FIELDS` triggers a
   `422` response with an RFC 7807 problem detail listing every rejected key
   in a `fieldErrors` map. Unlike the previous behaviour, unknown fields are
   **never silently stripped**.
3. **Sanitized extraction** — builds `req.sanitizedUpdate` from the validated
   body, containing only the allowed mutable fields.

---

## Exported constants

| Constant | Type | Values |
|---|---|---|
| `MUTABLE_FIELDS` | `Set<string>` | `amount`, `customer`, `notes` |
| `PENDING_ONLY_FIELDS` | `Set<string>` | `amount`, `customer` |
| `LOCKED_STATUSES` | `Set<string>` | `verified`, `funded`, `settled`, `cancelled` |
| `DANGEROUS_KEYS` | `Set<string>` | `__proto__`, `constructor`, `prototype` |

---

## Field × status mutability matrix

| Field | `draft` | `pending` | `verified` | `funded` | `settled` | `cancelled` |
|---|---|---|---|---|---|---|
| `amount` | ✅ editable | ✅ editable | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked |
| `customer` | ✅ editable | ✅ editable | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked |
| `notes` | ✅ editable | ✅ editable | ✅ editable | ✅ editable | ✅ editable | ✅ editable |

Attempts to update a locked field return `HTTP 422 Unprocessable Entity` from
the route handler (after `detectLockedFieldChange` is called with the
sanitized payload and the invoice's current status).

---

## Exported functions

### `validatePatchFields(req, res, next)`

Express middleware. Called first on `PATCH /v1/invoices/:id`.

| Condition | Response |
|---|---|
| Body is not a plain object (string, number, array, null, undefined) | `400` — `"Request body must be a JSON object."` |
| Body owns `__proto__`, `constructor`, or `prototype` key | `400` — `"Request body must be a JSON object."` |
| Body contains keys not in `MUTABLE_FIELDS` | `422` — RFC 7807 problem detail with `fieldErrors` map listing each rejected key |
| Body contains no keys from `MUTABLE_FIELDS` (empty `{}`) | `422` — RFC 7807 problem detail with `fieldErrors._root` message |
| Body valid | Attaches `req.sanitizedUpdate`; calls `next()` |

### `extractAllowedFields(body)`

Pure function. Returns a new object containing only the keys present in both
`MUTABLE_FIELDS` and absent from `DANGEROUS_KEYS`. Called **after** the
unknown-field rejection check has already rejected any invalid keys.

```js
// After unknown-field rejection has passed, only mutable keys remain:
extractAllowedFields({ amount: 100, notes: 'hi' })
// → { amount: 100, notes: 'hi' }
```

### `detectLockedFieldChange(payload, status)`

Pure function. Returns `{ locked: boolean, field?: string }`.

```js
detectLockedFieldChange({ amount: 500 }, 'funded')
// → { locked: true, field: 'amount' }

detectLockedFieldChange({ notes: 'update' }, 'settled')
// → { locked: false }

detectLockedFieldChange({ amount: 100 }, 'draft')
// → { locked: false }
```

---

## Security notes

- `Object.prototype.hasOwnProperty.call` is used throughout instead of
  `body.hasOwnProperty` to remain safe on `Object.create(null)` objects.
- `DANGEROUS_KEYS` has no overlap with `MUTABLE_FIELDS`, so the double-guard
  (both `extractAllowedFields` and `validatePatchFields`) is belt-and-suspenders
  and carries no false-positive risk.
- The `PENDING_ONLY_FIELDS` lock is enforced in the route handler
  (`detectLockedFieldChange`), not inside the middleware, so the middleware
  stays stateless and reusable across routes that share different lock policies.

---

## Test coverage

The guard is exercised by two test files:

- **`tests/patchInvoice.guard.test.js`** — 84 pure unit tests covering the
  original guard logic, prototype pollution, locked statuses, and field
  extraction (~100% branch coverage).
- **`tests/patchInvoice.strict.test.js`** — comprehensive tests covering the
  new strict unknown-field rejection (422), empty payload rejection,
  RFC 7807 envelope validation, happy-path pass-through, and edge cases.

Run both with:

```bash
npm test -- --testPathPatterns="patchInvoice"
```
