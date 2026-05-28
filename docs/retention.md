# Data Retention System Documentation

## Overview

LiquiFact's retention system protects PII while preserving invoice state and auditability.
This doc describes the enforcement model, the purge schedule, dry-run behavior, legal hold exemptions, and the data flow for retention compliance.

## Core retention schema

### `retention_policies`

- `id`: UUID
- `tenant_id`: tenant isolation
- `name`: policy name
- `description`: optional description
- `retention_days`: days before PII purge
- `pii_fields`: fields to nullify
- `is_active`: active flag
- `created_at`, `updated_at`, `deleted_at`

### `legal_holds`

- `id`: UUID
- `tenant_id`: tenant isolation
- `invoice_id`: invoice reference
- `hold_reason`: reason for hold
- `hold_type`: `litigation`, `investigation`, `audit`, `regulatory`
- `status`: `active`, `released`, `expired`
- `placed_by`: user who created the hold
- `placed_at`, `released_at`, `expires_at`
- `metadata`: optional JSON

### `retention_audit_log`

- `id`: UUID
- `tenant_id`
- `invoice_id`
- `operation`: `pii_purged`, `policy_applied`, `hold_placed`, `hold_released`, `dry_run`
- `pii_fields`
- `old_values`
- `new_values`
- `reason`
- `performed_by`
- `performed_at`
- `metadata`

### `retention_job_executions`

- `id`: UUID
- `tenant_id`
- `job_type`: `scheduled_purge`, `manual_purge`
- `status`: `started`, `completed`, `failed`, `cancelled`
- `dry_run`
- `invoices_processed`
- `invoices_purged`
- `pii_fields_purged`
- `errors`
- `started_at`, `completed_at`
- `performed_by`
- `metadata`

## What is retained vs purged

### Retained data

- Invoice identifiers and invoice records remain intact
- On-chain escrow references and invoice status are preserved
- Non-PII invoice fields remain unchanged

### Purged data

The retention job only nulls listed PII fields on `invoices`:
- `customer_name`
- `customer_email`
- `customer_tax_id`

This preserves compliance with privacy/PII requirements while keeping invoice lifecycle records available for audit.

## Retention enforcement flow

### Retention policy evaluation

- `src/jobs/retentionPurge.js` is the core enforcement module.
- It loads applicable policies from `retention_policies`.
- If `policyId` is provided, only that policy is used; otherwise active policies are applied.
- Fields are validated with `validatePiiFields()` to prevent invalid purge targets.

### Eligible invoice selection

`getEligibleInvoices()` selects invoices that:
- belong to the tenant
- were created before `now() - retention_days`
- have `deleted_at IS NULL`
- are not subject to an active legal hold

### Legal hold exemption

`isUnderLegalHold()` excludes invoices when a matching `legal_holds` row exists with:
- `tenant_id` matching the tenant
- `invoice_id` matching the invoice
- `status = 'active'`
- `expires_at IS NULL` or `expires_at > now()`

This is enforced both during invoice selection and immediately before purging each invoice to handle holds added after the initial query.

### Purge operation

- `purgeInvoicePii()` sets each configured PII field to `null`.
- For dry runs, the job returns the planned purge result without updating invoices.
- Actual purged rows are logged to `retention_audit_log` with `operation = 'pii_purged'`.

## Auditability of retention operations

### Dry-run behavior

- Dry runs are supported by `dryRun: true`.
- They simulate the purge and record `operation = 'dry_run'` in `retention_audit_log`.
- `retention_job_executions` still tracks the job execution.

### Audit trails

- `retention_audit_log` captures every configured purge decision.
- `retention_job_executions` captures job lifecycle, processed counts, and errors.
- `performed_by` tracks the actor who scheduled or triggered the job.

## Legal hold gating

- `src/middleware/legalHoldGate.js` blocks funding-related requests when an invoice is under hold.
- This provides a second enforcement layer besides retention selection.
- If held, requests receive `502 Escrow is under legal hold`.

## API and scheduling

### Retention policy management

- `POST /api/retention/policies` — create a new retention policy
- `PUT /api/retention/policies/{policyId}` — update an existing policy
- `GET /api/retention/policies` — list policies for the tenant

### Legal hold management

- `POST /api/retention/legal-holds` — create a legal hold
- `PUT /api/retention/legal-holds/{holdId}/release` — release a legal hold
- `GET /api/retention/legal-holds` — list legal holds

### Job scheduling

- `POST /api/retention/jobs/schedule` — schedule a retention purge
- `GET /api/retention/jobs/{executionId}` — get job status
- Dry-run preview jobs can be executed immediately (`dryRun=true` with `delayMs=0`) to return row counts and sample purge targets without modifying invoices.

## Security and validation

- `src/routes/retention.js` uses Zod schemas for request validation.
- `adminAuth` permits JWT or `x-api-key` authentication for retention management.
- `sensitiveLimiter` protects retention policy and legal hold endpoints.
- Purge fields are explicitly validated to one of `customer_name`, `customer_email`, `customer_tax_id`.
- `RETENTION_MAX_ROWS_PER_RUN` caps the number of retention rows processed per job to prevent runaway purges.

## Compliance review question

> Is this record immutable?

- PII purge decisions are recorded in `retention_audit_log`.
- `retention_job_executions` records are intended to be append-only after completion.
- The purge itself is not a physical deletion; it nulls PII fields while preserving the invoice row.

> When is it purged?

- When the invoice is older than the retention policy cutoff and not under an active legal hold.
- When the retention purge job runs via `src/jobs/retentionPurge.js`.
- When `dryRun` is enabled, the purge is simulated and no invoice data is modified.

## Implementation references

- `migrations/20250425000000_create_retention_system.sql`
- `src/routes/retention.js`
- `src/jobs/retentionPurge.js`
- `src/middleware/legalHoldGate.js`

## Default policy behavior

- A default 7-year retention policy is created by trigger in `migrations/20250425000000_create_retention_system.sql` for new tenants.
- Default fields: `customer_name`, `customer_email`, `customer_tax_id`.

## Notes

- Retention does not remove on-chain escrow state or invoice identity.
- Retention protects privacy by clearing only PII fields selected by policy.
- Legal holds can delay purge until release or expiration.
