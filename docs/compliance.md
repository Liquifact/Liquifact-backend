# Audit and Retention Compliance Model

## Purpose

This document maps LiquiFact backend compliance guarantees to the enforcing code and migrations.
It covers:
- append-only audit event storage,
- dual audit paths for invoice transitions vs. admin/webhook events,
- PII retention and purge scheduling,
- legal holds that exempt records from purge.

It is scoped to the Express backend and aligns with on-chain LiquifactEscrow / Stellar by documenting how off-chain invoice state mutations are audited before escrow funding and settlement.

---

## Audit Compliance Model

### What is audited

- Admin actions and configuration changes under `src/middleware/auditLog.js`
- Webhook send/delivery outcomes via `req.audit.logWebhookDelivery()`
- Invoice lifecycle transitions via `src/services/invoiceStateMachine.js`
- General API mutation auditing via `src/middleware/audit.js`

### Dual audit paths

1. **Database-backed append-only events**
   - `src/services/auditLogStore.js`
   - `src/middleware/auditLog.js`
   - Database table: `audit_log_events`
   - Event categories supported: `admin_action`, `webhook_delivery`

2. **In-memory invoice and resource audit trail**
   - `src/services/auditLog.js`
   - `src/middleware/audit.js`
   - Used for invoice state transitions and request/response mutation tracking
   - Supporting helper: `src/services/auditLog.js:getAuditLogs`

### Immutable audit log enforcement

- Migration: `migrations/202604260001_create_audit_log_events.sql`
  - Creates `audit_log_events`
  - Defines event columns and indexes
- Migration: `migrations/202604260002_enforce_audit_log_append_only.sql`
  - Adds `prevent_audit_log_update_or_delete()` trigger function
  - Adds triggers:
    - `trg_audit_log_no_update`
    - `trg_audit_log_no_delete`
- Guarantee: any attempt to `UPDATE` or `DELETE` a row in `audit_log_events` will fail at the DB layer.

### Audit record contents

`src/services/auditLogStore.js:appendAuditEvent()` persists records with:
- `event_type`, `action`, `actor_type`, `actor_id`
- Optional `target_type`, `target_id`
- Request metadata: `route`, `method`, `status_code`, `ip_address`, `user_agent`
- Redacted `metadata` JSON

`src/middleware/auditLog.js` records admin actions by default on successful HTTP `POST|PUT|PATCH|DELETE` requests under `/api/admin/*`.

### Sensitive data redaction

- `src/services/auditLogStore.js:redactValue()` redacts keys matching patterns:
  - `password`, `secret`, `token`, `api/key`, `authorization`, `privateKey`, `seed`, `mnemonic`
- `src/services/auditLog.js:sanitizeSensitiveData()` redacts keys matching:
  - `password`, `token`, `secret`, `key`, `apiKey`, `authorization`
- This prevents secrets from being recorded in audit logs.

### Invoice state transition auditing

- `src/services/invoiceStateMachine.js:executeTransition()` creates an audit entry for each state transition.
- The transition record captures:
  - actor identity
  - `STATE_TRANSITION` action
  - `resourceType: 'invoice'`
  - before/after state change
  - `timestamp`, `ipAddress`, `userAgent`
- `src/routes/invoiceStateRoutes.js` returns `auditLogId` for transition responses.

### Compliance review question

> Is this record immutable?

- For admin actions and webhook deliveries: yes, `audit_log_events` is append-only and protected by DB triggers.
- For invoice transition history: the in-memory audit trail is preserved by `src/services/auditLog.js` and exposed via `getAuditLogs()`, but it is not persisted to `audit_log_events` unless routed through `src/middleware/auditLog.js`.

> When is it purged?

- Audit event rows in `audit_log_events` are not purged by the retention purge system.
- Retention applies only to PII fields on `invoices` and related retention audit tables.

---

## Retention Compliance Model

### Core retention tables

- `retention_policies` — defines policy duration and PII fields
- `legal_holds` — prevents purge for protected invoices
- `retention_audit_log` — records retention operations and dry runs
- `retention_job_executions` — records retention job history

### Policy enforcement modules

- `src/routes/retention.js` — validated admin-facing API for policies, holds, and job scheduling
- `src/jobs/retentionPurge.js` — job logic that evaluates policy eligibility and purges PII
- `migrations/20250425000000_create_retention_system.sql` — creates retention schema and RLS policies

### Purge behavior

- Only PII fields are nulled on `invoices`.
- The job does not delete invoices or on-chain escrow state.
- Eligible invoices are selected by:
  - `tenant_id`
  - `created_at < now() - retention_days`
  - `deleted_at IS NULL`
  - not under active legal hold
- Purge is performed by `purgeInvoicePii()` in `src/jobs/retentionPurge.js`.

### Legal hold exemption

- `src/jobs/retentionPurge.js:isUnderLegalHold()` excludes invoices if:
  - `status = 'active'`
  - `expires_at IS NULL` or `expires_at > now()`
- `src/middleware/legalHoldGate.js` also blocks funding operations if an invoice is under legal hold.
- Legal holds are created and released through `src/routes/retention.js`.

### Dry run and audit trail

- `scheduleRetentionPurge({ dryRun: true })` simulates purge without modifying invoice rows.
- Dry-run results are still recorded in `retention_audit_log` with `operation = 'dry_run'`.
- Actual purge operations use `operation = 'pii_purged'`.
- Each audit entry captures:
  - `tenantId`, `invoiceId`
  - `pii_fields`
  - `old_values`
  - `reason`
  - `performed_by`
  - `metadata`

### Compliance review question

> Is this record immutable?

- `retention_audit_log` is append-only for retention operations, but it is not protected by the same trigger-based append-only enforcement used for `audit_log_events`.
- `retention_job_executions` captures job status and is immutable by convention once a job is completed.

> When is it purged?

- PII is purged when invoice age exceeds `retention_days` and no legal hold applies.
- The purge schedule is driven by `POST /api/retention/jobs/schedule`.
- Legal holds defer purge until they are released or expired.

### Tenant separation and security

- Retention tables enable row-level security in `migrations/20250425000000_create_retention_system.sql`.
- `src/routes/retention.js` protects retention endpoints with `adminAuth`.
- Input validation is enforced using Zod schemas:
  - retention policy creation/update
  - legal hold creation
  - job scheduling
- `sensitiveLimiter` is applied to retention write endpoints to limit abuse.

---

## Operational references

- `src/middleware/auditLog.js` — admin/webhook audit context
- `src/services/auditLogStore.js` — redact + persist audit events
- `src/middleware/audit.js` — request mutation audit middleware
- `src/services/auditLog.js` — in-memory invoice audit trail and change diffing
- `src/jobs/retentionPurge.js` — retention purge workflow
- `src/routes/retention.js` — retention API and scheduling
- `src/middleware/legalHoldGate.js` — legal hold funding gate
- `migrations/202604260001_create_audit_log_events.sql` — append-only audit table
- `migrations/202604260002_enforce_audit_log_append_only.sql` — append-only DB triggers
- `migrations/20250425000000_create_retention_system.sql` — retention policy and legal hold schema
