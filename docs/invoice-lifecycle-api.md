# Invoice Lifecycle State Machine API

## Overview

The Invoice Lifecycle API implements a tenant-scoped state machine for managing invoice transitions through the LiquiFact platform. The state machine enforces strict transition rules and maintains a complete, append-only audit trail of every state change.

**Persistence:** Invoice state is stored in the tenant-scoped `invoices` table via Knex. Every transition handler resolves the invoice with `invoiceService.resolveInvoiceForTenant(invoiceId, tenantId)` and, after a successful `executeTransition()` call from the state machine (`src/services/invoiceStateMachine.js`), persists the resulting `status` via `invoiceService.updateInvoice()`. **Status is never accepted from the client request body** — the only client-controlled input is `targetState` (or an implicit target on the convenience endpoints), which must pass state-machine validation before anything is written.

**Tenant isolation:** Every route in this router mounts the `extractTenant` middleware. Tenant context is resolved from the `x-tenant-id` header or a `tenantId` claim on the authenticated JWT. Requests without a resolvable tenant are rejected with `400`. Invoices belonging to another tenant are indistinguishable from invoices that don't exist — both return `404 INVOICE_NOT_FOUND`.

**Response envelope:** Success and error responses use the standardized envelope from `src/utils/responseHelper.js` (`data`, `meta`, `error` fields), with a human-readable `message` field attached at the top level.

## State Machine

Implemented in [`src/services/invoiceStateMachine.js`](../src/services/invoiceStateMachine.js).

### States

- **pending**: Initial state when an invoice is created
- **approved**: Invoice has been verified and approved
- **linked_escrow**: Invoice is linked to an escrow contract (terminal state)
- **rejected**: Invoice was rejected during verification (terminal state)
- **cancelled**: Invoice was cancelled (terminal state)

### Valid Transitions

```
pending → approved
pending → rejected
pending → cancelled

approved → linked_escrow
approved → cancelled

linked_escrow → (none — terminal)
rejected → (none — terminal)
cancelled → (none — terminal)
```

### Transition Rules

1. **No silent jumps** — e.g. `pending → linked_escrow` is rejected with `INVALID_TRANSITION`.
2. **Terminal states** — once an invoice reaches `linked_escrow`, `rejected`, or `cancelled`, no further transitions are allowed (`TERMINAL_STATE`).
3. **Reason required for terminal targets** — transitions into `rejected` or `cancelled` require a non-empty reason (after control-character stripping and trimming), capped at 1024 characters.
4. **Audit trail** — every successful transition creates an immutable `STATE_TRANSITION` audit log entry (actor, before/after state, reason, IP, user agent).
5. **Tenant scoping** — the invoice is always re-resolved for the caller's tenant before any transition is attempted.

## API Endpoints

All endpoints are mounted under `/api/invoices` (see [`src/routes/invoiceStateRoutes.js`](../src/routes/invoiceStateRoutes.js)) and require an `x-tenant-id` header (or a JWT `tenantId` claim).

### 1. Get Invoice State

**`GET /api/invoices/:id/state`**

Returns the current state and allowed transitions for an invoice.

```json
{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "pending",
    "allowedTransitions": ["approved", "rejected", "cancelled"],
    "isTerminal": false
  },
  "meta": { "timestamp": "2026-07-24T10:30:00.000Z", "version": "0.1.0" },
  "error": null,
  "message": "Invoice state retrieved successfully"
}
```

### 2. Execute State Transition

**`POST /api/invoices/:id/transition`**

Generic transition endpoint driven entirely by the state machine.

Request body:
```json
{ "targetState": "approved", "reason": "Invoice verified and approved by finance team" }
```

Success response:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "approved",
    "transitionedAt": "2026-07-24T10:30:00.000Z",
    "transitionedBy": "user-123",
    "reason": "Invoice verified and approved by finance team",
    "auditLogId": "AUDIT-1714132200000-abc123def"
  },
  "message": "Invoice transitioned from pending to approved"
}
```

Invalid-transition error response:
```json
{
  "data": null,
  "error": {
    "message": "Invalid state transition from pending to linked_escrow. Allowed transitions: approved, rejected, cancelled",
    "code": "INVALID_TRANSITION",
    "details": { "allowedTransitions": ["approved", "rejected", "cancelled"] }
  }
}
```

### 3. Approve Invoice

**`POST /api/invoices/:id/approve`** — convenience wrapper for `pending → approved`.

Request body: `{ "reason": "All verification checks passed" }` (optional; defaults to `"Invoice approved"`).

### 4. Link Invoice to Escrow

**`POST /api/invoices/:id/link-escrow`** — convenience wrapper for `approved → linked_escrow`.

This is a **capital-movement endpoint** and is gated by `requireKycForFunding` followed by `auditKycAccess` (see [`src/middleware/kycGating.js`](../src/middleware/kycGating.js)): the caller's authenticated SME must hold a `verified` or `exempted` KYC status, or the request is rejected with `403 KYC_GATE_FAILED` before the invoice is even looked up. A successful access is logged via `auditKycAccess` for compliance review.

Request body: `{ "escrowId": "escrow-123", "reason": "Escrow contract created on Stellar" }` (`escrowId` is optional; when provided it is persisted into the invoice's `metadata.escrowId`).

Business rule beyond the core state machine: `canLinkToEscrow()` additionally requires the invoice to currently be `approved` — attempting to link a `pending` or already-`linked_escrow` invoice returns `400 CANNOT_LINK_TO_ESCROW`.

### 5. Reject Invoice

**`POST /api/invoices/:id/reject`** — convenience wrapper for `* → rejected`.

Request body: `{ "reason": "Invalid documentation provided" }`. `reason` is **required** — a missing or blank reason returns `400 MISSING_TRANSITION_REASON` before the state machine is even consulted.

### 6. Get Transition History

**`GET /api/invoices/:id/history`**

Returns the full, tenant-scoped audit trail for an invoice, most recent first.

```json
{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "linked_escrow",
    "transitions": [
      {
        "id": "AUDIT-1714134000000-def456",
        "timestamp": "2026-07-24T11:00:00.000Z",
        "actor": "user-123",
        "fromState": "approved",
        "toState": "linked_escrow",
        "reason": "Escrow contract created on Stellar",
        "ipAddress": "192.168.1.100"
      }
    ],
    "totalTransitions": 1
  },
  "message": "Invoice transition history retrieved successfully"
}
```

## Error Codes

| Code | Description | HTTP Status |
|------|-------------|-------------|
| `INVOICE_NOT_FOUND` | Invoice does not exist, is soft-deleted, or belongs to another tenant | 404 |
| `MISSING_TARGET_STATE` | `targetState` not provided on `/transition` | 400 |
| `MISSING_TRANSITION_REASON` | Reason required (terminal target, or `/reject`) but absent/blank | 400 |
| `TRANSITION_REASON_TOO_LONG` | Reason exceeds 1024 characters | 400 |
| `ALREADY_IN_TARGET_STATE` | Invoice is already in the requested state | 400 |
| `TERMINAL_STATE` | Invoice's current state does not permit further transitions | 400 |
| `INVALID_TRANSITION` | Requested transition is not in the allowed-transition table | 400 |
| `CANNOT_LINK_TO_ESCROW` | Invoice is not in `approved` state | 400 |
| `KYC_GATE_FAILED` | SME's KYC status does not permit the capital-moving `link-escrow` operation | 403 |
| `MISSING_SME_ID` | Authenticated principal has no `smeId` claim (required for the KYC gate) | 400 |

## Audit Trail

Every successful transition creates an immutable entry via `createAuditLog()` (`src/services/auditLog.js`), persisted to the append-only `audit_log_events` table:

```json
{
  "id": "AUDIT-1714132200000-abc123",
  "timestamp": "2026-07-24T10:30:00.000Z",
  "actor": "user-123",
  "action": "STATE_TRANSITION",
  "resourceType": "invoice",
  "resourceId": "inv-001",
  "changes": { "before": { "state": "pending" }, "after": { "state": "approved" } },
  "statusCode": 200,
  "ipAddress": "192.168.1.100",
  "userAgent": "Mozilla/5.0...",
  "metadata": {
    "reason": "Invoice verified",
    "transitionType": "pending_to_approved",
    "method": "POST",
    "path": "/api/invoices/inv-001/approve"
  }
}
```

## Capital Moving States Gating

Beyond the `pending`/`approved`/`linked_escrow`/`rejected`/`cancelled` lifecycle covered by this router, `CAPITAL_MOVING_STATES` (`src/services/invoiceStateMachine.js`) identifies funding-progress statuses that involve the reallocation of funds and therefore require KYC verification wherever they are reached:

* `funded`
* `settled`

`kycGatingMiddleware` (`src/middleware/kycGating.js`) blocks any request whose target state is in this set unless the caller is KYC-verified. This is used by the investor funding flow (`src/routes/invest.js`); it is distinct from the `requireKycForFunding` gate on `POST /api/invoices/:id/link-escrow` described above.

## Security Considerations

- **Tenant scoping**: all reads/writes are scoped by `invoice_id` **and** `tenant_id`; cross-tenant IDs return `404` rather than `403`, so tenant existence is never leaked.
- **Status is never client-overridable**: the request body's only meaningful input is `targetState` (or is implicit on the convenience endpoints); the persisted `status` always comes from the state machine's `executeTransition()` result.
- **KYC gate on capital movement**: `POST /:id/link-escrow` requires `requireKycForFunding` to pass before the invoice is resolved or any transition is attempted.
- **Actor resolution**: the acting principal is taken from `req.user.id`/`req.user.sub` (JWT), falling back to the request IP only when no authenticated user is present.
- **Reason sanitization**: control characters are stripped and the string is trimmed before being persisted to the audit log, mitigating log-injection via the `reason` field.

## Testing

```bash
npm test tests/invoice.state.test.js
npm run test:coverage -- tests/invoice.state.test.js
npm run lint:new
```

`tests/invoice.state.test.js` exercises the full transition matrix (valid and invalid pairs), terminal-state rejection, reason validation/sanitization, audit-log emission, and the route layer (tenant isolation, cross-tenant 404s, KYC-gated `link-escrow`, and unexpected-error propagation).
