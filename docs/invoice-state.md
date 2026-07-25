# Invoice-State API Reference

> **Source of truth:** `src/routes/invoiceStateRoutes.js` mounted at `/api/invoices` in `src/app.js`.
> All state-machine logic lives in `src/services/invoiceStateMachine.js`.

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication & Tenant Context](#2-authentication--tenant-context)
3. [Invoice Lifecycle States](#3-invoice-lifecycle-states)
4. [Valid Transition Matrix](#4-valid-transition-matrix)
5. [Endpoints](#5-endpoints)
   - [GET /api/invoices/:id/state](#51-get-apiinvoicesidstate)
   - [POST /api/invoices/:id/transition](#52-post-apiinvoicesidtransition)
   - [POST /api/invoices/:id/approve](#53-post-apiinvoicesidapprove)
   - [POST /api/invoices/:id/link-escrow](#54-post-apiinvoicesidlink-escrow)
   - [POST /api/invoices/:id/reject](#55-post-apiinvoicesidreject)
   - [GET /api/invoices/:id/history](#56-get-apiinvoicesidhistory)
6. [Error Reference](#6-error-reference)
7. [Audit Log Behaviour](#7-audit-log-behaviour)

---

## 1. Overview

The invoice-state sub-API manages the lifecycle of an invoice from creation to
final disposition. It enforces a strict state machine: only the transitions
enumerated in [Section 4](#4-valid-transition-matrix) are permitted. Every
successful transition creates an immutable Audit_Log entry and atomically
persists the new status to the database.

**Base path:** `/api/invoices`

All six routes under this path are owned by the Invoice_State_Router. They
share the same tenant-isolation model (one tenant cannot read or mutate another
tenant's invoices) and the same RFC 7807 error envelope.


---

## 2. Authentication & Tenant Context

### Required headers (all endpoints)

| Header | Required | Description |
|--------|----------|-------------|
| `x-tenant-id` | **Yes** (unless JWT carries `tenantId` claim) | Identifies the tenant. Resolved by `extractTenant` middleware. Max 128 characters, trimmed. |
| `Authorization: Bearer <token>` | Depends on route | Some routes use `authenticateToken` middleware for JWT validation. The invoice-state routes primarily rely on `req.user` being populated (e.g. by upstream middleware) to identify the `actor` for audit logging. |

### Tenant resolution order

1. `x-tenant-id` request header (highest priority).
2. `tenantId` claim in the decoded JWT attached at `req.user.tenantId`.

If neither source yields a valid tenant ID the server returns:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Missing tenant context.",
  "message": "A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim."
}
```

### KYC gating (link-escrow only)

`POST /api/invoices/:id/link-escrow` additionally runs the `requireKycForFunding`
middleware. It reads the authenticated principal's `smeId` claim and verifies
the KYC status with `kycService.getKycStatus(smeId)`. Only statuses that pass
`kycService.canFundWithKycStatus()` are permitted through.


---

## 3. Invoice Lifecycle States

Defined in `src/services/invoiceStateMachine.js` as `INVOICE_STATES`.

| State | Value | Terminal? | Capital-Moving? | Reason Required to Enter? |
|-------|-------|-----------|-----------------|--------------------------|
| Pending | `pending` | No | No | No |
| Approved | `approved` | No | No | No |
| Linked Escrow | `linked_escrow` | **Yes** | No | No |
| Rejected | `rejected` | **Yes** | No | **Yes** |
| Cancelled | `cancelled` | **Yes** | No | **Yes** |

> **Terminal states** (`linked_escrow`, `rejected`, `cancelled`, `completed`,
> `defaulted`, `settled`) reject all further transitions with a `TERMINAL_STATE`
> error code.
>
> **Capital-moving states** (`funded`, `settled`) are defined in
> `CAPITAL_MOVING_STATES` and trigger KYC gating when targeted. These states
> are reachable through funding/settlement flows outside the core state-machine
> routes documented here.


---

## 4. Valid Transition Matrix

Source: `VALID_TRANSITIONS` in `src/services/invoiceStateMachine.js`.

| From ↓ \ To → | `pending` | `approved` | `linked_escrow` | `rejected` | `cancelled` |
|---------------|-----------|-----------|-----------------|------------|-------------|
| `pending`     | ✗ | ✓ | ✗ | ✓ *(reason req.)* | ✓ *(reason req.)* |
| `approved`    | ✗ | ✗ | ✓ | ✗ | ✓ *(reason req.)* |
| `linked_escrow` | ✗ | ✗ | ✗ | ✗ | ✗ |
| `rejected`    | ✗ | ✗ | ✗ | ✗ | ✗ |
| `cancelled`   | ✗ | ✗ | ✗ | ✗ | ✗ |

**Rules enforced by the state machine:**

- **No reversals.** Once an invoice moves forward it cannot go back (e.g. `approved → pending` is forbidden).
- **No silent jumps.** `pending → linked_escrow` is not allowed; the invoice must pass through `approved` first.
- **Terminal states are sinks.** Once in `linked_escrow`, `rejected`, or `cancelled`, the invoice accepts no further transitions.
- **Reason is mandatory for terminal target states.** Attempting to transition to `rejected` or `cancelled` without a non-empty reason returns `MISSING_TRANSITION_REASON`.


---

## 5. Endpoints

### 5.1 GET /api/invoices/:id/state

Returns the current lifecycle state of an invoice and the transitions available from that state.

#### Request

```http
GET /api/invoices/{id}/state
x-tenant-id: {tenantId}
```

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The public `invoice_id` (e.g. `inv-001`). |

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `x-tenant-id` | Yes | Tenant identifier. Resolved by `extractTenant`. |

**Query parameters:** None.

**Request body:** None.

#### Response — 200 OK

```json
{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "pending",
    "allowedTransitions": ["approved", "rejected", "cancelled"],
    "isTerminal": false
  }
}
```

**Response body schema**

| Field | Type | Description |
|-------|------|-------------|
| `data.invoiceId` | string | The `invoice_id` from the path. |
| `data.currentState` | string | Current lifecycle state value. |
| `data.allowedTransitions` | string[] | States the invoice can legally transition to. Empty array for terminal invoices. |
| `data.isTerminal` | boolean | `true` when no further transitions are possible. |

#### Example — terminal invoice

```http
GET /api/invoices/inv-003/state
x-tenant-id: tenant-alpha
```

```json
{
  "data": {
    "invoiceId": "inv-003",
    "currentState": "linked_escrow",
    "allowedTransitions": [],
    "isTerminal": true
  }
}
```


#### Errors — GET /:id/state

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | — (missing tenant message) | `x-tenant-id` header absent and no JWT `tenantId` claim. |
| 404 | `INVOICE_NOT_FOUND` | Invoice does not exist or belongs to a different tenant. |

```json
{
  "error": {
    "code": "INVOICE_NOT_FOUND",
    "message": "Invoice not found"
  }
}
```

---

### 5.2 POST /api/invoices/:id/transition

Generic transition endpoint. Moves the invoice from its current state to any
valid `targetState`. Use the [dedicated shortcuts](#53-post-apiinvoicesidapprove)
for `approve`, `link-escrow`, and `reject` when building human-facing flows.

#### Request

```http
POST /api/invoices/{id}/transition
Content-Type: application/json
x-tenant-id: {tenantId}
```

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Public `invoice_id`. |

**Request body schema**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `targetState` | string | **Yes** | One of the lifecycle state values | The desired new state. |
| `reason` | string | Conditional | 1–1 024 chars; control characters stripped | Required when `targetState` is `rejected` or `cancelled`. Optional otherwise. |

```json
{
  "targetState": "approved",
  "reason": "Invoice verified by finance team"
}
```


#### Response — 200 OK

```json
{
  "data": {
    "previousState": "pending",
    "currentState": "approved",
    "transitionedBy": "user-123",
    "reason": "Invoice verified by finance team",
    "auditLogId": "audit-7f3a29b1"
  },
  "message": "Invoice transitioned to approved successfully"
}
```

**Response body schema**

| Field | Type | Description |
|-------|------|-------------|
| `data.previousState` | string | State before the transition. |
| `data.currentState` | string | State after the transition (equals `targetState`). |
| `data.transitionedBy` | string | Actor ID from `req.user.id` / `req.user.sub`. |
| `data.reason` | string | Normalized reason (control chars stripped). |
| `data.auditLogId` | string | ID of the created Audit_Log entry. |

#### Errors — POST /:id/transition

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | `MISSING_TARGET_STATE` | `targetState` field absent from request body. |
| 400 | `INVALID_TARGET_STATE` | `targetState` value is not a known state. |
| 400 | `INVALID_TRANSITION` | Transition from current state to `targetState` is not in `VALID_TRANSITIONS`. |
| 400 | `TERMINAL_STATE` | Invoice is in a terminal state; no further transitions permitted. |
| 400 | `ALREADY_IN_TARGET_STATE` | `targetState` equals the invoice's current state. |
| 400 | `MISSING_TRANSITION_REASON` | `reason` absent or whitespace-only when targeting `rejected` or `cancelled`. |
| 400 | `TRANSITION_REASON_TOO_LONG` | `reason` exceeds 1 024 characters. |
| 404 | `INVOICE_NOT_FOUND` | Invoice not found for this tenant. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected error during transition persistence. |

**Example — invalid transition (400)**

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Invalid state transition from 'pending' to 'linked_escrow'",
    "details": {
      "allowedTransitions": ["approved", "rejected", "cancelled"]
    }
  }
}
```

**Example — missing reason (400)**

```json
{
  "error": {
    "code": "MISSING_TRANSITION_REASON",
    "message": "Reason is required when transitioning to a terminal state"
  }
}
```


---

### 5.3 POST /api/invoices/:id/approve

Convenience shortcut that hardcodes `targetState = "approved"`. Internally
calls `invoiceService.transitionInvoice` with the same pipeline as the generic
transition endpoint.

#### Request

```http
POST /api/invoices/{id}/approve
Content-Type: application/json
x-tenant-id: {tenantId}
```

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Public `invoice_id`. |

**Request body schema**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string | No | Optional human-readable reason (max 1 024 chars). |

```json
{
  "reason": "All documentation checks passed"
}
```

**Request body may be omitted entirely.** An empty object `{}` or a missing
body is accepted for approval.

#### Response — 200 OK

```json
{
  "data": {
    "previousState": "pending",
    "currentState": "approved",
    "transitionedBy": "user-123",
    "reason": "All documentation checks passed",
    "auditLogId": "audit-8a4c10d2"
  },
  "message": "Invoice approved successfully"
}
```

#### Errors — POST /:id/approve

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | `ALREADY_IN_TARGET_STATE` | Invoice is already in `approved` state. |
| 400 | `TERMINAL_STATE` | Invoice is in a terminal state. |
| 404 | `INVOICE_NOT_FOUND` | Invoice not found for this tenant. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected error. |

```json
{
  "error": {
    "code": "ALREADY_IN_TARGET_STATE",
    "message": "Invoice is already in the approved state"
  }
}
```


---

### 5.4 POST /api/invoices/:id/link-escrow

Transitions an `approved` invoice to `linked_escrow` and optionally associates
an on-chain escrow contract ID in the invoice metadata.

**KYC gating:** This route runs `requireKycForFunding` before the handler. The
authenticated principal must have a `smeId` claim, and `kycService.getKycStatus(smeId)`
must return a status that satisfies `kycService.canFundWithKycStatus()` (i.e. `verified` or `exempted`).

#### Request

```http
POST /api/invoices/{id}/link-escrow
Content-Type: application/json
Authorization: Bearer {token}
x-tenant-id: {tenantId}
```

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Public `invoice_id`. |

**Request body schema**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `escrowId` | string | No | On-chain escrow contract identifier. Stored in invoice `metadata.escrowId`. If omitted, `escrowId` is `null` in the response. |
| `reason` | string | No | Optional human-readable reason (max 1 024 chars). |

```json
{
  "escrowId": "CESCROW123AAABBBCCCDDDEEEFFFGGGHHH",
  "reason": "Soroban escrow contract deployed and funded"
}
```

#### Response — 200 OK

```json
{
  "data": {
    "previousState": "approved",
    "currentState": "linked_escrow",
    "transitionedBy": "user-456",
    "escrowId": "CESCROW123AAABBBCCCDDDEEEFFFGGGHHH",
    "reason": "Soroban escrow contract deployed and funded",
    "auditLogId": "audit-9b5d21e3"
  },
  "message": "Invoice linked to escrow successfully"
}
```

**Response body schema**

| Field | Type | Description |
|-------|------|-------------|
| `data.previousState` | string | State before the transition (`approved`). |
| `data.currentState` | string | Always `linked_escrow` on success. |
| `data.transitionedBy` | string | Actor ID. |
| `data.escrowId` | string \| null | The `escrowId` from the request body, or `null` if not provided. |
| `data.reason` | string | Normalized reason. |
| `data.auditLogId` | string | Audit log entry ID. |


#### Errors — POST /:id/link-escrow

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | `CANNOT_LINK_TO_ESCROW` | Invoice is not in `approved` state (e.g. still `pending` or already `linked_escrow`). |
| 400 | `MISSING_SME_ID` | Authenticated principal has no `smeId` claim. |
| 403 | `KYC_GATE_FAILED` | SME KYC status does not permit funding operations. |
| 404 | `INVOICE_NOT_FOUND` | Invoice not found for this tenant. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected error. |

**Example — invoice not in approved state (400)**

```json
{
  "error": {
    "code": "CANNOT_LINK_TO_ESCROW",
    "message": "Invoice must be in approved state to link to escrow"
  }
}
```

**Example — KYC gate failure (403)**

```json
{
  "error": {
    "code": "KYC_GATE_FAILED",
    "message": "SME KYC status 'pending' does not permit funding operations.",
    "retryable": false
  }
}
```

---

### 5.5 POST /api/invoices/:id/reject

Transitions a `pending` invoice to `rejected`. A non-empty `reason` is
**mandatory** — whitespace-only or absent reasons are rejected.

#### Request

```http
POST /api/invoices/{id}/reject
Content-Type: application/json
x-tenant-id: {tenantId}
```

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Public `invoice_id`. |

**Request body schema**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `reason` | string | **Yes** | 1–1 024 chars; control characters (U+0000–U+001F, U+007F) stripped before storage | Human-readable rejection reason. |

```json
{
  "reason": "Invalid supporting documentation — VAT registration number missing"
}
```

#### Response — 200 OK

```json
{
  "data": {
    "previousState": "pending",
    "currentState": "rejected",
    "transitionedBy": "user-789",
    "reason": "Invalid supporting documentation — VAT registration number missing",
    "auditLogId": "audit-c2e7f4a9"
  },
  "message": "Invoice rejected successfully"
}
```


#### Errors — POST /:id/reject

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | `MISSING_TRANSITION_REASON` | `reason` field absent, null, or whitespace-only. |
| 400 | `TRANSITION_REASON_TOO_LONG` | `reason` exceeds 1 024 characters. |
| 400 | `INVALID_TRANSITION` | Invoice is not in `pending` state (`approved → rejected` is not a valid transition). |
| 400 | `TERMINAL_STATE` | Invoice is already in a terminal state. |
| 404 | `INVOICE_NOT_FOUND` | Invoice not found for this tenant. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected error. |

**Example — missing reason (400)**

```json
{
  "error": {
    "code": "MISSING_TRANSITION_REASON",
    "message": "Reason is required when transitioning to a terminal state"
  }
}
```

**Example — attempting to reject an approved invoice (400)**

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Invalid state transition from 'approved' to 'rejected'",
    "details": {
      "allowedTransitions": ["linked_escrow", "cancelled"]
    }
  }
}
```

---

### 5.6 GET /api/invoices/:id/history

Returns the ordered audit trail of all state transitions for an invoice.
Transitions are returned most-recent-first.

#### Request

```http
GET /api/invoices/{id}/history
x-tenant-id: {tenantId}
```

**Path parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Public `invoice_id`. |

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `x-tenant-id` | Yes | Tenant identifier. |

**Query parameters:** None.

**Request body:** None.

#### Response — 200 OK

```json
{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "linked_escrow",
    "transitions": [
      {
        "fromState": "approved",
        "toState": "linked_escrow",
        "transitionedBy": "user-456",
        "reason": "Escrow contract deployed",
        "timestamp": "2024-08-15T14:32:00.000Z"
      },
      {
        "fromState": "pending",
        "toState": "approved",
        "transitionedBy": "user-123",
        "reason": "Documentation verified",
        "timestamp": "2024-08-15T09:10:00.000Z"
      }
    ],
    "totalTransitions": 2
  }
}
```


**Response body schema**

| Field | Type | Description |
|-------|------|-------------|
| `data.invoiceId` | string | The `invoice_id` from the path. |
| `data.currentState` | string | The invoice's current lifecycle state. |
| `data.transitions` | object[] | Ordered list of past transitions (most-recent-first). |
| `data.transitions[].fromState` | string | State before the transition. |
| `data.transitions[].toState` | string | State after the transition. |
| `data.transitions[].transitionedBy` | string | Actor who performed the transition. |
| `data.transitions[].reason` | string | Normalized reason (may be empty for non-terminal transitions). |
| `data.transitions[].timestamp` | string (ISO 8601) | When the transition occurred. |
| `data.totalTransitions` | number | Total number of transitions; equals `transitions.length`. |

**Empty history (invoice with no transitions)**

```json
{
  "data": {
    "invoiceId": "inv-002",
    "currentState": "pending",
    "transitions": [],
    "totalTransitions": 0
  }
}
```

#### Errors — GET /:id/history

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | — (missing tenant message) | `x-tenant-id` absent and no JWT `tenantId` claim. |
| 404 | `INVOICE_NOT_FOUND` | Invoice not found for this tenant. |

```json
{
  "error": {
    "code": "INVOICE_NOT_FOUND",
    "message": "Invoice not found"
  }
}
```


---

## 6. Error Reference

### 6.1 Error envelope format

All invoice-state endpoints return errors in one of two shapes depending on
the error source:

**Application-level errors** (state machine, validation, not-found):

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": { }
  }
}
```

**RFC 7807 Problem+JSON errors** (AppError, middleware):

```json
{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Human-readable explanation",
  "instance": "/api/invoices/inv-001/transition",
  "code": "VALIDATION_ERROR",
  "retryable": false,
  "retryHint": "Correct the highlighted fields and retry."
}
```

The `code` field is the machine-readable key used for programmatic error
handling. Always branch on `code` rather than `message` or `detail`.

### 6.2 Complete error code table

| Code | HTTP Status | Endpoint(s) | Description |
|------|-------------|-------------|-------------|
| `INVOICE_NOT_FOUND` | 404 | All | Invoice does not exist or belongs to a different tenant. |
| `MISSING_TARGET_STATE` | 400 | `/transition` | `targetState` field absent from request body. |
| `INVALID_TARGET_STATE` | 400 | `/transition` | `targetState` is not a recognized lifecycle state value. |
| `INVALID_CURRENT_STATE` | 400 | `/transition` | Invoice's current state is not a recognized lifecycle state (data integrity issue). |
| `INVALID_TRANSITION` | 400 | `/transition`, `/reject` | The `from → to` pair is not in `VALID_TRANSITIONS`. Includes `allowedTransitions` hint in `details`. |
| `TERMINAL_STATE` | 400 | All write endpoints | Invoice is in a terminal state; further transitions are blocked. |
| `ALREADY_IN_TARGET_STATE` | 400 | `/approve`, `/transition` | `targetState` equals the invoice's current state. |
| `MISSING_TRANSITION_REASON` | 400 | `/transition`, `/reject`, `/link-escrow` (if cancelled) | `reason` is required for the target state but was absent or whitespace-only. |
| `TRANSITION_REASON_TOO_LONG` | 400 | All write endpoints | `reason` exceeds 1 024 characters. |
| `CANNOT_LINK_TO_ESCROW` | 400 | `/link-escrow` | Invoice is not in `approved` state. |
| `MISSING_ACTOR` | 400 | All write endpoints | `req.user` is absent — the authenticated actor could not be resolved. |
| `KYC_GATE_FAILED` | 403 | `/link-escrow` | SME KYC status does not permit funding operations. |
| `MISSING_SME_ID` | 400 | `/link-escrow` | Authenticated principal has no `smeId` JWT claim. |
| `INTERNAL_SERVER_ERROR` | 500 | All | Unexpected server-side error. No retry without investigation. |

### 6.3 Missing tenant context (400)

Returned before the route handler executes when `extractTenant` cannot resolve
a tenant:

```json
{
  "error": "Missing tenant context.",
  "message": "A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim."
}
```

### 6.4 KYC gate errors (403)

Returned by `requireKycForFunding` on the `/link-escrow` route:

**Missing smeId:**

```json
{
  "error": {
    "code": "MISSING_SME_ID",
    "message": "Authenticated principal is missing smeId.",
    "retryable": false
  }
}
```

**Insufficient KYC status:**

```json
{
  "error": {
    "code": "KYC_GATE_FAILED",
    "message": "SME KYC status 'pending' does not permit funding operations.",
    "retryable": false
  }
}
```


---

## 7. Audit Log Behaviour

Every successful state transition creates an append-only Audit_Log entry via
`src/services/auditLog.js`. The entry is also returned in the transition
response as `auditLogId`.

### Audit log entry schema

| Field | Type | Description |
|-------|------|-------------|
| `actor` | string | User ID from `req.user.id` / `req.user.sub`. |
| `action` | string | Always `"STATE_TRANSITION"` for invoice-state events. |
| `resourceType` | string | Always `"invoice"`. |
| `resourceId` | string | The `invoiceId`. |
| `changes.before.state` | string | State before the transition. |
| `changes.after.state` | string | State after the transition. |
| `metadata.reason` | string | Normalized reason (control characters stripped). |
| `metadata.transitionType` | string | Composite key `"<from>_to_<to>"`. |
| `metadata.*` | any | Any additional metadata passed by the caller (e.g. `escrowId`, `method`). |
| `userAgent` | string | Value of the `User-Agent` request header. |
| `ipAddress` | string | Source IP address (`"unknown"` when not resolvable). |
| `timestamp` | string (ISO 8601) | When the audit entry was created. |

### Reason normalization rules

1. Non-string values (e.g. `42`) are coerced to string via `String()`.
2. Control characters in the Unicode ranges U+0000–U+001F and U+007F are
   stripped (replaced with empty string).
3. Leading and trailing whitespace is not stripped — only control characters.
4. After stripping, a whitespace-only string is treated as absent for
   terminal target states and triggers `MISSING_TRANSITION_REASON`.
5. Strings longer than 1 024 characters trigger `TRANSITION_REASON_TOO_LONG`
   **before** any stripping occurs.

### Cross-tenant isolation

Audit logs are queried by `resourceId`. Because `resourceId` is an
`invoice_id`, and `invoice_id` lookup is always tenant-scoped, audit logs
cannot leak between tenants through the history endpoint.

---

*Last updated: reflects source as of `src/routes/invoiceStateRoutes.js` and
`src/services/invoiceStateMachine.js`. Run `npm test -- tests/invoice.state.test.js`
to verify the documented contract against the live implementation.*
