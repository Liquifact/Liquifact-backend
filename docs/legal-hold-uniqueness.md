# Legal hold uniqueness

Legal holds must be created atomically so concurrent requests cannot insert
duplicate holds for the same invoice. The service enforces uniqueness on
`(tenant_id, invoice_id)` at the database layer and surfaces `409 Conflict`
when a hold already exists.

Operators clearing holds should use the documented admin API so audit events
remain append-only. See `tests/escrow.legalhold.test.js` for tri-state gate
behaviour and fail-closed paths on unknown hold status.
