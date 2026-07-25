# Multi-Tenant Isolation Model

This document outlines the multi-tenant architecture and data isolation model implemented in the LiquiFact backend.

## Overview

### What a Tenant Represents
In LiquiFact, a **tenant** represents an independent organizational entity (e.g., a corporate client, financial institution, or discrete market operator) containing its own users, API keys, invoices, escrow logs, files, and settings. 

### Why Tenant Isolation Exists
LiquiFact serves multiple tenants on a single shared instance (database and compute resources). Since tenants may be direct competitors or handle highly sensitive financial data, ensuring that one tenant can never access, modify, or even detect the existence of another tenant's data is a core security requirement.

### Security Goals
1. **Zero Data Leakage**: No request from Tenant A should ever retrieve, update, delete, or check the existence of resources belonging to Tenant B.
2. **Access Control**: Users and API keys belong to a specific tenant and are restricted to operations on that tenant's resources.
3. **Storage & Cache Isolation**: All uploaded files and cached responses must be separated using tenant-specific namespaces or keys.
4. **Failsafe Enforcement**: Request context should automatically resolve and enforce the tenant scope. If the context cannot be resolved, the request must fail loudly and immediately.

---

## Tenant Resolution

The tenant context is resolved at the entrypoint of the request lifecycle using custom middleware.

```
Incoming Request
      │
      ▼
┌────────────────────────────────────────────────────────┐
│ check "x-tenant-id" Header                             │  (Service-to-Service / API Key)
└──────┬─────────────────────────────────────────────────┘
       │
       ├──► [Found & Valid] ──► Set req.tenantId ──► next()
       │
       ▼
┌────────────────────────────────────────────────────────┐
│ check JWT Claim "req.user.tenantId"                    │  (User / SME Session)
└──────┬─────────────────────────────────────────────────┘
       │
       ├──► [Found & Valid] ──► Set req.tenantId ──► next()
       │
       ▼
[Not Found / Invalid] ──► Reject with 400 Bad Request
```

### Resolution Logic & Priorities
The resolution is implemented in [src/middleware/tenant.js](file:///c:/Users/Kams/Liquifact-backend/src/middleware/tenant.js). The [extractTenant](file:///c:/Users/Kams/Liquifact-backend/src/middleware/tenant.js#L53-L76) middleware checks two sources in order of priority:

1. **`x-tenant-id` Header (Priority 1)**: Used for service-to-service communication or API-key authenticated flows.
2. **JWT claim `tenantId` (Priority 2)**: Stored in the user's authenticated token (e.g., `req.user.tenantId`), which is set by [authenticateToken](file:///c:/Users/Kams/Liquifact-backend/src/middleware/auth.js#L24-L93) middleware running upstream.

### Sanitisation & Constraints
To protect against injection attacks or invalid inputs, the raw tenant ID is sanitised using [sanitiseTenantId](file:///c:/Users/Kams/Liquifact-backend/src/middleware/tenant.js#L36-L41):
- Must be a string.
- Trimmed of leading/trailing whitespace.
- Must not be empty.
- Length-capped using `MAX_TENANT_ID_LENGTH` (defaults to 128 characters, configured in environment).

If no valid tenant ID can be resolved, the request is rejected immediately with a `400 Bad Request` containing:
```json
{
  "error": "Missing tenant context.",
  "message": "A valid tenant identifier must be supplied via the x-tenant-id header or an authenticated JWT claim."
}
```

---

## Request Propagation

Once the tenant is successfully resolved, the information flows through the system as follows:

```
[Middleware Stack]
  └─► auth.js / stacks.js (Validates JWT / API key)
       └─► tenant.js (Extracts and binds req.tenantId)
            │
            ▼
[Controller/Route Handlers]
  └─► Read req.tenantId
  └─► Pass tenantId as argument to Service layer
       │
       ▼
[Service Layer]
  └─► Pass tenantId to Database queries / Storage Service / Cache Store
```

### Middleware Stacks
Composed middleware chains are centralized in [src/middleware/stacks.js](file:///c:/Users/Kams/Liquifact-backend/src/middleware/stacks.js). There are two primary stacks:
- [authenticatedTenantStack](file:///c:/Users/Kams/Liquifact-backend/src/middleware/stacks.js#L49): Composed of `authenticateToken` followed by `extractTenant`.
- [adminStack](file:///c:/Users/Kams/Liquifact-backend/src/middleware/stacks.js#L61): Composed of `adminAuth` followed by `extractTenant`.

### Background Workers
When asynchronous jobs are scheduled, the tenant context is propagated in the job payload. 
In [src/workers/worker.js](file:///c:/Users/Kams/Liquifact-backend/src/workers/worker.js), the [buildJobContext](file:///c:/Users/Kams/Liquifact-backend/src/workers/worker.js#L255-L277) helper extracts the tenant context safely:
- It checks the job's `payload` object.
- Only a safe whitelist of context keys (including `tenantId`) is copied to the running job context to prevent leaking secrets.

---

## Enforcement Points

Multi-tenant isolation is enforced across all operational layers:

### 1. Middleware Layer
Routes requiring tenant isolation mount [extractTenant](file:///c:/Users/Kams/Liquifact-backend/src/middleware/tenant.js#L53-L76). Statically-ordered middleware ensures validation and context binding are completed before controller logic executes.

### 2. Service Layer & Database Query Scoping
The application relies on explicit query scoping in the service layer using Knex. Database queries that read, write, or delete resources **must** explicitly filter by `tenant_id`.

Examples from the codebase:
- **Invoices**: Enforced in [src/services/invoiceService.js](file:///c:/Users/Kams/Liquifact-backend/src/services/invoiceService.js). For example:
  - Reading a list: `db('invoices').where({ tenant_id: tenantId })` ([invoiceService.js:L120](file:///c:/Users/Kams/Liquifact-backend/src/services/invoiceService.js#L120))
  - Finding a single invoice: `db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first()` ([invoiceService.js:L293](file:///c:/Users/Kams/Liquifact-backend/src/services/invoiceService.js#L293))
  - Creation: Inserts `tenant_id: tenantId` ([invoiceService.js:L232](file:///c:/Users/Kams/Liquifact-backend/src/services/invoiceService.js#L232))
- **Investor Commitments**: Enforced in [src/services/investService.js](file:///c:/Users/Kams/Liquifact-backend/src/services/investService.js).
  - Queries filter by `tenant_id` (e.g. [investService.js:L73](file:///c:/Users/Kams/Liquifact-backend/src/services/investService.js#L73)).
- **Marketplace**: Enforced in [src/services/marketplaceService.js](file:///c:/Users/Kams/Liquifact-backend/src/services/marketplaceService.js) (e.g. [marketplaceService.js:L134](file:///c:/Users/Kams/Liquifact-backend/src/services/marketplaceService.js#L134)).
- **Webhooks**: Enforced in [src/services/webhooks.js](file:///c:/Users/Kams/Liquifact-backend/src/services/webhooks.js). Webhook settings and event delivery logs (including dead letters) are looked up and stored with the tenant context (e.g. [webhooks.js:L109](file:///c:/Users/Kams/Liquifact-backend/src/services/webhooks.js#L109), [webhooks.js:L339](file:///c:/Users/Kams/Liquifact-backend/src/services/webhooks.js#L339)).
- **Audit Logs**: Enforced in [src/services/auditLogStore.js](file:///c:/Users/Kams/Liquifact-backend/src/services/auditLogStore.js). Searches extract and filter log metadata by tenant ID ([auditLogStore.js:L190](file:///c:/Users/Kams/Liquifact-backend/src/services/auditLogStore.js#L190)):
  ```javascript
  query = query.whereRaw("metadata->>'tenantId' = ?", [filters.tenantId]);
  ```

### 3. PostgreSQL Row-Level Security (RLS)
The database schema defines Row-Level Security (RLS) policies as a defense-in-depth measure. 
The database checks the session variable `app.current_tenant_id` to restrict row access automatically if RLS is invoked:
- **`tenants`**: Managed in [migrations/20240425000001_create_users_and_tenants.sql](file:///c:/Users/Kams/Liquifact-backend/migrations/20240425000001_create_users_and_tenants.sql).
- **`users`**: RLS enforces `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`.
- **`api_keys`**: RLS enforces `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`.
- **`invoices`**: Managed in [migrations/20240425000002_add_tenant_to_invoices.sql](file:///c:/Users/Kams/Liquifact-backend/migrations/20240425000002_add_tenant_to_invoices.sql). Policy `invoice_tenant_policy` enforces `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`.
- **`escrow_operations`**, **`escrow_summaries`**, **`audit_logs`**: Managed in [migrations/20240425000003_create_escrow_operations.sql](file:///c:/Users/Kams/Liquifact-backend/migrations/20240425000003_create_escrow_operations.sql). Policies enforce matching tenant IDs using the SQL context variable.
- **`retention_policies`**, **`legal_holds`**, **`retention_audit_log`**, **`retention_job_executions`**: Managed in [migrations/20250425000000_create_retention_system.sql](file:///c:/Users/Kams/Liquifact-backend/migrations/20250425000000_create_retention_system.sql).

> [!NOTE]
> PostgreSQL RLS is currently configured in migrations for database-level security compliance. The active application codebase relies primarily on application-level query scoping using Knex (`.where({ tenant_id })`).

### 4. Storage Keys (S3 Files)
File uploads in [src/services/storage.js](file:///c:/Users/Kams/Liquifact-backend/src/services/storage.js) enforce strict tenant scoping via object key namespacing:
- The helper [_generateKey](file:///c:/Users/Kams/Liquifact-backend/src/services/storage.js#L95-L109) constructs the S3 object key with the tenant ID embedded:
  `tenants/${tenantId}/invoices/${invoiceId}/${uuid}-${safeName}`
- The tenant ID is validated against a safe alphanumeric regex (`/^[a-zA-Z0-9_-]+$/`) to prevent path traversal in the storage namespace ([storage.js:L87-L89](file:///c:/Users/Kams/Liquifact-backend/src/services/storage.js#L87-L89)).

Metadata for uploaded files is stored in the database `invoice_files` table containing `tenant_id` columns, scoped during query retrieval:
```javascript
return await db('invoice_files').where({ tenant_id: tenantId, invoice_id: invoiceId }).first();
```

### 5. Cache Keys
Response caching in [src/middleware/cache.js](file:///c:/Users/Kams/Liquifact-backend/src/middleware/cache.js) prevents cross-tenant cache poisoning by generating tenant-isolated keys:
- **Marketplace Cache Key**: `marketplace:${tenantId}:${req.originalUrl}` ([cache.js:L106-L109](file:///c:/Users/Kams/Liquifact-backend/src/middleware/cache.js#L106-L109))
- **Investor Locks List**: `investor:locks:${tenantId}:${req.originalUrl}` ([cache.js:L117-L120](file:///c:/Users/Kams/Liquifact-backend/src/middleware/cache.js#L117-L120))
- **Single Lock Key**: `investor:lock:${tenantId}:${req.params.invoiceId}:${req.query.funderAddress}` ([cache.js:L129-L132](file:///c:/Users/Kams/Liquifact-backend/src/middleware/cache.js#L129-L132))

---

## Contributor Checklist

When adding a new endpoint or service that handles tenant data, developers must verify the following items:

- [ ] **Resolve Tenant**: Ensure the route is protected by `extractTenant` (or mounts a composed stack from `stacks.js` like `authenticatedTenantStack` or `adminStack`).
- [ ] **Never Trust Client-supplied Tenant IDs**: Do **not** read `tenantId` from client query parameters, route parameters, or JSON payloads (unless it is an administrative endpoint explicitly authorized to manage multiple tenants). Always resolve it using `req.tenantId` set by the middleware.
- [ ] **Scope Database Queries**: Every Knex query that interacts with tenant-scoped tables must include a `.where('tenant_id', tenantId)` or `.where({ tenant_id: tenantId })` constraint.
- [ ] **Scope Storage Keys**: When storing or fetching S3 files, ensure the S3 object key is constructed using the `StorageService` generator containing the tenant ID prefix.
- [ ] **Scope Cache Keys**: When caching HTTP responses, ensure cache keys incorporate the `req.tenantId` context variable.
- [ ] **SME Wallet and Ownership Check**: If the endpoint operates on a specific SME resource (e.g. invoices), compose `verifyInvoiceOwner` or verify that the user's bound wallet (`req.walletAddress`) corresponds to the invoice's wallet address or `ownerId`.
- [ ] **Test Cross-Tenant Isolation**: Write integration tests asserting that attempts to access resources belonging to a different tenant ID return an appropriate error (e.g., `404 Not Found` to avoid confirming resource existence, or `400 Bad Request` / `403 Forbidden`).

---

## Anti-patterns

Contributors must avoid these common errors when writing code in this repository:

### 1. Unscoped Database Queries
Performing a lookup on a resource using only its primary key (e.g., `id` or `invoice_id`) without filtering by `tenant_id`.
*Incorrect:*
```javascript
const invoice = await db('invoices').where({ invoice_id: id }).first();
```
*Correct:*
```javascript
const invoice = await db('invoices').where({ invoice_id: id, tenant_id: tenantId }).first();
```

### 2. Reading Tenant ID from Client Body or Request Parameters
Allowing the client to specify the target tenant inside the request body or path variables for standard operations.
*Incorrect:*
```javascript
router.post('/invoices', async (req, res) => {
  const { tenantId, amount } = req.body; // VULNERABILITY: Client controls the tenant mapping
  ...
});
```
*Correct:*
```javascript
router.post('/invoices', extractTenant, async (req, res) => {
  const tenantId = req.tenantId; // Secured: Context resolved from JWT or signed header
  const { amount } = req.body;
  ...
});
```

### 3. Missing S3 Path Validation or Key Prefix
Generating S3 keys dynamically from user input without sanitising the input or omitting the tenant prefix. This could allow path traversal or cross-tenant document hijacking.
*Incorrect:*
```javascript
const key = `invoices/${req.body.fileName}`;
```
*Correct:*
```javascript
const key = storageService.generateKey({ tenantId: req.tenantId, invoiceId, fileName });
```

### 4. Shared Cache Leakage
Caching responses on a key that only includes the path or URL path query, without including the tenant context.
*Incorrect:*
```javascript
const cacheKey = `marketplace:${req.originalUrl}`; // VULNERABILITY: Tenant A's cached search results can be served to Tenant B
```
*Correct:*
```javascript
const cacheKey = `marketplace:${req.tenantId}:${req.originalUrl}`;
```
