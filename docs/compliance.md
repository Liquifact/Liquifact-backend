# KYC Compliance Implementation

## Overview

This document outlines the KYC (Know Your Customer) compliance framework implemented in the LiquiFact backend. The system enforces SME identity verification before allowing capital deployment through **all** funding and settlement endpoints.

**Status**: Production-ready implementation with optional external provider integration.  
**Date**: May 2026  
**Version**: 1.1.0  
**Relates to**: Issue #222 — Enforce KYC gating on all capital-movement endpoints

---

## Architecture

### Data Model

```
Invoice
├── id (string): Unique identifier
├── status (enum): pending_verification | verified | funded | settled | defaulted
├── amount (number): Invoice amount
├── smeId (string): Associated SME identifier
└── kycStatus (enum): ⭐ NEW FIELD
    ├── pending: KYC not yet initiated
    ├── verified: Passed KYC verification
    ├── rejected: Failed verification
    └── exempted: Exempt from KYC requirements
```

### Database Schema

A migration has been added to create the `kyc_records` table:

**File**: `src/db/migrations/20260425_add_kyc_status.js`

**Changes**:
- Creates `kyc_records` table to store KYC status records keyed by `sme_id`.
- Columns: `sme_id` (Primary Key), `status` (pending/verified/rejected/exempted), `provider_record_id`, `verified_at`, `updated_at`.
- All mock verification functions (`verifySmeSafe`, `rejectSmeKyc`, `exemptSmeFromKyc`) and external provider lookups persist status updates directly to this table. This ensures KYC state survives process restarts and is shared across replicas.

### Persistence Architecture (Issue #593)

KYC status records are persisted to the `kyc_records` table via the `persistKycRecord()` helper:

**Primary persistence path** (`getKycStatus` → `readKycRecord`):
1. If external provider is configured → read through short-TTL cache, fall back to DB on provider failure.
2. If no provider → read straight from `kyc_records` table.
3. If no DB record → fall back to in-memory `mockKycRecords` (dev/test only).
4. Final fallback → returns `{ status: 'pending' }`.

**Write path** (`verifySmeSafe`, `rejectSmeKyc`, `exemptSmeFromKyc`, KYC webhook):
1. Update in-memory `mockKycRecords` (backward-compatible for dev/test).
2. Call `persistKycRecord()` which: invalidates the short-TTL cache entry, upserts the record into `kyc_records`.
3. The cache invalidation happens **before** the DB write so that concurrent readers cannot serve a stale cached approval past a revocation event.

**Restart survivability**:
- On restart, `mockKycRecords` is empty (process-local).
- `getKycStatus` falls through to `readKycRecord`, which reads from the `kyc_records` table.
- Status survives restarts and is shared across all replicas that share the same database.

**Idempotency**:
- `persistKycRecord` uses an upsert pattern (check → insert or update).
- Re-verifying an already-verified SME is safe; the record is updated in-place.
- Duplicate webhook deliveries produce the same result without errors.

**Tenant scoping (future enhancement)**:
- The current `kyc_records` schema is keyed by `sme_id` only. For multi-tenant
  deployments where the same `sme_id` could exist across tenants, the table
  should gain a `tenant_id` column and a composite unique constraint on
  `(tenant_id, sme_id)`. All reads and writes through `persistKycRecord` and
  `readKycRecord` would then need to scope by the request's tenant context.
  This is tracked as a follow-up item.

Run migrations:
```bash
npm run db:migrate
```

### Service Layer

**File**: `src/services/kycService.js`

Core KYC operations:

```javascript
// Get KYC status (checks external provider if configured, falls back to mock)
await kycService.getKycStatus(smeId)
→ { status, recordId?, verifiedAt? }

// Verify SME (mock implementation, for testing)
await kycService.verifySmeSafe(smeId, { recordId? })
→ { status: 'verified', recordId, verifiedAt }

// Reject SME
await kycService.rejectSmeKyc(smeId, reason)
→ { status: 'rejected', recordId }

// Exempt from KYC
await kycService.exemptSmeFromKyc(smeId, reason)
→ { status: 'exempted', recordId }

// Check if status permits funding
kycService.canFundWithKycStatus(status) → boolean
```

### Middleware: KYC Gating

**File**: `src/middleware/kycGating.js`

The `requireKycForFunding` middleware enforces KYC requirements on **all** capital-movement endpoints.

#### Security contract — smeId resolution (anti-spoofing fix, issue #222)

Prior to this fix, `smeId` was resolved as
`req.user.smeId || req.body.smeId || req.params.smeId`, which allowed an
authenticated caller to supply a verified SME's ID in the request body or URL
parameter and pass the gate for an SME they do not own.

**The gate now resolves `smeId` exclusively from `req.user.smeId`** — the JWT
claim set by `authenticateToken`. Body and parameter values are intentionally
ignored during the identity check.

```javascript
// ✅ CORRECT — smeId tied to authenticated principal
const smeId = req.user.smeId || null;

// ❌ OLD (vulnerable) — body/params could be spoofed
// const smeId = req.user.smeId || req.body?.smeId || req.params?.smeId;
```

#### Gated endpoints

| Endpoint | Method | Gate |
|---|---|---|
| `/api/invest/fund-invoice` | POST | `requireKycForFunding` |
| `/api/invoices/:id/link-escrow` | POST | `requireKycForFunding` |
| `/api/invoices/:id/transition` | POST | `conditionalKycGate` (only when `targetState` ∈ `{funded, settled}`) |

**Behavior**:
1. Validates user is authenticated
2. Extracts `smeId` exclusively from the JWT (`req.user.smeId`)
3. Returns `400 MISSING_SME_ID` if the JWT contains no `smeId` claim
4. Checks KYC status for the authenticated SME
5. Returns `403 KYC_GATE_FAILED` if status is not `'verified'` or `'exempted'`
6. Attaches `{ smeId, status, recordId, verifiedAt }` to `req.kyc` for downstream handlers

**Error Codes**:
- `401 UNAUTHORIZED`: No authentication
- `400 MISSING_SME_ID`: JWT contains no `smeId` claim
- `403 KYC_GATE_FAILED`: KYC verification not met
- `500 KYC_CHECK_FAILED`: Service error during KYC lookup

---

## API Integration

### Gated Endpoints

#### POST /api/invest/fund-invoice

Initiates capital transfer to escrow. **Requires KYC verification** (`smeId` from JWT).

**Request**:
```json
{
  "invoiceId": "inv_7788",
  "investmentAmount": 5000,
  "smeId": "sme_001"
}
```

**Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Success (201)**:
```json
{
  "data": {
    "investmentId": "inv_1714039442_a1b2c3d",
    "invoiceId": "inv_7788",
    "smeId": "sme_001",
    "investmentAmount": 5000,
    "status": "pending",
    "onChain": {
      "escrowAddress": "CAB1234567890QWERTYU",
      "ledgerIndex": "124500"
    }
  },
  "meta": {
    "timestamp": "2026-04-25T10:30:00Z",
    "version": "0.1.0",
    "kycVerified": true,
    "kycStatus": "verified"
  },
  "message": "Investment submitted successfully."
}
```

**Failure - KYC Not Verified (403)**:
```json
{
  "error": {
    "code": "KYC_GATE_FAILED",
    "message": "SME KYC status 'pending' does not permit funding operations. Status must be 'verified' or 'exempted'.",
    "type": "https://liquifact.com/probs/kyc-required",
    "retryable": false,
    "retryHint": "Complete KYC verification and try again."
  }
}
```

**Failure - Validation Error (400)**:
```json
{
  "error": {
    "code": "INVALID_INVESTMENT_AMOUNT",
    "message": "investmentAmount is required and must be a positive number.",
    "type": "https://liquifact.com/probs/validation-error"
  }
}
```

### cURL Examples

#### 1. Fund Invoice (Verified SME)

```bash
# Assuming KYC already verified for sme_001

curl -X POST http://localhost:3001/api/invest/fund-invoice \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "inv_7788",
    "investmentAmount": 5000,
    "smeId": "sme_001"
  }'
```

**Expected Response (201)**:
```json
{
  "data": {
    "investmentId": "inv_1714039442_a1b2c3d",
    "invoiceId": "inv_7788",
    "status": "pending"
  },
  "meta": { "kycVerified": true, "kycStatus": "verified" }
}
```

#### 2. Attempt Funding Without KYC

```bash
# Assuming KYC is PENDING for sme_999

curl -X POST http://localhost:3001/api/invest/fund-invoice \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "inv_2244",
    "investmentAmount": 2000,
    "smeId": "sme_999"
  }'
```

**Expected Response (403)**:
```json
{
  "error": {
    "code": "KYC_GATE_FAILED",
    "message": "SME KYC status 'pending' does not permit funding operations...",
    "type": "https://liquifact.com/probs/kyc-required"
  }
}
```

---

#### POST /api/invoices/:id/link-escrow  *(added — issue #222)*

Links an approved invoice into the escrow funding lifecycle. **Requires KYC verification**.

The `smeId` is resolved from `req.user.smeId` (JWT). If absent, returns `400 MISSING_SME_ID`.

---

#### POST /api/invoices/:id/transition  *(conditionally gated — issue #222)*

Executes an invoice state transition. KYC is required only when the `targetState` is a
capital-moving state (`funded` or `settled`). Non-capital transitions (`approved`, `rejected`)
are not blocked by this gate.

---

## Environment Configuration

### Optional KYC Provider Integration

To enable external KYC provider:

**Set environment variables**:
```bash
# .env file (for testing)
KYC_PROVIDER_URL=https://kyc-provider.example.com/api
KYC_PROVIDER_API_KEY=your-api-key-here
KYC_PROVIDER_SECRET=optional-secondary-key  # Optional

# Deployment secrets (never in repo)
export KYC_PROVIDER_URL=...
export KYC_PROVIDER_API_KEY=...
```

**Code**:
```javascript
const config = kycService.getKycProviderConfig();
console.log(config);
// {
//   enabled: true,
//   apiKey: "your-api-key-here",
//   baseUrl: "https://kyc-provider.example.com/api",
//   apiSecret: null
// }
```

### Development Mode (Default)

When environment variables are **not set**, the system defaults to:
- **Mock KYC provider**: In-memory record storage
- **Testing friendly**: Use `kycService.verifySmeSafe()` to simulate verified SMEs
- **No external dependencies**: Useful for local dev and testing

---

## External KYC Provider Transport Hardening (Issue #592)

**Status**: Production-ready.  
**Date**: July 2026.  
**Relates to**: Issue #592 — Implement the external KYC provider HTTP integration behind the existing stub.

### What changed

The `verifyWithExternalProvider()` HTTP call is hardened end-to-end so a flaky
or hostile KYC provider cannot (a) hang the request, (b) silently auto-verify
an SME, or (c) leak credentials:

| Concern | Mitigation |
|---|---|
| Hanging request | `AbortController` with `KYC_PROVIDER_TIMEOUT_MS` (clamped 100–30000 ms, default 5000). |
| Transient outages | Exponential back-off retries via `src/utils/retry.js`, capped at `KYC_PROVIDER_MAX_RETRIES` (0–10, default 3). |
| Sustained outages | Shared `CircuitBreaker(name=kyc)` trips after `KYC_PROVIDER_CB_FAILURE_THRESHOLD` failures (default 5) and fails fast with `code=CIRCUIT_OPEN` for `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS` (default 10000 ms). |
| Provider-side 4xx | Permanent — `KycProviderError{retryable: false}` is raised immediately, never auto-verifies. |
| Provider-side 5xx / 429 / network code | Retried up to `KYC_PROVIDER_MAX_RETRIES` with `KYC_PROVIDER_BASE_DELAY_MS` (default 200) base / `KYC_PROVIDER_MAX_DELAY_MS` (default 5000) cap. |
| Spoofed response | Defensive verification when the provider sends `X-KYC-Signature` / `X-KYC-Response-Signature`. Mismatches fail closed with `code=invalid_response_signature`. |
| Unsigned response from non-signing providers | Accepted by default; `KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE=true` enables strict mode that REQUIRES the header. |
| Outbound forgery | HMAC request signing reuses `createSignatureHeader` (`t=<ts>,v1=<hex>`) over the JSON body when `KYC_PROVIDER_SIGN_REQUESTS=true` and `KYC_PROVIDER_SECRET` is set. |

### Status flow

`verifyWithExternalProvider()` raises a typed `KycProviderError`:

```text
retryable=true  on: network ETIMEDOUT/ECONNRESET/ECONNREFUSED/ENOTFOUND/EAI_AGAIN,
                HTTP 408/425/429/5xx, AbortError (timeout)
retryable=false on: HTTP 4xx (other), invalid JSON, mismatched signature,
                missing-in-strict-mode signature, CIRCUIT_OPEN-escalated errors
```

The retry helper inspects `err.retryable` (or `classifyKycError(err)` for raw
fetch errors) to decide whether to attempt again. After exhaustion the error
propagates to `getKycStatus()`, which **always falls back to the persisted DB
record** before returning `pending` — the system NEVER auto-verifies on a
provider failure.

### Fail-closed security contract

1. **No auto-verify on failure**: a `KycProviderError` (retryable or not) is
   raised to the caller. `getKycStatus` catches it and returns the previously
   persisted record. If no record exists, returns `pending` — never `verified`.
2. **Secrets never logged**: API key, signing secret, raw provider JSON body,
   and any signature header are excluded from `logger.warn` / `logger.error`
   payloads. Tests in `tests/kyc.provider.test.js` assert this directly.
3. **Secrets never returned**: the result object (`{status, recordId, verifiedAt}`)
   contains only normalised KYC values — no upstream field names, no provider
   IDs that map back to a credential.
4. **Bounded retries**: `KYC_PROVIDER_MAX_RETRIES ∈ [0, 10]`,
   `KYC_PROVIDER_TIMEOUT_MS ∈ [100, 30000]`,
   `KYC_PROVIDER_CB_FAILURE_THRESHOLD ∈ [1, 100]`,
   `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS ∈ [100, 60000]`. A typo in any of these
   cannot disable the safety bounds.

### Provider URL leak hardening

`verifyWithExternalProvider()` derives a `providerHost` from the configured
base URL using `new URL(baseUrl).host` and logs ONLY the host (e.g.
`kyc.example.com`) — never the path, query string, or fragments. This prevents
secret-laden query parameters (`?api_key=…`) from being captured in
application logs.

### Sign / verify response: format reference

Both share the `t=<unix_ts>,v1=<hex_sha256>` header format used by inbound
webhooks (`createSignatureHeader` / `verifySignature` in
`src/services/webhooks.js`). The signed canonical string is
`${timestamp_seconds}.${raw_body}`. The HMAC uses SHA-256 in hex mode, and
verification uses `crypto.timingSafeEqual` so a brute-force attacker cannot
recover the secret from timing differences.

```
// Outbound X-KYC-Signature example
t=1753372800,v1=4f7c8e1a9b2d...

// Inbound X-Signature example (existing webhook scheme)
t=1753372800,v1=4f7c8e1a9b2d...
```

### New environment variables

| Variable | Default | Range | Effect |
|---|---|---|---|
| `KYC_PROVIDER_TIMEOUT_MS` | 5000 | 100–30000 | Per-request AbortController timeout. |
| `KYC_PROVIDER_MAX_RETRIES` | 3 | 0–10 | Retry attempts for transient failures. |
| `KYC_PROVIDER_BASE_DELAY_MS` | 200 | 0–10000 | Initial back-off for retries. |
| `KYC_PROVIDER_MAX_DELAY_MS` | 5000 | 0–60000 | Cap on back-off between attempts. |
| `KYC_PROVIDER_SIGN_REQUESTS` | false | true/false | Enable outbound HMAC signing. |
| `KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE` | false | true/false | Require provider response signature. |
| `KYC_PROVIDER_CB_FAILURE_THRESHOLD` | 5 | 1–100 | Consecutive failures before tripping. |
| `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS` | 10000 | 100–60000 | Wait time before half-open probe. |

All variables are validated at boot in `src/config/index.js` via Zod and are
also clamped at module load in `getKycProviderConfig()`, so a missing
`validate()` call in tests still produces safe bounds.

### Observability

Circuit-breaker state transitions are emitted on the existing
`sorobanCircuitBreakerStateTransitionsTotal` Prometheus counter with the
label `name=kyc`. Operators can alert on
`increase(sorobanCircuitBreakerStateTransitionsTotal{name="kyc", to="OPEN"}[5m]) > 0`
the same way they already monitor the Soroban dependency breaker.

### Test coverage

`tests/kyc.provider.test.js` covers (16 describe blocks, 50+ cases):

1. Provider success — correct URL, bearer auth, content-type, return shape.
2. Provider 5xx fallback — retries exhausted, persisted record returned.
3. Provider network failure fallback — `pending` returned, never throws.
4. Persistence read-back — direct DB lookups honoured when provider is off.
5. Funding gate — `canFundWithKycStatus` allowlist, `verified` / `exempted` only.
6. Input validation — empty / non-string `smeId`.
7. `verifyWithExternalProvider` — new-error-type contract, signing-off default.
8. Bounded timeout — `AbortController` fires within `KYC_PROVIDER_TIMEOUT_MS`.
9. Retry — transient 503 retried then succeeds; permanent 400 retried zero times.
10. Circuit breaker — `failureThreshold` consecutive failures trips OPEN; subsequent
    call fails fast without invoking fetch.
11. Outbound HMAC signing — `X-KYC-Signature` matches `verifySignature` recomputation.
12. Response integrity verification — mismatched signature rejected; valid signature accepted;
    strict-mode missing signature rejected; non-strict missing signature accepted.
13. `classifyKycError` — 5xx / network codes retryable, 4xx non-retryable.
14. Secret-leak prevention — error messages and logger payloads never contain key/secret.
15. `parseClampedInt` — fallback, clamp, type coercion.
16. Mock path preservation — provider unconfigured or only URL set never invokes fetch.
17. KYC webhook route — unchanged inbound signature verification (already covered).

Run:

```bash
npm test -- tests/kyc.provider.test.js
```

---
### Input Validation

All user inputs are validated before KYC checks:

✅ SME ID: Required, string, max 128 chars  
✅ Invoice ID: Required, format validation  
✅ Investment Amount: Required, positive number  
✅ Status values: Enum-constrained (pending | verified | rejected | exempted)

**Validation Code**:
```javascript
const { validateInvoiceCreation, validateKycStatusUpdate } = require('src/schemas/invoice');

const invoice = { /* ... */ };
const validation = validateInvoiceCreation(invoice);
if (!validation.valid) {
  console.error(validation.errors);
}
```

### Authentication & Authorization

1. **JWT Authentication**: All KYC-gated endpoints require valid JWT
2. **User Context**: `req.user.sub` is attached by auth middleware
3. **Tenant Isolation**: Each request includes tenant context (via header or JWT)
4. **Rate Limiting**: KYC endpoints subject to sensitive rate limits (40 req/hour)

**Middleware Stack** (capital-movement endpoints):
```javascript
// Example: POST /api/invest/fund-invoice
app.post('/api/invest/fund-invoice',
  requestIdMiddleware,           // Add request ID
  pinoHttpLogger,                // Log request
  helmetSecurityHeaders,         // Security headers
  correlationIdMiddleware,        // Trace correlation
  corsMiddleware,                // CORS enforcement
  bodySizeLimitMiddleware,        // Size limits
  sentryRequestHandler,          // Error tracking
  rateLimiter,                   // 40 req/hour for sensitive ops
  auditMiddleware,               // Log mutation
  authenticateToken,             // ⭐ Verify JWT (sets req.user)
  tenantMiddleware,              // ⭐ Extract tenant (sets req.tenantId)
  requireKycForFunding,          // ⭐ KYC gate (smeId from JWT only)
  fundingHandler                 // Business logic
);
```

> **Security note**: `smeId` for KYC lookup is resolved exclusively from
> `req.user.smeId` (the verified JWT claim). Callers cannot supply a spoofed
> `smeId` via `req.body` or `req.params` to pass the gate for an SME they do
> not own.

### Key Handling

**For external KYC provider integration**:

1. **Never commit secrets**:
   ```bash
   # ❌ WRONG
   KYC_PROVIDER_API_KEY=sk_live_abc123  # in .env file checked in

   # ✅ CORRECT
   # Set via deployment secrets only
   export KYC_PROVIDER_API_KEY=...  # CI/CD pipeline secret
   ```

2. **Secure storage**:
   - Use environment variables (not hardcoded)
   - Use secret management service (AWS Secrets Manager, HashiCorp Vault)
   - Rotate keys regularly

3. **Logging & Monitoring**:
   - **Sentry scrubbing** removes sensitive patterns:
     - Authorization headers
     - KYC API keys
     - Bearer tokens
     - XDR (Stellar transaction data)

**Sentry Configuration**:
```javascript
// src/observability/sentry.js automatically redacts:
const SENSITIVE_PATTERNS = [
  /authorization/i,
  /token/i,
  /password/i,
  /secret/i,
  /key/i,
  /apikey/i,
  /xdr/i
];
```

### Audit Trail

All KYC status updates are logged:

```javascript
logger.info(
  { 
    smeId: 'sme_001',
    previousStatus: 'pending',
    newStatus: 'verified',
    recordId: 'kyc_sme_001_001',
    updatedAt: '2026-04-25T10:30:00Z'
  },
  'Invoice KYC status updated'
);
```

---

## Testing

### Unit Tests

**File**: `tests/kyc.gating.test.js`

**Coverage**: 95%+ line coverage on KYC code

Run tests:
```bash
npm test -- tests/kyc.gating.test.js
```

**Test Suite**:
- ✅ KYC Service: 30+ test cases
  - Status retrieval, verification, rejection, exemption
  - Provider configuration
- ✅ KYC Middleware: 20+ test cases
  - Gate enforcement, error handling
  - Verified vs rejected vs pending scenarios
- ✅ Invoice Service: 15+ test cases
  - KYC status tracking, filtering
- ✅ Invest Routes: 15+ test cases
  - Funding endpoint protection
- ✅ Schema Validation: 10+ test cases

**Example Test**:
```javascript
it('should reject when KYC is pending', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { sub: 'investor_123', smeId: 'sme_pending' };
    req.id = 'req_123';
    next();
  });

  app.post('/fund', requireKycForFunding, (req, res) => {
    res.json({ success: true });
  });

  const res = await request(app)
    .post('/fund')
    .send({ smeId: 'sme_pending' });

  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('KYC_GATE_FAILED');
});
```

### Integration Testing

Verify end-to-end with real Express app:

```bash
# Run all tests
npm test

# Run KYC tests only
npm test -- kyc.gating

# Watch mode during development
npm test -- kyc.gating --watch
```

### Audit Log Append-Only Triggers (Postgres)

The `audit_log_events` table is enforced as append-only at the database layer via triggers (UPDATE/DELETE raise `audit_log_events is append-only`).

- Integration test: `tests/integration/auditAppendOnly.test.js`
- This test runs only when a Postgres target is available (e.g. `docker-compose.dev.yml` Postgres). It skips gracefully when only SQLite is available (SQLite does not support these triggers).

### Manual Testing

Using cURL or Postman:

```bash
# 1. Get JWT token (from your auth endpoint)
export TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# 2. Verify SME (admin/testing endpoint - optional)
curl -X POST http://localhost:3001/api/admin/kyc/verify \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"smeId": "sme_test_001"}'

# 3. Try funding
curl -X POST http://localhost:3001/api/invest/fund-invoice \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "inv_test",
    "investmentAmount": 1000,
    "smeId": "sme_test_001"
  }'
```

---

## Roadmap & Future Work

### Phase 1: Complete ✅
- ✅ Invoice schema with kycStatus field
- ✅ KYC service with mock implementation
- ✅ KYC gating middleware
- ✅ Funding endpoint protection (`POST /api/invest/fund-invoice`)
- ✅ **KYC gate on ALL capital-movement endpoints** (issue #222)
  - ✅ `POST /api/invoices/:id/link-escrow`
  - ✅ `POST /api/invoices/:id/transition` (capital-moving states)
- ✅ **Anti-spoofing: smeId resolved from JWT only** (issue #222)
- ✅ Comprehensive testing (95%+ coverage)
- ✅ Documentation

### Phase 2: External Provider Integration
- [ ] Implement real KYC provider HTTP calls
- [ ] Add provider-specific adapters (IDology, Onfido, Jumio)
- [ ] Webhook support for async KYC results
- [ ] Compliance report generation

### Phase 3: Advanced Features
- [ ] KYC refresh/re-verification intervals
- [ ] Risk scoring integration
- [ ] AML (Anti-Money Laundering) checks
- [ ] Sanctions list integration
- [ ] Document verification (ID, proof of address)
- [ ] Face matching/liveness detection

### Phase 4: Operational
- [ ] Admin dashboard for KYC review
- [ ] Bulk KYC status updates
- [ ] KYC status audit reports
- [ ] SLA monitoring and alerts
- [ ] Provider failover/backup

---

## Legal-Hold Compliance Gate — Fail-Closed Policy (issue #424)

**Status**: Production-ready.  
**Date**: June 2026.  
**Relates to**: Issue #424 — Treat an unknown legal-hold read result as fail-closed instead of defaulting to false.

### Why fail-closed

The legal-hold flag is a compliance gate. A held escrow MUST NOT receive
funding. Prior to issue #424, `src/services/escrowRead.js#fetchLegalHold`
collapsed any read failure (RPC outage, timeout, circuit-breaker open)
into `false`, downstream `/api/escrow/:invoiceId/fund` then proceeded as
if "not held". That is a silent compliance bypass: every transient Soroban
outage is a window during which a held invoice could be funded.

### Tri-state outcome

`fetchLegalHoldStatus(invoiceId, adapter)` returns a tri-state envelope:

| Status     | Meaning                                            | Funding gate response         |
|------------|----------------------------------------------------|-------------------------------|
| `held`     | On-chain flag is truthy.                           | `423 Locked` RFC 7807         |
| `not_held` | On-chain flag is falsy.                            | `next()` — funding permitted   |
| `unknown`  | RPC error / circuit open / timeout / adapter throw | `503 Service Unavailable`     |

The `unknown` case additionally:

1. Increments the dedicated counter `legal_hold_unknown_blocks_total{reason}`.
2. Emits a structured `logger.warn({event: 'legal_hold_status_unavailable',
   component, invoiceId, reason, errorCode}, ...)`.
3. Returns a problem+json response of type
   `https://liquifact.com/probs/legal-hold-status-unavailable`.

### Read-side fail-closed

For backwards compatibility, `state.legal_hold` (boolean) reflects
**both** `held` and `unknown` as `true`. This means any legacy caller of
`/api/escrow/:invoiceId` that branches on `if (state.legal_hold === false)`
is also fail-closed: a read that produced `unknown` will not be flagged as
"safe to fund". The full tri-state is available as `state.legalHoldStatus`,
`state.legalHoldReason`, and `state.legalHoldErrorCode` for operators and
dashboards that need to distinguish a verified hold from an outage.

### Operational runbook

- **Alert on `rate(legal_hold_unknown_blocks_total[5m]) > 0`** — every
  occurrence is a Soroban read outage impacting funding paths.
- **Group by `reason`** — `rpc_error` is from upstream, `adapter_error`
  is from a misbehaving caller-supplied adapter, `service_unavailable`
  is from the gate missing a usable service factory.
- **Reconciliation** — the existing reconcile job will surface stuck
  funding requests whose hold status moved from `unknown → held` once
  the upstream service recovers.
- **Per-invoiceId triage** — the `legalHoldUnknownBlocksTotal` counter
  intentionally does NOT carry an `invoiceId` label to keep Prometheus
  series cardinality bounded. Per-invoice triage is performed via the
  structured warn log (event=`legal_hold_status_unavailable`) or by
  inspecting `state.legalHoldErrorCode` on individual escrow-read
  responses.
- **Held blocks** — `legal_hold_blocks_total{outcome="held"}` is the
  separate counter for verified holds. Operators querying "how many
  funding requests did we block today" should sum both counters and
  group by `outcome`.
- **No manual override** — operators do NOT have a "skip gate" knob. The
  only safe remediation is to wait for the upstream service and retry.

### Tests

`tests/escrow.legalhold.test.js` covers:

- `fetchLegalHoldStatus`: all four outcomes (truthy, falsy, RPC error,
  generic throw), plus the canonical `LEGAL_HOLD_STATUS` constant.
- `fetchLegalHold` (legacy boolean projection): `true → true`, `false →
  false`, `unknown → false` (explicit fail-closed documentation in the
  test).
- `readEscrowState` (fail-closed at the data layer): `legal_hold === true`
  on both `held` and `unknown`; `legalHoldStatus`, `legalHoldReason`,
  `legalHoldErrorCode` populated on the unknown case.
- `legalHoldGate()`: 423 on `held`, 200 on `not_held`, 503 RFC 7807 on
  `unknown`, metric increment, structured warn log, 400 on missing
  invoiceId, 400 on empty invoiceId, falling closed when an adapter
  throws, boolean-adapter coercion.

Run:

```bash
npm test -- tests/escrow.legalhold.test.js
```

---

## Support & Troubleshooting

### Common Issues

**1. "KYC_GATE_FAILED" on valid KYC**

Check the KYC status:
```javascript
const status = await kycService.getKycStatus(smeId);
console.log(status); // Should be { status: 'verified', recordId: '...', verifiedAt: '...' }
```

**2. External provider not working**

Verify environment variables:
```bash
# Check if set
echo $KYC_PROVIDER_URL
echo $KYC_PROVIDER_API_KEY

# Should output your provider details, not empty
```

**3. Tests failing**

Clear mock state and restart:
```bash
npm test -- kyc.gating --clearCache
```

---

## References

- **RFC 7807**: Problem Details for HTTP APIs (error format)
- **Stellar**: On-chain escrow integration
- **Soroban**: Smart contract platform for KYC automation
- **GDPR**: Data protection compliance for KYC records
- **FinCEN**: KYC regulatory requirements

---

## Deployment Checklist

Before production deployment:

- [ ] Set `KYC_PROVIDER_URL` and `KYC_PROVIDER_API_KEY` in secrets management
- [ ] Run migration: `npm run db:migrate`
- [ ] Run tests: `npm test -- kyc.gating`
- [ ] Verify Sentry is configured (check scrubbing rules)
- [ ] Enable rate limiting on funding endpoints
- [ ] Set up monitoring/alerts for KYC failures
- [ ] Document KYC provider SLA
- [ ] Train support team on KYC status management
- [ ] Prepare rollback plan (revert migration if needed)

---

**Last Updated**: May 28, 2026  
**Maintained By**: LiquiFact Backend Team  
**Related Issues**: #222 — Enforce KYC gating on all capital-movement endpoints

---

## Audit-Trail Per-Invoice Authorization (Issue #426)

### Problem

The audit-trail endpoint previously scoped queries only by `req.tenantId`. A tenant member could iterate `invoiceId` values and read audit logs for invoices they had no relationship to within the same tenant.

### Authorization rule

Before streaming audit events, the endpoint enforces three conditions via `assertInvoiceEntitlement`:

1. **Invoice exists** — the invoice must be present and not soft-deleted.
2. **Tenant ownership** — the invoice's `tenant_id` must match the caller's `req.tenantId`.
3. **Role check** — the caller's JWT `role` claim must be `admin` or `owner`. Any other role (e.g. `investor`, `viewer`, absent) is denied.

**All failure cases return `404 Not Found`** — not `403 Forbidden`. This prevents existence leakage: a caller cannot distinguish "invoice doesn't exist" from "invoice belongs to another tenant" from "insufficient role".

### Middleware stack

```
GET /api/audit-trail/:invoiceId
  → authenticateToken   (401 if missing/invalid JWT)
  → extractTenant       (400 if no tenant context)
  → assertInvoiceEntitlement  (404 for any entitlement failure)
  → stream audit events
```

### Security properties

- **Enumeration resistance**: foreign invoices and nonexistent invoices return the same `404` response with no distinguishing body fields.
- **No tenant leakage**: the response body never includes the `tenant_id` of the requested invoice.
- **Role minimum**: only `admin` and `owner` may read audit trails. The role check is performed before the DB query so an unpermitted role never triggers a lookup.

### Test coverage

File: `tests/auditTrail.api.test.js`

| Scenario | Expected |
|---|---|
| admin role, own tenant invoice | 200 with events |
| owner role, own tenant invoice | 200 with events |
| investor role | 404 |
| no role claim in JWT | 404 |
| invoice from different tenant | 404 |
| nonexistent invoice | 404 |
| foreign vs nonexistent indistinguishable | both 404, same body shape |
| no Authorization header | 401 |
| tampered token | 401 |
| no tenant context | 400 |

**Last Updated**: June 2026
**Relates to**: Issue #426 — Enforce per-invoice authorization on the audit-trail endpoint
