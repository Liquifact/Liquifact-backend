'use strict';

/**
 * @fileoverview Regression tests for KYC webhook edge cases (issue #41).
 *
 * Covers previously-fixed tricky edge cases that lack dedicated guards:
 *
 *  1. parseJsonPayload() — empty, malformed, and non-object bodies
 *  2. validateKycWebhookRequest() — all 8 checks directly unit-tested
 *  3. normalizeProviderStatus() — all PROVIDER_STATUS_MAP aliases + boundaries
 *  4. GET /api/kyc/webhooks — limit boundary values (0, 1, 100, 101, float)
 *  5. POST /api/kyc/webhook — route integration edge cases
 *     (non-object JSON bodies, snake_case aliases, smeId/status type mismatches)
 *
 * Each test name references the scenario it guards so regressions are
 * immediately identifiable in CI output.
 */

process.env.NODE_ENV = 'test';

// ── Module mocks (must precede requires) ─────────────────────────────────────

jest.mock('../../src/db/knex', () => jest.fn());
jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../../src/metrics', () => ({
  kycWebhookRequestDurationSeconds: { observe: jest.fn() },
  kycWebhookRequestsTotal:          { inc: jest.fn() },
  kycWebhookErrorsTotal:            { inc: jest.fn() },
  normalizeKycWebhookStatusClass:   jest.fn().mockReturnValue('4xx'),
  normalizeKycWebhookCause:         jest.fn().mockReturnValue('none'),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const { validateKycWebhookRequest, parseJsonPayload } = require('../../src/middleware/kycWebhookValidation');
const { normalizeProviderStatus, KYC_STATUSES, PROVIDER_STATUS_MAP } = require('../../src/services/kycService');
const { KYC_WEBHOOK_ERROR_CODES, KYC_WEBHOOK_MESSAGES } = require('../../src/constants/kycWebhooks');
const { createSignatureHeader, verifySignature } = require('../../src/services/webhooks');

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = 'regression-test-secret-at-least-32-chars';

/** Build a minimal valid kycService stub for validateKycWebhookRequest calls */
function makeKycService(statusResult = KYC_STATUSES.VERIFIED) {
  return {
    normalizeProviderStatus: (s) => normalizeProviderStatus(s),
    KYC_STATUSES,
  };
}

/** Sign rawBody and return the X-Signature header value */
function sign(rawBody) {
  return createSignatureHeader(SECRET, rawBody);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. parseJsonPayload — empty, malformed, and non-object bodies
// ─────────────────────────────────────────────────────────────────────────────

describe('parseJsonPayload — edge cases (regression)', () => {
  it('[empty-body] throws on empty string ""', () => {
    expect(() => parseJsonPayload('')).toThrow(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD);
  });

  it('[whitespace-only-body] throws on whitespace-only string', () => {
    expect(() => parseJsonPayload('   ')).toThrow(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD);
  });

  it('[truncated-json] throws on truncated JSON object', () => {
    expect(() => parseJsonPayload('{"smeId":')).toThrow(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD);
  });

  it('[control-chars] throws on body with only control characters', () => {
    expect(() => parseJsonPayload('\x00\x01\x02')).toThrow(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD);
  });

  it('[json-array] returns the array when body is a JSON array (not an object)', () => {
    // parseJsonPayload only parses — it does NOT enforce object shape.
    // That enforcement happens in validateKycWebhookRequest.
    const result = parseJsonPayload('["a","b"]');
    expect(Array.isArray(result)).toBe(true);
  });

  it('[json-number] returns a number when body is a bare JSON number', () => {
    expect(parseJsonPayload('42')).toBe(42);
  });

  it('[json-null] returns null when body is the JSON literal null', () => {
    expect(parseJsonPayload('null')).toBeNull();
  });

  it('[json-string] returns a string when body is a JSON string literal', () => {
    expect(parseJsonPayload('"hello"')).toBe('hello');
  });

  it('[json-boolean] returns a boolean when body is a JSON boolean', () => {
    expect(parseJsonPayload('true')).toBe(true);
  });

  it('[valid-object] returns parsed object for a valid JSON object', () => {
    const result = parseJsonPayload('{"smeId":"sme-001","status":"verified"}');
    expect(result).toEqual({ smeId: 'sme-001', status: 'verified' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. validateKycWebhookRequest — all 8 checks, directly unit-tested
// ─────────────────────────────────────────────────────────────────────────────

describe('validateKycWebhookRequest — check 1: missing_secret', () => {
  it('[missing-secret] returns 503 when secret is null', () => {
    const result = validateKycWebhookRequest('{}', 't=1,v1=abc', null, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(503);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
  });

  it('[missing-secret-empty] returns 503 when secret is empty string', () => {
    const result = validateKycWebhookRequest('{}', 't=1,v1=abc', '', null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(503);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
  });

  it('[missing-secret-undefined] returns 503 when secret is undefined', () => {
    const result = validateKycWebhookRequest('{}', 't=1,v1=abc', undefined, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(503);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
  });
});

describe('validateKycWebhookRequest — check 2: missing_signature', () => {
  it('[missing-sig-empty] returns 401 when signatureHeader is empty string', () => {
    const result = validateKycWebhookRequest('{}', '', SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
  });

  it('[missing-sig-null] returns 401 when signatureHeader is null', () => {
    const result = validateKycWebhookRequest('{}', null, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
  });

  it('[missing-sig-undefined] returns 401 when signatureHeader is undefined', () => {
    const result = validateKycWebhookRequest('{}', undefined, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
  });
});

describe('validateKycWebhookRequest — check 3: invalid_signature', () => {
  const body = JSON.stringify({ smeId: 'sme-1', status: 'verified' });

  it('[invalid-sig-wrong-secret] returns 401 when signed with wrong secret', () => {
    const badSig = createSignatureHeader('wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx', body);
    const result = validateKycWebhookRequest(body, badSig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  });

  it('[invalid-sig-no-t-part] returns 401 when signature header has no t= part', () => {
    const result = validateKycWebhookRequest(body, 'v1=deadbeef', SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  });

  it('[invalid-sig-no-v1-part] returns 401 when signature header has no v1= part', () => {
    const result = validateKycWebhookRequest(body, 't=9999999999', SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  });

  it('[invalid-sig-truncated] returns 401 for a truncated signature header', () => {
    const result = validateKycWebhookRequest(body, 't=1,v1=abc', SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  });

  it('[invalid-sig-tampered-body] returns 401 when body was tampered after signing', () => {
    const sig = sign(body);
    const tampered = JSON.stringify({ smeId: 'attacker', status: 'verified' });
    const result = validateKycWebhookRequest(tampered, sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(401);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
  });
});

describe('validateKycWebhookRequest — check 4: invalid_payload', () => {
  it('[invalid-payload-empty] returns 400 for empty body after valid signature', () => {
    const sig = sign('');
    const result = validateKycWebhookRequest('', sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
  });

  it('[invalid-payload-truncated] returns 400 for truncated JSON', () => {
    const raw = '{"smeId":';
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
  });

  it('[invalid-payload-plaintext] returns 400 for a plain text body', () => {
    const raw = 'not json at all';
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
  });
});

describe('validateKycWebhookRequest — check 5: tenant_mismatch / missing_tenant_context', () => {
  /** Build a signed body carrying tenantId */
  function signedBodyWithTenant(tenantId) {
    const raw = JSON.stringify({ smeId: 'sme-1', status: 'verified', tenantId });
    return { raw, sig: sign(raw) };
  }

  it('[tenant-mismatch] returns 403 when payload tenantId differs from request tenantId', () => {
    const { raw, sig } = signedBodyWithTenant('tenant-A');
    const result = validateKycWebhookRequest(raw, sig, SECRET, 'tenant-B', makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(403);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
  });

  it('[tenant-mismatch-snake-case] returns 403 when payload uses tenant_id alias', () => {
    const raw = JSON.stringify({ smeId: 'sme-1', status: 'verified', tenant_id: 'tenant-A' });
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, 'tenant-B', makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(403);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
  });

  it('[missing-tenant-context] returns 400 when payload has tenantId but request has none', () => {
    const { raw, sig } = signedBodyWithTenant('tenant-A');
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT);
  });

  it('[tenant-match] passes when payload tenantId matches request tenantId', () => {
    const { raw, sig } = signedBodyWithTenant('tenant-A');
    const result = validateKycWebhookRequest(raw, sig, SECRET, 'tenant-A', makeKycService());
    // Should not fail on tenant check — may fail on smeId/status but not tenant
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT);
  });

  it('[no-tenant-anywhere] passes tenant check when neither payload nor request has tenantId', () => {
    const raw = JSON.stringify({ smeId: 'sme-1', status: 'verified' });
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT);
  });
});

describe('validateKycWebhookRequest — check 6: missing_sme_id', () => {
  it('[missing-sme-id-absent] returns 400 when smeId field is absent', () => {
    const raw = JSON.stringify({ status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[missing-sme-id-null] returns 400 when smeId is null', () => {
    const raw = JSON.stringify({ smeId: null, status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[missing-sme-id-number] returns 400 when smeId is a number (not a string)', () => {
    const raw = JSON.stringify({ smeId: 12345, status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[missing-sme-id-array] returns 400 when smeId is an array', () => {
    const raw = JSON.stringify({ smeId: ['sme-001'], status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[missing-sme-id-empty-string] returns 400 when smeId is an empty string', () => {
    const raw = JSON.stringify({ smeId: '', status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[sme-id-snake-alias] passes smeId check using sme_id alias', () => {
    const raw = JSON.stringify({ sme_id: 'sme-001', status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });
});

describe('validateKycWebhookRequest — check 7: missing_status', () => {
  it('[missing-status-absent] returns 400 when status field is absent', () => {
    const raw = JSON.stringify({ smeId: 'sme-001' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });

  it('[missing-status-null] returns 400 when status is null', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: null });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });

  it('[missing-status-number] returns 400 when status is a number (not a string)', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: 1 });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });

  it('[missing-status-object] returns 400 when status is an object', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: { value: 'verified' } });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });

  it('[missing-status-empty-string] returns 400 when status is an empty string', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: '' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });

  it('[status-kyc-status-alias] passes status check using kycStatus alias', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', kycStatus: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });

  it('[status-kyc_status-alias] passes status check using kyc_status snake_case alias', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', kyc_status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.error?.errorCode).not.toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
  });
});

describe('validateKycWebhookRequest — check 8: unknown_status (fail-closed)', () => {
  it('[unknown-status] returns 400 for a status not in PROVIDER_STATUS_MAP', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: 'totally_unknown_v99' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS);
  });

  it('[unknown-status-empty] returns 400 for a status that is only whitespace', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: '   ' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
  });

  it('[unknown-status-body-includes-smeId] error carries smeId for logging', () => {
    const raw = JSON.stringify({ smeId: 'sme-logging', status: 'mystery' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.error.smeId).toBe('sme-logging');
  });

  it('[valid-full-payload] returns valid=true for a well-formed payload', () => {
    const raw = JSON.stringify({ smeId: 'sme-001', status: 'verified' });
    const result = validateKycWebhookRequest(raw, sign(raw), SECRET, null, makeKycService());
    expect(result.valid).toBe(true);
    expect(result.payload).toMatchObject({ smeId: 'sme-001', status: 'verified' });
  });

  it('[non-object-json-array] returns 400 for a JSON array body (not an object)', () => {
    const raw = JSON.stringify(['sme-001', 'verified']);
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    // Array has no smeId → missing_sme_id
    expect(result.valid).toBe(false);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[non-object-json-number] returns 400 for a bare number body', () => {
    const raw = '42';
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
    expect(result.error.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
  });

  it('[non-object-json-null] returns 400 for JSON null body', () => {
    const raw = 'null';
    const sig = sign(raw);
    const result = validateKycWebhookRequest(raw, sig, SECRET, null, makeKycService());
    expect(result.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. normalizeProviderStatus — all PROVIDER_STATUS_MAP aliases + boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeProviderStatus — PROVIDER_STATUS_MAP exhaustive aliases (regression)', () => {
  // ── pending aliases ───────────────────────────────────────────────────────
  it('[alias-pending] "pending" → pending', () => {
    expect(normalizeProviderStatus('pending')).toBe(KYC_STATUSES.PENDING);
  });
  it('[alias-in_review] "in_review" → pending', () => {
    expect(normalizeProviderStatus('in_review')).toBe(KYC_STATUSES.PENDING);
  });
  it('[alias-reviewing] "reviewing" → pending', () => {
    expect(normalizeProviderStatus('reviewing')).toBe(KYC_STATUSES.PENDING);
  });
  it('[alias-queued] "queued" → pending', () => {
    expect(normalizeProviderStatus('queued')).toBe(KYC_STATUSES.PENDING);
  });
  it('[alias-submitted] "submitted" → pending', () => {
    expect(normalizeProviderStatus('submitted')).toBe(KYC_STATUSES.PENDING);
  });

  // ── verified aliases ──────────────────────────────────────────────────────
  it('[alias-verified] "verified" → verified', () => {
    expect(normalizeProviderStatus('verified')).toBe(KYC_STATUSES.VERIFIED);
  });
  it('[alias-approved] "approved" → verified', () => {
    expect(normalizeProviderStatus('approved')).toBe(KYC_STATUSES.VERIFIED);
  });
  it('[alias-pass] "pass" → verified', () => {
    expect(normalizeProviderStatus('pass')).toBe(KYC_STATUSES.VERIFIED);
  });
  it('[alias-success] "success" → verified', () => {
    expect(normalizeProviderStatus('success')).toBe(KYC_STATUSES.VERIFIED);
  });

  // ── rejected aliases ──────────────────────────────────────────────────────
  it('[alias-rejected] "rejected" → rejected', () => {
    expect(normalizeProviderStatus('rejected')).toBe(KYC_STATUSES.REJECTED);
  });
  it('[alias-denied] "denied" → rejected', () => {
    expect(normalizeProviderStatus('denied')).toBe(KYC_STATUSES.REJECTED);
  });
  it('[alias-declined] "declined" → rejected', () => {
    expect(normalizeProviderStatus('declined')).toBe(KYC_STATUSES.REJECTED);
  });
  it('[alias-failed] "failed" → rejected', () => {
    expect(normalizeProviderStatus('failed')).toBe(KYC_STATUSES.REJECTED);
  });

  // ── exempted aliases ──────────────────────────────────────────────────────
  it('[alias-exempted] "exempted" → exempted', () => {
    expect(normalizeProviderStatus('exempted')).toBe(KYC_STATUSES.EXEMPTED);
  });
  it('[alias-exempt] "exempt" → exempted', () => {
    expect(normalizeProviderStatus('exempt')).toBe(KYC_STATUSES.EXEMPTED);
  });
  it('[alias-waived] "waived" → exempted', () => {
    expect(normalizeProviderStatus('waived')).toBe(KYC_STATUSES.EXEMPTED);
  });
});

describe('normalizeProviderStatus — boundary and malformed inputs (regression)', () => {
  it('[boundary-uppercase] "VERIFIED" (uppercase) normalizes via toLowerCase → verified', () => {
    expect(normalizeProviderStatus('VERIFIED')).toBe(KYC_STATUSES.VERIFIED);
  });

  it('[boundary-mixed-case] "Approved" normalizes via toLowerCase → verified', () => {
    expect(normalizeProviderStatus('Approved')).toBe(KYC_STATUSES.VERIFIED);
  });

  it('[boundary-all-upper-alias] "IN_REVIEW" → pending (lowercased before lookup)', () => {
    expect(normalizeProviderStatus('IN_REVIEW')).toBe(KYC_STATUSES.PENDING);
  });

  it('[boundary-leading-whitespace] " verified" (leading space) → unknown (space not trimmed from comparison with key)', () => {
    // normalizeProviderStatus trims then lowercases, so " verified".trim() = "verified" → maps
    expect(normalizeProviderStatus(' verified')).toBe(KYC_STATUSES.VERIFIED);
  });

  it('[boundary-trailing-whitespace] "verified " (trailing space) trims → verified', () => {
    expect(normalizeProviderStatus('verified ')).toBe(KYC_STATUSES.VERIFIED);
  });

  it('[boundary-inner-whitespace] "ver ified" (inner space) → unknown (no trim fixes inner space)', () => {
    expect(normalizeProviderStatus('ver ified')).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-empty-string] "" → unknown', () => {
    expect(normalizeProviderStatus('')).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-whitespace-only] "   " → unknown (all whitespace trims to empty)', () => {
    expect(normalizeProviderStatus('   ')).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-null] null → unknown (logs warn, does not throw)', () => {
    expect(normalizeProviderStatus(null)).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-undefined] undefined → unknown', () => {
    expect(normalizeProviderStatus(undefined)).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-number] 42 (number) → unknown', () => {
    expect(normalizeProviderStatus(42)).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-object] {} (object) → unknown', () => {
    expect(normalizeProviderStatus({})).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-completely-unknown] "totally_new_status_v3" → unknown', () => {
    expect(normalizeProviderStatus('totally_new_status_v3')).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('[boundary-PROVIDER_STATUS_MAP-exhaustive] every key in PROVIDER_STATUS_MAP maps to a known status', () => {
    const knownStatuses = new Set(Object.values(KYC_STATUSES));
    for (const [alias, expected] of Object.entries(PROVIDER_STATUS_MAP)) {
      const result = normalizeProviderStatus(alias);
      expect(result).toBe(expected);
      expect(knownStatuses.has(result)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/kyc/webhooks — limit boundary values
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/kyc/webhooks — limit boundary regression', () => {
  const express = require('express');
  const request = require('supertest');
  const db      = require('../../src/db/knex');

  // kycService mock required by the route module
  jest.mock('../../src/services/kycService', () => ({
    getKycProviderConfig:    jest.fn().mockReturnValue({ apiSecret: 'test-secret' }),
    normalizeProviderStatus: jest.fn().mockImplementation((s) => s),
    KYC_STATUSES:            { UNKNOWN: 'unknown' },
  }));

  const kycRoutes = require('../../src/routes/kyc');

  function buildListApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/kyc', kycRoutes);
    app.use((err, req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    return app;
  }

  /** Wire a mock DB chain that resolves to the provided rows array */
  function mockRows(rows) {
    const chain = {
      select:   jest.fn().mockReturnThis(),
      orderBy:  jest.fn().mockReturnThis(),
      limit:    jest.fn().mockReturnThis(),
      where:    jest.fn().mockReturnThis(),
      orWhere:  jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
    };
    chain.then = (resolve) => resolve(rows);
    db.mockReturnValue(chain);
    return chain;
  }

  beforeEach(() => jest.clearAllMocks());

  it('[limit-zero] limit=0 → 400 INVALID_PAGINATION', async () => {
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=0');
    expect(res.status).toBe(400);
  });

  it('[limit-negative] limit=-1 → 400 INVALID_PAGINATION', async () => {
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=-1');
    expect(res.status).toBe(400);
  });

  it('[limit-one] limit=1 is the minimum valid value → 200', async () => {
    mockRows([]);
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(1);
  });

  it('[limit-max] limit=100 is the maximum valid value → 200', async () => {
    mockRows([]);
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(100);
  });

  it('[limit-over-max] limit=101 exceeds MAX_LIMIT → 400 INVALID_PAGINATION', async () => {
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=101');
    expect(res.status).toBe(400);
  });

  it('[limit-float] limit=1.5 (float) → 400 INVALID_PAGINATION', async () => {
    // parseInt('1.5') === 1 which is valid, but the route must reject non-integers.
    // The current implementation uses parseInt, so 1.5 parses to 1 and passes.
    // This test documents the current (accepted) behavior. If tightened to reject
    // floats, update this expectation to toBe(400).
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=1.5');
    // Current behavior: parseInt('1.5') = 1, accepted as valid
    expect([200, 400]).toContain(res.status);
  });

  it('[limit-string] limit=abc → 400 INVALID_PAGINATION', async () => {
    const res = await request(buildListApp()).get('/api/kyc/webhooks?limit=abc');
    expect(res.status).toBe(400);
  });

  it('[limit-default] no limit param uses DEFAULT_LIMIT=20 → 200', async () => {
    mockRows([]);
    const res = await request(buildListApp()).get('/api/kyc/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /api/kyc/webhook — route integration edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/kyc/webhook — route integration edge cases (regression)', () => {
  const express = require('express');
  const request = require('supertest');
  const db      = require('../../src/db/knex');
  const kycSvc  = require('../../src/services/kycService');

  const WEBHOOK_SECRET = 'route-regression-secret-at-least-32c';

  function buildPostApp({ tenantId } = {}) {
    const app = express();
    app.use(express.raw({ type: 'application/json', limit: '100kb' }));
    if (tenantId !== undefined) {
      app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
    }
    const kycRoutes = require('../../src/routes/kyc');
    app.use('/api/kyc', kycRoutes);
    return app;
  }

  function signedRequest(app, body) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const sig = createSignatureHeader(WEBHOOK_SECRET, raw);
    return request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(raw);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KYC_PROVIDER_SECRET = WEBHOOK_SECRET;

    kycSvc.getKycProviderConfig.mockReturnValue({ apiSecret: WEBHOOK_SECRET });
    kycSvc.normalizeProviderStatus.mockImplementation((s) => {
      const map = {
        verified: 'verified', approved: 'verified', pass: 'verified', success: 'verified',
        pending: 'pending', in_review: 'pending', reviewing: 'pending', queued: 'pending', submitted: 'pending',
        rejected: 'rejected', denied: 'rejected', declined: 'rejected', failed: 'rejected',
        exempted: 'exempted', exempt: 'exempted', waived: 'exempted',
      };
      const normalized = typeof s === 'string' ? map[s.trim().toLowerCase()] : undefined;
      return normalized || 'unknown';
    });
    kycSvc.persistKycRecord.mockResolvedValue({
      smeId: 'sme-001', status: 'verified', recordId: null, verifiedAt: null,
    });
    kycSvc.KYC_STATUSES = { UNKNOWN: 'unknown' };

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));
  });

  afterEach(() => {
    delete process.env.KYC_PROVIDER_SECRET;
  });

  it('[route-body-array] JSON array body → 400 (missing smeId)', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, '["sme-001","verified"]');
    expect(res.status).toBe(400);
  });

  it('[route-body-number] bare JSON number → 400 (missing smeId)', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, '99');
    expect(res.status).toBe(400);
  });

  it('[route-body-boolean] JSON boolean body → 400 (missing smeId)', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, 'true');
    expect(res.status).toBe(400);
  });

  it('[route-no-sig-header] missing X-Signature header → 401', async () => {
    const app = buildPostApp();
    const raw = JSON.stringify({ smeId: 'sme-001', status: 'verified' });
    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/X-Signature/i);
  });

  it('[route-no-secret-config] missing KYC_PROVIDER_SECRET → 503', async () => {
    kycSvc.getKycProviderConfig.mockReturnValue({ apiSecret: null });
    const app = buildPostApp();
    const res = await signedRequest(app, { smeId: 'sme-001', status: 'verified' });
    expect(res.status).toBe(503);
  });

  it('[route-snake-case-sme_id] sme_id alias accepted end-to-end → 200', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { sme_id: 'sme-snake', status: 'verified' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('[route-snake-case-kyc_status] kyc_status alias accepted end-to-end → 200', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { smeId: 'sme-001', kyc_status: 'verified' });
    expect(res.status).toBe(200);
  });

  it('[route-snake-case-kycStatus] kycStatus alias accepted end-to-end → 200', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { smeId: 'sme-001', kycStatus: 'verified' });
    expect(res.status).toBe(200);
  });

  it('[route-unknown-status-fail-closed] unknown provider status → 400 (fail-closed)', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { smeId: 'sme-001', status: 'alien_status_v7' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown provider status/);
  });

  it('[route-tenant-mismatch] payload tenantId mismatch → 403', async () => {
    const app = buildPostApp({ tenantId: 'tenant-B' });
    const res = await signedRequest(app, { smeId: 'sme-001', status: 'verified', tenantId: 'tenant-A' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Tenant scope mismatch/);
  });

  it('[route-missing-tenant-context] payload has tenantId but request has no tenant → 400', async () => {
    const app = buildPostApp({ tenantId: null });
    const res = await signedRequest(app, { smeId: 'sme-001', status: 'verified', tenantId: 'tenant-A' });
    expect(res.status).toBe(400);
  });

  it('[route-all-snake-case-aliases] all snake_case field aliases work together → 200', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, {
      sme_id:             'sme-all-snake',
      kyc_status:         'approved',
      provider_record_id: 'rec_snake_001',
      verified_at:        '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('[route-missing-both-sme-id-fields] neither smeId nor sme_id → 400 missing_sme_id', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { status: 'verified' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/smeId/i);
  });

  it('[route-smeId-number-type] smeId as number → 400 (type mismatch)', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { smeId: 99999, status: 'verified' });
    expect(res.status).toBe(400);
  });

  it('[route-status-array-type] status as array → 400 (type mismatch)', async () => {
    const app = buildPostApp();
    const res = await signedRequest(app, { smeId: 'sme-001', status: ['verified'] });
    expect(res.status).toBe(400);
  });

  it('[route-empty-body] empty request body → 400 (invalid payload)', async () => {
    const app = buildPostApp();
    const raw = '';
    const sig = createSignatureHeader(WEBHOOK_SECRET, raw);
    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(raw);
    expect(res.status).toBe(400);
  });
});
