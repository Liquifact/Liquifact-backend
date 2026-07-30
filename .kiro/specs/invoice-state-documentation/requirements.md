# Requirements Document

## Introduction

This feature produces a single authoritative reference document (`docs/invoice-state.md`) for all `invoice-state` endpoints in the Liquifact-backend repository. The document must accurately reflect the underlying route handler code, state machine logic, and error definitions so that consumers, reviewers, and maintainers have a complete, verified API contract without needing to read source code.

The `invoice-state` routes are mounted at `/api/invoices` and own the sub-paths `/:id/state`, `/:id/transition`, `/:id/approve`, `/:id/link-escrow`, `/:id/reject`, and `/:id/history`. All routes require a tenant context via the `x-tenant-id` header. Several routes additionally enforce KYC gating for capital-moving state transitions.

## Glossary

- **Invoice_State_Router**: The Express router defined in `src/routes/invoiceStateRoutes.js` and mounted at `/api/invoices` in `src/app.js`.
- **InvoiceStateMachine**: The module `src/services/invoiceStateMachine.js` that exports `INVOICE_STATES`, `VALID_TRANSITIONS`, `TERMINAL_STATES`, `CAPITAL_MOVING_STATES`, and the transition helper functions.
- **InvoiceService**: The module `src/services/invoiceService.js` that provides tenant-scoped persistence operations including `resolveInvoiceForTenant` and `transitionInvoice`.
- **Tenant**: An isolated organizational account identified by a `tenantId` string resolved from the `x-tenant-id` header or a JWT claim via `extractTenant` middleware.
- **Terminal_State**: A lifecycle state from which no further transitions are permitted. Terminal states are `linked_escrow`, `rejected`, `cancelled`, `completed`, `defaulted`, and `settled`.
- **Capital_Moving_State**: A lifecycle state that involves fund movement (`funded`, `settled`). Transitions to these states require KYC verification.
- **Transition_Reason**: A mandatory human-readable string (1–1 024 characters) required when the target state is `rejected` or `cancelled`. Control characters are stripped automatically.
- **Actor**: The authenticated user performing the transition, identified by `req.user.id` or `req.user.sub`.
- **Audit_Log**: An append-only record created by the InvoiceStateMachine on every successful state transition containing before/after state, actor, reason, IP address, and user-agent.
- **RFC_7807_Problem**: The standard error envelope returned for all 4xx and 5xx responses: `{ type, title, status, detail, instance?, code?, retryable?, retryHint? }`.

---

## Requirements

### Requirement 1: Document the GET /:id/state Endpoint

**User Story:** As an API consumer, I want a complete reference for `GET /api/invoices/:id/state`, so that I can programmatically read an invoice's current lifecycle state and determine which transitions are available.

#### Acceptance Criteria

1. THE Documentation SHALL include the HTTP method (`GET`) and full URI path (`/api/invoices/:id/state`).
2. THE Documentation SHALL list all required path parameters, specifying that `id` is the public `invoice_id` string.
3. THE Documentation SHALL specify the required `x-tenant-id` header and explain that it resolves the tenant context via `extractTenant` middleware.
4. THE Documentation SHALL describe the `200 OK` success response body schema including fields `invoiceId` (string), `currentState` (string), `allowedTransitions` (string[]), and `isTerminal` (boolean).
5. WHEN the invoice does not exist or belongs to a different tenant, THE Documentation SHALL specify that the Invoice_State_Router returns `404` with error code `INVOICE_NOT_FOUND`.
6. WHEN the `x-tenant-id` header is absent or invalid, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with the missing tenant context error.
7. THE Documentation SHALL include at least one concrete request example (curl) and one `200 OK` response example showing a non-terminal invoice.
8. THE Documentation SHALL include at least one `404` error response example.

---

### Requirement 2: Document the POST /:id/transition Endpoint

**User Story:** As an API consumer, I want a complete reference for `POST /api/invoices/:id/transition`, so that I can trigger any allowed state change using the generic transition endpoint.

#### Acceptance Criteria

1. THE Documentation SHALL include the HTTP method (`POST`) and full URI path (`/api/invoices/:id/transition`).
2. THE Documentation SHALL specify the required `x-tenant-id` header.
3. THE Documentation SHALL describe the request body schema with fields `targetState` (string, required) and `reason` (string, optional/required depending on target).
4. THE Documentation SHALL specify that `reason` is required when `targetState` is `rejected` or `cancelled`, with a maximum length of 1 024 characters.
5. THE Documentation SHALL describe the `200 OK` response body schema including `previousState` (string), `currentState` (string), `transitionedBy` (string), `reason` (string), and `auditLogId` (string).
6. WHEN the transition is not in `VALID_TRANSITIONS`, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `INVALID_TRANSITION` and an `allowedTransitions` array in the error details.
7. WHEN the invoice is in a Terminal_State, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `TERMINAL_STATE`.
8. WHEN `targetState` is omitted from the request body, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `MISSING_TARGET_STATE`.
9. WHEN `reason` is required but absent (or whitespace-only), THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `MISSING_TRANSITION_REASON`.
10. THE Documentation SHALL include at least one concrete request/response example for a successful transition.
11. THE Documentation SHALL include at least one error example showing an invalid transition rejection.

---

### Requirement 3: Document the POST /:id/approve Endpoint

**User Story:** As an API consumer, I want a dedicated reference for `POST /api/invoices/:id/approve`, so that I can approve a pending invoice without constructing a generic transition payload.

#### Acceptance Criteria

1. THE Documentation SHALL include the HTTP method (`POST`) and full URI path (`/api/invoices/:id/approve`).
2. THE Documentation SHALL specify the required `x-tenant-id` header.
3. THE Documentation SHALL describe the optional request body field `reason` (string).
4. THE Documentation SHALL specify the `200 OK` response body including `previousState`, `currentState` (always `approved`), and a `message` of `"Invoice approved successfully"`.
5. WHEN the invoice is already in state `approved`, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `ALREADY_IN_TARGET_STATE`.
6. THE Documentation SHALL include at least one concrete request example and one `200 OK` response example.

---

### Requirement 4: Document the POST /:id/link-escrow Endpoint

**User Story:** As an API consumer, I want a complete reference for `POST /api/invoices/:id/link-escrow`, so that I can associate an approved invoice with an on-chain escrow contract.

#### Acceptance Criteria

1. THE Documentation SHALL include the HTTP method (`POST`) and full URI path (`/api/invoices/:id/link-escrow`).
2. THE Documentation SHALL specify that the `requireKycForFunding` middleware is applied to this route, blocking requests where the SME KYC status does not permit funding operations.
3. THE Documentation SHALL describe the request body schema with fields `escrowId` (string, optional) and `reason` (string, optional).
4. THE Documentation SHALL specify the `200 OK` response body including `previousState`, `currentState` (always `linked_escrow`), `escrowId` (string or null), and a `message` of `"Invoice linked to escrow successfully"`.
5. WHEN the invoice is not in `approved` state, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `CANNOT_LINK_TO_ESCROW`.
6. WHEN the SME KYC status does not permit the operation, THE Documentation SHALL specify that the KYC gating middleware returns `403` with error code `KYC_GATE_FAILED`.
7. THE Documentation SHALL include at least one concrete request example with an `escrowId` and one `200 OK` response example.
8. THE Documentation SHALL include at least one `400 CANNOT_LINK_TO_ESCROW` error example.

---

### Requirement 5: Document the POST /:id/reject Endpoint

**User Story:** As an API consumer, I want a dedicated reference for `POST /api/invoices/:id/reject`, so that I can reject a pending invoice with a mandatory reason.

#### Acceptance Criteria

1. THE Documentation SHALL include the HTTP method (`POST`) and full URI path (`/api/invoices/:id/reject`).
2. THE Documentation SHALL specify the required `x-tenant-id` header.
3. THE Documentation SHALL describe the required request body field `reason` (string, 1–1 024 characters).
4. THE Documentation SHALL specify the `200 OK` response body including `previousState`, `currentState` (always `rejected`), `reason` (string), and the transition timestamp.
5. WHEN `reason` is absent or whitespace-only, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `MISSING_TRANSITION_REASON`.
6. WHEN the invoice is in `approved` state, THE Documentation SHALL specify that the Invoice_State_Router returns `400` with error code `INVALID_TRANSITION` (only `pending → rejected` is allowed).
7. THE Documentation SHALL include at least one concrete request example and one `200 OK` response example.

---

### Requirement 6: Document the GET /:id/history Endpoint

**User Story:** As an API consumer, I want a complete reference for `GET /api/invoices/:id/history`, so that I can retrieve the full ordered audit trail of state transitions for an invoice.

#### Acceptance Criteria

1. THE Documentation SHALL include the HTTP method (`GET`) and full URI path (`/api/invoices/:id/history`).
2. THE Documentation SHALL specify the required `x-tenant-id` header.
3. THE Documentation SHALL describe the `200 OK` response body schema including `invoiceId` (string), `currentState` (string), `transitions` (array), and `totalTransitions` (number).
4. THE Documentation SHALL specify the schema of each object in the `transitions` array: `fromState`, `toState`, `transitionedBy`, `reason`, and `timestamp`.
5. WHEN the invoice has no transitions, THE Documentation SHALL specify that the Invoice_State_Router returns `200` with an empty `transitions` array and `totalTransitions: 0`.
6. WHEN the invoice does not exist or belongs to another tenant, THE Documentation SHALL specify that the Invoice_State_Router returns `404` with error code `INVOICE_NOT_FOUND`.
7. THE Documentation SHALL include at least one concrete request example and one `200 OK` response example showing a multi-step history.

---

### Requirement 7: Document the State Machine and Valid Transitions

**User Story:** As a developer integrating with the API, I want a reference for all valid invoice lifecycle states and the allowed transitions between them, so that I can build client logic that does not attempt illegal transitions.

#### Acceptance Criteria

1. THE Documentation SHALL enumerate all five lifecycle states: `pending`, `approved`, `linked_escrow`, `rejected`, `cancelled`.
2. THE Documentation SHALL present the complete `VALID_TRANSITIONS` matrix showing which source states permit which target states.
3. THE Documentation SHALL identify all Terminal_States and state that no further transitions are possible from them.
4. THE Documentation SHALL identify the Capital_Moving_States (`funded`, `settled`) and state that these states require KYC verification.
5. THE Documentation SHALL list all states that require a Transition_Reason when targeted: `rejected` and `cancelled`.

---

### Requirement 8: Document the Full Error Code Reference

**User Story:** As an API consumer, I want a consolidated error code table for all invoice-state endpoints, so that I can implement deterministic error handling without guessing at error shapes.

#### Acceptance Criteria

1. THE Documentation SHALL describe the RFC_7807_Problem error envelope format used by all invoice-state endpoints.
2. THE Documentation SHALL list every application-level error code surfaced by invoice-state endpoints: `INVOICE_NOT_FOUND`, `INVALID_TRANSITION`, `TERMINAL_STATE`, `MISSING_TARGET_STATE`, `MISSING_TRANSITION_REASON`, `ALREADY_IN_TARGET_STATE`, `CANNOT_LINK_TO_ESCROW`, `MISSING_ACTOR`, `INVALID_CURRENT_STATE`, `INVALID_TARGET_STATE`, `TRANSITION_REASON_TOO_LONG`, `KYC_GATE_FAILED`, `MISSING_SME_ID`.
3. FOR EACH error code, THE Documentation SHALL specify the associated HTTP status code, a description of when it is returned, and the response body shape.
4. THE Documentation SHALL document the standard `400` error shape for missing tenant context.
5. THE Documentation SHALL document the `500 Internal Server Error` shape returned when an unexpected error occurs in a transition handler.

---

### Requirement 9: Verify Documentation Accuracy Against Source Code

**User Story:** As a maintainer, I want every documented parameter, payload shape, and error code verified directly against the source handlers, so that the documentation does not diverge from the running system.

#### Acceptance Criteria

1. THE Documentation SHALL reflect the route handler implementations in `src/routes/invoiceStateRoutes.js` as mounted at `/api/invoices`.
2. THE Documentation SHALL reflect the state definitions in `src/services/invoiceStateMachine.js` (`INVOICE_STATES`, `VALID_TRANSITIONS`, `TERMINAL_STATES`, `CAPITAL_MOVING_STATES`).
3. THE Documentation SHALL reflect the error codes surfaced by the test suite in `tests/invoice.state.test.js`.
4. WHEN a discrepancy exists between the documented interface and the source code, THE Documentation SHALL reflect the source code as the authoritative definition.

---

### Requirement 10: Provide a Pull Request Description Template

**User Story:** As a contributor, I want a ready-to-use PR description template for the invoice-state documentation change, so that reviewers immediately understand the scope and can confirm test results.

#### Acceptance Criteria

1. THE PR_Description_Template SHALL include a summary section listing all documented routes and their HTTP methods.
2. THE PR_Description_Template SHALL include a changes section describing what was created or modified.
3. THE PR_Description_Template SHALL include a placeholder block clearly marked for the full `npm test` output.
4. THE PR_Description_Template SHALL include a verification checklist with `npm run lint`, `npm test`, and `npm run build` items.
5. THE PR_Description_Template SHALL be placed in `docs/PR_DESCRIPTION_invoice_state.md`.
