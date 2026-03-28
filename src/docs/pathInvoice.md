# LiquiFact API — PATCH Invoice Endpoint

## Overview

`PATCH /api/invoices/:id` provides controlled, partial updates to invoice records. It enforces:

- **Field allowlisting** — only `amount`, `customer`, and `notes` may be changed; any other key in the request body is silently stripped.
- **Status-aware locking** — once an invoice moves past `pending_verification` (into `verified`, `funded`, `settled`, or `cancelled`), the financially sensitive fields `amount` and `customer` become immutable. `notes` stays editable throughout.
- **Soft-delete guard** — soft-deleted invoices must be restored before they can be updated.

---

## Endpoint

```
PATCH /api/invoices/:id
Content-Type: application/json
```

### Request body

| Field      | Type            | Always editable? | Notes                                    |
|------------|-----------------|-----------------|------------------------------------------|
| `amount`   | number / string | No              | Locked once status leaves `pending_verification` |
| `customer` | string          | No              | Locked once status leaves `pending_verification` |
| `notes`    | string          | Yes             | Free-text annotation; editable at any status |

Unknown or system-managed fields (`id`, `status`, `createdAt`, `deletedAt`, etc.) are **ignored**, never applied.

---

## Status machine & field locking

```
pending_verification  ──►  verified  ──►  funded  ──►  settled
                               │
                               └──────────────────────►  cancelled
```

| Invoice status         | `amount` editable? | `customer` editable? | `notes` editable? |
|------------------------|--------------------|----------------------|-------------------|
| `pending_verification` | ✅                  | ✅                    | ✅                 |
| `verified`             | ❌                  | ❌                    | ✅                 |
| `funded`               | ❌                  | ❌                    | ✅                 |
| `settled`              | ❌                  | ❌                    | ✅                 |
| `cancelled`            | ❌                  | ❌                    | ✅                 |

---

## Response examples

### Success — `200 OK`

```json
{
  "data": {
    "id": "inv_1719000000000_42",
    "amount": 5000,
    "customer": "Acme Corp",
    "notes": "Net 30 terms",
    "status": "pending_verification",
    "createdAt": "2024-06-22T10:00:00.000Z",
    "updatedAt": "2024-06-22T10:05:00.000Z",
    "deletedAt": null
  },
  "message": "Invoice updated successfully."
}
```

### No valid fields — `400 Bad Request`

```json
{
  "error": "No valid fields provided. Allowed fields: amount, customer, notes."
}
```

### Locked field attempt — `422 Unprocessable Entity`

```json
{
  "error": "Field \"amount\" cannot be changed once the invoice status is \"verified\"."
}
```

### Soft-deleted invoice — `409 Conflict`

```json
{
  "error": "Cannot update a soft-deleted invoice. Restore it first."
}
```

### Not found — `404 Not Found`

```json
{
  "error": "Invoice not found."
}
```

---

## Implementation

### Files changed / added

| File | Purpose |
|------|---------|
| `middleware/patchInvoice.js` | Field guard logic — allowlist extraction, locked-field detection, Express middleware |
| `index.js` | Route handler `PATCH /api/invoices/:id` wired to the middleware |
| `tests/patchInvoice.test.js` | Full integration + unit test suite |

### Key design decisions

**Allowlist over blocklist** — `MUTABLE_FIELDS` is a `Set` of explicitly permitted keys. New fields added to the invoice schema are locked by default until explicitly added to the set.

**Two-tier mutability** — `PENDING_ONLY_FIELDS` is a subset of `MUTABLE_FIELDS`. This separation makes it trivial to add more fields to either tier without touching control-flow logic.

**`Object.assign` over property-by-property assignment** — reduces surface area and keeps the update atomic within the synchronous handler. No partial-write risk.

**`Object.prototype.hasOwnProperty.call`** — used instead of `in` or direct `.hasOwnProperty` to guard against prototype-pollution payloads that could shadow the method.

---

## Running tests

```bash
npm test
```

Expected output: **42 tests passing**, `patchInvoice.js` at **100% coverage**.

```
Tests:       42 passed, 42 total
```

### Coverage summary

| File                      | Statements | Branches | Functions | Lines |
|---------------------------|------------|----------|-----------|-------|
| `middleware/patchInvoice.js` | 100%    | 100%     | 100%      | 100%  |

---

## Security notes

| Concern | Mitigation |
|---------|-----------|
| Mass assignment | Strict `MUTABLE_FIELDS` allowlist; unknown keys are discarded before any write |
| Prototype pollution | `Object.prototype.hasOwnProperty.call` guards; `express.json()` parses with `Object.create(null)`-safe reviver |
| Status spoofing | `status` is not in `MUTABLE_FIELDS`; it can only be changed via a dedicated (future) status-transition endpoint |
| Deleted record mutation | 409 guard prevents writes to soft-deleted invoices |
| ID spoofing | `id` is not in `MUTABLE_FIELDS` and is never overwritten |

---

## Example `curl` commands

```bash
# Update notes (always allowed)
curl -X PATCH http://localhost:3001/api/invoices/inv_123 \
  -H 'Content-Type: application/json' \
  -d '{"notes": "Payment terms updated to Net 60"}'

# Update amount on a pending invoice
curl -X PATCH http://localhost:3001/api/invoices/inv_123 \
  -H 'Content-Type: application/json' \
  -d '{"amount": 7500, "customer": "Globex Corp"}'

# Attempt to change a locked field (returns 422)
curl -X PATCH http://localhost:3001/api/invoices/inv_456 \
  -H 'Content-Type: application/json' \
  -d '{"amount": 99999}'
```