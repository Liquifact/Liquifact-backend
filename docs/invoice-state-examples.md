# Invoice-State Endpoints — Runnable curl/HTTP Examples

Ready-to-run request and response examples for every endpoint in the
invoice-state API. All paths are relative to the base URL. Copy, paste, and
adjust the placeholder values to match your environment.

## Prerequisites

```bash
# Set these before running any example.
export BASE_URL="http://localhost:3001"
export TENANT_ID="tenant-alpha"
export TOKEN="your-jwt-token-here"
export INVOICE_ID="inv-001"
```

Every example includes the `x-tenant-id` header. If your JWT already carries a
`tenantId` claim you may omit the header, but including it explicitly is the
recommended practice.

---

## 1. GET /api/invoices/:id/state

Returns the current lifecycle state and the transitions available from that
state.

### 1.1 Pending invoice (non-terminal)

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/$INVOICE_ID/state" \
  -H "x-tenant-id: $TENANT_ID"
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "pending",
    "allowedTransitions": ["approved", "rejected", "cancelled"],
    "isTerminal": false
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice state retrieved successfully"
}
```

### 1.2 Terminal invoice (linked_escrow)

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/inv-003/state" \
  -H "x-tenant-id: $TENANT_ID"
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-003",
    "currentState": "linked_escrow",
    "allowedTransitions": [],
    "isTerminal": true
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice state retrieved successfully"
}
```

### 1.3 Invoice not found

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/nonexistent-id/state" \
  -H "x-tenant-id: $TENANT_ID"
```

**Response — 404 Not Found**

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Invoice not found",
    "code": "INVOICE_NOT_FOUND",
    "details": null
  }
}
```

---

## 2. POST /api/invoices/:id/transition

Generic state transition. Accepts any valid `targetState` in the request body.

### 2.1 Approve a pending invoice

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/transition" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "targetState": "approved",
    "reason": "Invoice verified by finance team"
  }'
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "approved",
    "transitionedAt": "2026-07-24T10:30:00.000Z",
    "transitionedBy": "user-123",
    "reason": "Invoice verified by finance team",
    "auditLogId": "AUDIT-1714132200000-abc123def"
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice transitioned from pending to approved"
}
```

### 2.2 Reject a pending invoice (reason required)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/transition" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "targetState": "rejected",
    "reason": "Missing supporting documentation"
  }'
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "rejected",
    "transitionedAt": "2026-07-24T10:30:01.000Z",
    "transitionedBy": "user-123",
    "reason": "Missing supporting documentation",
    "auditLogId": "AUDIT-1714132201000-xyz789"
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:01.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice transitioned from pending to rejected"
}
```

### 2.3 Missing targetState (400)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/transition" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "reason": "Forgot the target state" }'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Target state is required",
    "code": "MISSING_TARGET_STATE",
    "details": null
  }
}
```

### 2.4 Invalid transition — silent jump (400)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/transition" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "targetState": "linked_escrow",
    "reason": "Trying to skip approval"
  }'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Invalid state transition from 'pending' to 'linked_escrow'",
    "code": "INVALID_TRANSITION",
    "details": {
      "allowedTransitions": ["approved", "rejected", "cancelled"]
    }
  }
}
```

### 2.5 Missing reason for terminal target (400)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/transition" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "targetState": "rejected" }'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Reason is required when transitioning to a terminal state",
    "code": "MISSING_TRANSITION_REASON",
    "details": null
  }
}
```

---

## 3. POST /api/invoices/:id/approve

Convenience shortcut that hardcodes `targetState = "approved"`.

### 3.1 Approve with reason

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/approve" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "reason": "All documentation checks passed" }'
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "approved",
    "transitionedAt": "2026-07-24T10:30:00.000Z",
    "transitionedBy": "user-123",
    "auditLogId": "AUDIT-8a4c10d2"
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice approved successfully"
}
```

### 3.2 Approve without body (also valid)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/approve" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{}'
```

The approve endpoint defaults the reason to `"Invoice approved"` when no
body or no reason field is provided.

### 3.3 Already in approved state (400)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/inv-002/approve" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "reason": "Already approved" }'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Invoice is already in state: approved",
    "code": "ALREADY_IN_TARGET_STATE",
    "details": null
  }
}
```

---

## 4. POST /api/invoices/:id/link-escrow

Links an `approved` invoice to an escrow contract. This endpoint is
**KYC-gated** — the authenticated principal must hold a `smeId` claim and the
SME must have a `verified` or `exempted` KYC status.

### 4.1 Link with escrow ID

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/inv-002/link-escrow" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "escrowId": "CESCROW123AAABBBCCCDDDEEEFFFGGGHHH",
    "reason": "Soroban escrow contract deployed and funded"
  }'
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-002",
    "previousState": "approved",
    "currentState": "linked_escrow",
    "escrowId": "CESCROW123AAABBBCCCDDDEEEFFFGGGHHH",
    "transitionedAt": "2026-07-24T11:00:00.000Z",
    "transitionedBy": "user-456",
    "auditLogId": "AUDIT-9b5d21e3"
  },
  "meta": {
    "timestamp": "2026-07-24T11:00:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice linked to escrow successfully"
}
```

### 4.2 Link without escrowId (escrowId is null)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/inv-002/link-escrow" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "reason": "Pending escrow contract ID" }'
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-002",
    "previousState": "approved",
    "currentState": "linked_escrow",
    "escrowId": null,
    "transitionedAt": "2026-07-24T11:00:00.000Z",
    "transitionedBy": "user-456",
    "auditLogId": "AUDIT-9b5d21e4"
  },
  "meta": {
    "timestamp": "2026-07-24T11:00:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice linked to escrow successfully"
}
```

### 4.3 Invoice not in approved state (400)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/link-escrow" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "escrowId": "escrow-456" }'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Invoice must be in approved state to link to escrow",
    "code": "CANNOT_LINK_TO_ESCROW",
    "details": null
  }
}
```

### 4.4 KYC gate failure (403)

Returned when the authenticated SME does not hold a `verified` or `exempted`
KYC status.

**Response — 403 Forbidden**

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "SME KYC status 'pending' does not permit funding operations.",
    "code": "KYC_GATE_FAILED",
    "details": null
  }
}
```

### 4.5 Missing smeId claim (400)

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Authenticated principal is missing smeId.",
    "code": "MISSING_SME_ID",
    "details": null
  }
}
```

---

## 5. POST /api/invoices/:id/reject

Convenience shortcut for `pending → rejected`. A **non-empty `reason`**
is mandatory.

### 5.1 Reject with reason

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/reject" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "reason": "Invalid supporting documentation — VAT registration number missing"
  }'
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "rejected",
    "transitionedAt": "2026-07-24T10:30:01.000Z",
    "transitionedBy": "user-789",
    "reason": "Invalid supporting documentation — VAT registration number missing",
    "auditLogId": "AUDIT-c2e7f4a9"
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:01.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice rejected successfully"
}
```

### 5.2 Missing reason (400)

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/reject" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{}'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Reason is required for rejection",
    "code": "MISSING_TRANSITION_REASON",
    "details": null
  }
}
```

### 5.3 Cannot reject an approved invoice (400)

`approved → rejected` is not a valid transition. Use `cancelled` instead.

**Request**

```bash
curl -s -X POST "$BASE_URL/api/invoices/inv-002/reject" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{ "reason": "Cannot reject approved invoice" }'
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Invalid state transition from 'approved' to 'rejected'",
    "code": "INVALID_TRANSITION",
    "details": {
      "allowedTransitions": ["linked_escrow", "cancelled"]
    }
  }
}
```

---

## 6. GET /api/invoices/:id/history

Returns the ordered audit trail of all state transitions, most recent first.

### 6.1 Invoice with transitions

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/$INVOICE_ID/history" \
  -H "x-tenant-id: $TENANT_ID"
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "linked_escrow",
    "transitions": [
      {
        "id": "AUDIT-1714134000000-def456",
        "timestamp": "2026-07-24T11:00:00.000Z",
        "actor": "user-456",
        "fromState": "approved",
        "toState": "linked_escrow",
        "reason": "Escrow contract created",
        "ipAddress": "192.168.1.100"
      },
      {
        "id": "AUDIT-1714132200000-abc123",
        "timestamp": "2026-07-24T10:30:00.000Z",
        "actor": "user-123",
        "fromState": "pending",
        "toState": "approved",
        "reason": "Documentation verified",
        "ipAddress": "192.168.1.1"
      }
    ],
    "totalTransitions": 2
  },
  "meta": {
    "timestamp": "2026-07-24T11:01:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice transition history retrieved successfully"
}
```

### 6.2 Invoice with no transitions

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/inv-002/history" \
  -H "x-tenant-id: $TENANT_ID"
```

**Response — 200 OK**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": {
    "invoiceId": "inv-002",
    "currentState": "approved",
    "transitions": [],
    "totalTransitions": 0
  },
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": null,
  "message": "Invoice transition history retrieved successfully"
}
```

### 6.3 Invoice not found

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/nonexistent-id/history" \
  -H "x-tenant-id: $TENANT_ID"
```

**Response — 404 Not Found**

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Invoice not found",
    "code": "INVOICE_NOT_FOUND",
    "details": null
  }
}
```

---

## Common Errors

### Missing tenant context (400)

Returned by the `extractTenant` middleware when neither the `x-tenant-id`
header nor a JWT `tenantId` claim is present.

**Request**

```bash
curl -s -X GET "$BASE_URL/api/invoices/$INVOICE_ID/state"
```

**Response — 400 Bad Request**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Missing tenant context.",
  "message": "A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim."
}
```

### Rate limiting (429)

All invoice-state endpoints are rate-limited to 60 requests per 15-minute
window per client (API key / IP). Exceeding the limit returns:

**Response — 429 Too Many Requests**

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{
  "error": "Too many requests",
  "message": "Rate limit exceeded. Please try again later."
}
```

### Terminal state (400)

Attempting any transition on an invoice in a terminal state (`linked_escrow`,
`rejected`, or `cancelled`) returns:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "data": null,
  "meta": {
    "timestamp": "2026-07-24T10:30:00.000Z",
    "version": "0.1.0"
  },
  "error": {
    "message": "Cannot transition from terminal state: linked_escrow",
    "code": "TERMINAL_STATE",
    "details": null
  }
}
```

---

*All examples verified against `src/routes/invoiceStateRoutes.js` and
`src/services/invoiceStateMachine.js`.*
