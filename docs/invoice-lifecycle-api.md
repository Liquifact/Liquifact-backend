# Invoice Lifecycle State Machine API

For the end-to-end invoice state, KYC gate, and escrow funding sequence, see
[`invoice-funding-lifecycle.md`](./invoice-funding-lifecycle.md).

## Overview

The Invoice Lifecycle API implements a secure state machine for managing invoice transitions through the LiquiFact platform. The state machine enforces strict transition rules and maintains a complete audit trail of all state changes.

## State Machine

### States

- **pending**: Initial state when invoice is created
- **approved**: Invoice has been verified and approved
- **linked_escrow**: Invoice is linked to an escrow contract (terminal state)
- **rejected**: Invoice was rejected during verification (terminal state)
- **cancelled**: Invoice was cancelled by user (terminal state)

### Valid Transitions

```
pending → approved
pending → rejected
pending → cancelled

approved → linked_escrow
approved → cancelled

linked_escrow → (none - terminal)
rejected → (none - terminal)
cancelled → (none - terminal)
```

### Transition Rules

1. **No Silent Jumps**: Cannot skip states (e.g., pending → linked_escrow is forbidden)
2. **Terminal States**: Once in a terminal state, no further transitions are allowed
3. **Terminal Transition Reason**: Transitions to `rejected` or `cancelled` require a non-empty, sanitized reason that is recorded in the audit trail.
4. **Audit Trail**: Every transition is logged with actor, timestamp, and reason
5. **Authorization**: All transitions require authenticated user

## API Endpoints

### 1. Get Invoice State

Get the current state and allowed transitions for an invoice.

**Endpoint**: `GET /api/invoices/:id/state`

**Response**:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "pending",
    "allowedTransitions": ["approved", "rejected", "cancelled"],
    "isTerminal": false
  },
  "message": "Invoice state retrieved successfully"
}
```

**cURL Example**:
```bash
curl -X GET http://localhost:3001/api/invoices/inv-001/state \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 2. Execute State Transition

Execute a state transition with audit logging.

**Endpoint**: `POST /api/invoices/:id/transition`

**Request Body**:
```json
{
  "targetState": "approved",
  "reason": "Invoice verified and approved by finance team"
}
```

**Response**:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "approved",
    "transitionedAt": "2026-04-26T10:30:00.000Z",
    "transitionedBy": "user-123",
    "reason": "Invoice verified and approved by finance team",
    "auditLogId": "AUDIT-1714132200000-abc123def"
  },
  "message": "Invoice transitioned from pending to approved"
}
```

**cURL Example**:
```bash
curl -X POST http://localhost:3001/api/invoices/inv-001/transition \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targetState": "approved",
    "reason": "Invoice verified and approved by finance team"
  }'
```

**Error Response** (Invalid Transition):
```json
{
  "error": "Invalid state transition from pending to linked_escrow. Allowed transitions: approved, rejected, cancelled",
  "code": "INVALID_TRANSITION",
  "allowedTransitions": ["approved", "rejected", "cancelled"]
}
```

**Error Response** (Missing terminal transition reason):
```json
{
  "error": "Reason is required for terminal transition to rejected",
  "code": "MISSING_TRANSITION_REASON"
}
```

---

### 3. Approve Invoice

Convenience endpoint to approve a pending invoice.

**Endpoint**: `POST /api/invoices/:id/approve`

**Request Body**:
```json
{
  "reason": "All verification checks passed"
}
```

**Response**:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "approved",
    "transitionedAt": "2026-04-26T10:30:00.000Z",
    "transitionedBy": "user-123",
    "auditLogId": "AUDIT-1714132200000-xyz789"
  },
  "message": "Invoice approved successfully"
}
```

**cURL Example**:
```bash
curl -X POST http://localhost:3001/api/invoices/inv-001/approve \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "All verification checks passed"
  }'
```

---

### 4. Link Invoice to Escrow

Link an approved invoice to an escrow contract.

**Endpoint**: `POST /api/invoices/:id/link-escrow`

**Request Body**:
```json
{
  "escrowId": "escrow-123",
  "reason": "Escrow contract created on Stellar"
}
```

**Response**:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "approved",
    "currentState": "linked_escrow",
    "escrowId": "escrow-123",
    "transitionedAt": "2026-04-26T11:00:00.000Z",
    "transitionedBy": "user-123",
    "auditLogId": "AUDIT-1714134000000-def456"
  },
  "message": "Invoice linked to escrow successfully"
}
```

**cURL Example**:
```bash
curl -X POST http://localhost:3001/api/invoices/inv-001/link-escrow \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "escrowId": "escrow-123",
    "reason": "Escrow contract created on Stellar"
  }'
```

**Business Rules**:
- Invoice must be in `approved` state
- Cannot link pending or rejected invoices

---

### 5. Reject Invoice

Reject a pending invoice with a reason.

**Endpoint**: `POST /api/invoices/:id/reject`

**Request Body**:
```json
{
  "reason": "Invalid documentation provided"
}
```

**Response**:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "previousState": "pending",
    "currentState": "rejected",
    "reason": "Invalid documentation provided",
    "transitionedAt": "2026-04-26T10:45:00.000Z",
    "transitionedBy": "user-123",
    "auditLogId": "AUDIT-1714133100000-ghi789"
  },
  "message": "Invoice rejected successfully"
}
```

**cURL Example**:
```bash
curl -X POST http://localhost:3001/api/invoices/inv-001/reject \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Invalid documentation provided"
  }'
```

**Validation**:
- `reason` field is required for rejection

---

### 6. Get Transition History

Retrieve the complete state transition history for an invoice.

**Endpoint**: `GET /api/invoices/:id/history`

**Response**:
```json
{
  "data": {
    "invoiceId": "inv-001",
    "currentState": "linked_escrow",
    "transitions": [
      {
        "id": "AUDIT-1714134000000-def456",
        "timestamp": "2026-04-26T11:00:00.000Z",
        "actor": "user-123",
        "fromState": "approved",
        "toState": "linked_escrow",
        "reason": "Escrow contract created on Stellar",
        "ipAddress": "192.168.1.100"
      },
      {
        "id": "AUDIT-1714132200000-xyz789",
        "timestamp": "2026-04-26T10:30:00.000Z",
        "actor": "user-123",
        "fromState": "pending",
        "toState": "approved",
        "reason": "All verification checks passed",
        "ipAddress": "192.168.1.100"
      }
    ],
    "totalTransitions": 2
  },
  "message": "Invoice transition history retrieved successfully"
}
```

**cURL Example**:
```bash
curl -X GET http://localhost:3001/api/invoices/inv-001/history \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Error Codes

| Code | Description | HTTP Status |
|------|-------------|-------------|
| `INVOICE_NOT_FOUND` | Invoice does not exist | 404 |
| `MISSING_TARGET_STATE` | Target state not provided | 400 |
| `INVALID_TRANSITION` | Transition not allowed by state machine | 400 |
| `ALREADY_IN_TARGET_STATE` | Invoice is already in the target state | 400 |
| `TERMINAL_STATE` | Cannot transition from terminal state | 400 |
| `CANNOT_LINK_TO_ESCROW` | Business rules prevent escrow linking | 400 |
| `MISSING_TRANSITION_REASON` | Reason required for terminal transition | 400 |

---

## Audit Trail

Every state transition creates an immutable audit log entry with:

- **Actor**: User ID or IP address of who performed the transition
- **Timestamp**: ISO 8601 timestamp of when transition occurred
- **Before/After States**: Previous and new states
- **Reason**: Human-readable explanation for the transition
- **IP Address**: Source IP of the request
- **User Agent**: Client user agent string
- **Metadata**: Additional context (method, path, escrow ID, etc.)

### Audit Log Schema

```json
{
  "id": "AUDIT-1714132200000-abc123",
  "timestamp": "2026-04-26T10:30:00.000Z",
  "actor": "user-123",
  "action": "STATE_TRANSITION",
  "resourceType": "invoice",
  "resourceId": "inv-001",
  "changes": {
    "before": { "state": "pending" },
    "after": { "state": "approved" }
  },
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

---

## Security Considerations

### Authentication
- All endpoints require valid JWT authentication
- Actor is extracted from JWT token (`req.user.id` or `req.user.sub`)
- Fallback to IP address only for development/testing

### Authorization
- Users can only transition invoices they have permission to modify
- Role-based access control should be implemented in production

### Input Validation
- All state transitions are validated against the state machine rules
- Reason fields are sanitized to prevent XSS
- State names are validated against allowed values

### Audit Security
- Audit logs are immutable once created
- Sensitive fields (passwords, tokens) are automatically redacted
- Audit logs include IP address and user agent for forensics

---

## Complete Workflow Example

### Scenario: Invoice Approval and Escrow Linking

```bash
# 1. Check initial state
curl -X GET http://localhost:3001/api/invoices/inv-001/state \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response: { "currentState": "pending", "allowedTransitions": ["approved", "rejected", "cancelled"] }

# 2. Approve the invoice
curl -X POST http://localhost:3001/api/invoices/inv-001/approve \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Invoice verified by finance team"
  }'

# Response: { "currentState": "approved", "previousState": "pending" }

# 3. Link to escrow
curl -X POST http://localhost:3001/api/invoices/inv-001/link-escrow \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "escrowId": "escrow-abc-123",
    "reason": "Escrow contract deployed to Stellar"
  }'

# Response: { "currentState": "linked_escrow", "escrowId": "escrow-abc-123" }

# 4. View complete history
curl -X GET http://localhost:3001/api/invoices/inv-001/history \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response: Shows all 2 transitions with timestamps and actors
```

---

## Testing

### Unit Tests
Run unit tests for state machine logic:
```bash
npm test tests/invoice.state.test.js
```

### Coverage Requirements
- Minimum 95% line coverage on new code
- All state transitions tested
- All error conditions tested
- Audit logging verified

### Test Coverage
```bash
npm run test:coverage -- tests/invoice.state.test.js
```

---

## Database Schema

### Audit Logs Table

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    actor VARCHAR(255) NOT NULL,
    action VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(255) NOT NULL,
    before_state JSONB,
    after_state JSONB,
    status_code INTEGER NOT NULL DEFAULT 200,
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
```

---

## Integration with Stellar

When linking an invoice to escrow, the system should:

1. Validate invoice is in `approved` state
2. Create escrow contract on Stellar network
3. Transition invoice to `linked_escrow` state
4. Store escrow contract ID in invoice record
5. Create audit log with escrow details

The state machine ensures invoices cannot be linked to escrow without proper approval, preventing unauthorized or premature escrow creation.

---

## Future Enhancements

- **Partial Approvals**: Multi-step approval workflow
- **Conditional Transitions**: Business rule engine for complex validations
- **Rollback Support**: Ability to revert certain transitions with proper authorization
- **Notification System**: Trigger notifications on state changes
- **Webhook Integration**: Call external systems on state transitions
