# Invoice-State Operations Runbook

Operator runbook for the LiquiFact backend invoice-state subsystem. This document covers configuration, common failure modes, alerts/signals, and recovery procedures for the invoice-state API and the state-transition logic in `src/services/invoiceStateMachine.js`.

---

## Architecture Overview

The invoice-state subsystem is a tenant-scoped state machine for invoice lifecycle transitions.

```text
/api/invoices/:id/*
  |
  +-> authenticateToken
  +-> extractTenant
  +-> invoiceStateLimiter
      |
      +-> GET /:id/state
      +-> POST /:id/transition
      +-> POST /:id/approve
      +-> POST /:id/reject
      +-> POST /:id/link-escrow
      +-> GET /:id/history
```

Key behavior:

- All invoice-state routes are mounted under `src/routes/invoiceStateRoutes.js` and require authenticated tenant context.
- Tenant context is extracted by `src/middleware/tenant.js` from `x-tenant-id` or the authenticated JWT claim.
- Invoice lookup and transition persistence are scoped to the tenant by `src/services/invoiceService.js`.
- Transition rules are enforced by `src/services/invoiceStateMachine.js`; the client cannot directly set a status.
- The `link-escrow` path is gated by KYC checks in `src/middleware/kycGating.js`.

---

## Invoice-State Endpoints

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/invoices/:id/state` | Returns current state + allowed transitions | Uses `resolveInvoiceForTenant` to enforce tenant isolation. |
| `POST /api/invoices/:id/transition` | Executes a generic state transition | Validated by the invoice state machine. |
| `POST /api/invoices/:id/approve` | Convenience approve action | Transitions `pending` -> `approved`. |
| `POST /api/invoices/:id/reject` | Convenience reject action | Requires a non-empty reason. |
| `POST /api/invoices/:id/link-escrow` | Links an approved invoice to escrow | Requires KYC gate and approved current state. |
| `GET /api/invoices/:id/history` | Returns state transition history | Uses `getTransitionHistory` and audit logs. |

---

## Valid State Transitions

The state machine in `src/services/invoiceStateMachine.js` defines the allowed lifecycle flow.

- `pending` -> `approved`
- `pending` -> `rejected`
- `pending` -> `cancelled`
- `approved` -> `linked_escrow`
- `approved` -> `cancelled`

Terminal states:

- `linked_escrow`
- `rejected`
- `cancelled`

Terminal states cannot transition again.

The transitions to `rejected` and `cancelled` require a non-empty reason and enforce a maximum reason length.

---

## Configuration

Invoice-state behavior is driven mostly by authentication, tenant scoping, and rate limiting.

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_INVOICE_STATE_WINDOW_MS` | `900000` (15 minutes) | Rate-limit bucket window for invoice-state requests. |
| `RATE_LIMIT_INVOICE_STATE_MAX` | `60` | Maximum invoice-state requests per window per client key. |
| `JWT_SECRET` | test/dev fallback only | Required for auth outside test/dev environments. |

Note: there are no dedicated invoice-state feature flags in code beyond those rate-limit env vars. The request validator and state machine enforce transition rules entirely in code.

---

## Common Failure Modes

### 1. Unauthorized / missing token

**Symptom:** `401 Unauthorized`

**Cause:** `authenticateToken` rejects the request before tenant resolution.

**Check:** verify the bearer token and the configured `JWT_SECRET` / token issuer settings.

**Recovery:** fix the client token or auth configuration.

### 2. Missing tenant context

**Symptom:** `400` with a missing tenant message.

**Cause:** `x-tenant-id` is not supplied and the authenticated JWT has no `tenantId` claim.

**Check:** confirm the request includes either `x-tenant-id` or a valid token-scoped tenant ID.

**Recovery:** supply the tenant ID in the header or ensure the token contains `tenantId`.

### 3. Cross-tenant invoice access

**Symptom:** `404 INVOICE_NOT_FOUND`

**Cause:** `resolveInvoiceForTenant` returns `null` when the invoice does not exist or belongs to another tenant.

**Check:** verify the invoice ID and tenant are correct, and that the invoice exists under the requested tenant.

**Recovery:** correct the tenant-id or use the invoice ID within the same tenant.

### 4. Invalid transition input

**Symptom:** `400` with one of the state-machine validation errors.

**Common codes:**

- `MISSING_TARGET_STATE`
- `INVALID_TARGET_STATE`
- `ALREADY_IN_TARGET_STATE`
- `TERMINAL_STATE`
- `MISSING_TRANSITION_REASON`
- `TRANSITION_REASON_TOO_LONG`
- `INVALID_REASON_TYPE`

**Cause:** bad request body or unsupported transition.

**Check:** inspect the request payload and compare to the current state and allowed transitions.

**Recovery:** adjust the transition target or supply the required reason/actor fields.

### 5. KYC gate rejection on link escrow

**Symptom:** `400 CANNOT_LINK_TO_ESCROW` or a 403 / KYC-specific rejection from `requireKycForFunding`.

**Cause:** invoice is not approved, not eligible for escrow linkage, or the caller fails the KYC gate.

**Check:** confirm the invoice is in `approved` state and that the SME has verified/exempted KYC status.

**Recovery:** ensure the invoice is approved, then satisfy the KYC requirements before retrying.

### 6. Rate limiting

**Symptom:** `429 Too Many Requests` with a `Retry-After` header.

**Cause:** the client exceeded `RATE_LIMIT_INVOICE_STATE_MAX` within the configured window.

**Check:** verify request patterns and client key usage.

**Recovery:** back off until the retry window resets, or increase the rate-limit config only if the traffic pattern is legitimate.

### 7. Internal persistence / DB errors

**Symptom:** `500` or other server error while executing a transition.

**Cause:** underlying DB write/read failure, schema mismatch, or tenant-scoped query failure.

**Check:** inspect application logs and DB connectivity. Confirm the `invoices` table and audit log persistence are healthy.

**Recovery:** restore DB connectivity, correct schema/migrations, and retry the transition.

---

## Alerts and Signals

Watch for these signals when operating invoice-state.

| Signal | Meaning |
|---|---|
| `INVOICE_NOT_FOUND` | The requested invoice is missing or belongs to a different tenant. |
| `MISSING_TRANSITION_REASON` | A terminal transition was attempted without a required reason. |
| `CANNOT_LINK_TO_ESCROW` | A non-approved invoice or a KYC gate failure blocked escrow linkage. |
| `429` on invoice-state endpoints | Rate limiting is in effect for the request key. |
| `500` on transition routes | Underlying persistence or state-machine errors need investigation. |

Relevant code locations:

- `src/routes/invoiceStateRoutes.js` — route behavior, middleware ordering, response shaping.
- `src/services/invoiceService.js` — tenant-scoped invoice lookup and persistence.
- `src/services/invoiceStateMachine.js` — canonical transition rules and validation.
- `src/middleware/tenant.js` — tenant extraction and header/JWT resolution.
- `src/middleware/rateLimit.js` — invoice-state rate limiter config and behavior.
- `src/middleware/kycGating.js` — KYC gating for `link-escrow`.

---

## Recovery Steps

### Recover an invoice-state transition failure

1. Confirm the request was authenticated and `req.tenantId` was resolved.
2. Confirm the invoice exists for the tenant, or verify that the invoice is not cross-tenant.
3. Review the current state and allowed transitions returned by `GET /api/invoices/:id/state`.
4. If the transition failed with a validation code, fix the payload and retry.
5. If the failure is a DB error, restore the database and retry the request.

### Recover from `link-escrow` KYC failures

1. Confirm the invoice is in `approved` state.
2. Confirm the caller’s tenant/SME identity has KYC approved/exempted status.
3. Confirm the `requireKycForFunding` middleware is not rejecting for missing or invalid KYC metadata.
4. Retry the operation once the KYC condition is satisfied.

### Recover from invoice-state rate limiting

1. Confirm the client key and request volume.
2. If traffic is legitimate, increase `RATE_LIMIT_INVOICE_STATE_MAX` or `RATE_LIMIT_INVOICE_STATE_WINDOW_MS` carefully.
3. If traffic is abusive, keep the limit and ask clients to retry after the `Retry-After` window.

---

## Cross-References

- `src/routes/invoiceStateRoutes.js`
- `src/services/invoiceStateMachine.js`
- `src/services/invoiceService.js`
- `src/middleware/tenant.js`
- `src/middleware/rateLimit.js`
- `src/middleware/kycGating.js`
- `docs/configuration.md`
