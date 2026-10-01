'use strict';

/**
 * @fileoverview Focused tests for KycWebhookError enrichment and deterministic behavior.
 *
 * Covers:
 *   - Backward-compatible 3-arg constructor
 *   - Optional 4th context arg (smeId, tenantId, requestId)
 *   - isRetryable() for every code/status combination
 *   - toRetryHint() returns stable strings
 *   - toLogContext() never leaks secrets; only includes known fields
 *   - instanceof checks still work after enrichment
 *   - RETRYABLE_STATUSES and RETRYABLE_CODES exports match isRetryable() behavior
 */

const KycWebhookError = require('../../src/errors/KycWebhookError');
const { RETRYABLE_STATUSES, RETRYABLE_CODES } = KycWebhookError;

// ─── Constructor & backward compatibility ────────────────────────────────────

describe('KycWebhookError – constructor', () => {
  test('three-argument form sets name, status, code, message', () => {
    const err = new KycWebhookError('Bad signature', 401, 'invalid_signature');
    expect(err).toBeInstanceOf(KycWebhookError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('KycWebhookError');
    expect(err.message).toBe('Bad signature');
    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid_signature');
  });

  test('four-argument form (context object) is backward compatible', () => {
    const err = new KycWebhookError('Tenant mismatch', 403, 'tenant_mismatch', {
      smeId: 'sme_123',
      tenantId: 'tenant_abc',
      requestId: 'req_xyz',
    });
    expect(err.status).toBe(403);
    expect(err.code).toBe('tenant_mismatch');
    // Context is private: not exposed as direct top-level properties
    expect(err.smeId).toBeUndefined();
    expect(err.tenantId).toBeUndefined();
    expect(err.requestId).toBeUndefined();
  });

  test('omitting context (undefined 4th arg) works gracefully', () => {
    const err = new KycWebhookError('Missing secret', 503, 'missing_secret', undefined);
    expect(err.status).toBe(503);
    expect(err.code).toBe('missing_secret');
    expect(() => err.toLogContext()).not.toThrow();
    expect(() => err.isRetryable()).not.toThrow();
  });

  test('passing null context works gracefully', () => {
    const err = new KycWebhookError('Missing secret', 503, 'missing_secret', null);
    expect(err.status).toBe(503);
    const ctx = err.toLogContext();
    expect(ctx.code).toBe('missing_secret');
    expect(ctx.smeId).toBeUndefined();
  });

  test('non-string context fields are silently ignored', () => {
    const err = new KycWebhookError('err', 400, 'some_code', {
      smeId: 12345,    // number — not a string
      tenantId: null,  // null — not a string
      requestId: true, // bool — not a string
    });
    const ctx = err.toLogContext();
    expect(ctx.smeId).toBeUndefined();
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.requestId).toBeUndefined();
  });

  test('partial context (only smeId) is accepted', () => {
    const err = new KycWebhookError('err', 400, 'some_code', { smeId: 'sme_1' });
    const ctx = err.toLogContext();
    expect(ctx.smeId).toBe('sme_1');
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.requestId).toBeUndefined();
  });

  test('instanceof KycWebhookError still works with enriched form', () => {
    const err = new KycWebhookError('test', 500, 'code', { smeId: 'sme_1' });
    expect(err instanceof KycWebhookError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  test('stack trace is captured', () => {
    const err = new KycWebhookError('test', 500, 'code');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('KycWebhookError');
  });
});

// ─── isRetryable() ───────────────────────────────────────────────────────────

describe('KycWebhookError – isRetryable()', () => {
  describe('retryable by error code', () => {
    test.each([...RETRYABLE_CODES])(
      'code "%s" is retryable regardless of status',
      (code) => {
        const err = new KycWebhookError('msg', 400, code);
        expect(err.isRetryable()).toBe(true);
      }
    );
  });

  describe('retryable by HTTP status', () => {
    test.each([...RETRYABLE_STATUSES])(
      'status %d is retryable regardless of code',
      (status) => {
        const err = new KycWebhookError('msg', status, 'some_non_retryable_code');
        expect(err.isRetryable()).toBe(true);
      }
    );
  });

  describe('non-retryable errors', () => {
    test.each([
      [400, 'invalid_payload'],
      [400, 'missing_sme_id'],
      [400, 'missing_status'],
      [400, 'unknown_status'],
      [400, 'INVALID_PAGINATION'],
      [401, 'missing_signature'],
      [401, 'invalid_signature'],
      [403, 'tenant_mismatch'],
      [500, 'persistence_error'],
      [500, 'INTERNAL_ERROR'],
    ])(
      'status=%d code=%s is NOT retryable',
      (status, code) => {
        const err = new KycWebhookError('msg', status, code);
        expect(err.isRetryable()).toBe(false);
      }
    );
  });

  test('isRetryable() is deterministic — same inputs always produce same output', () => {
    const err = new KycWebhookError('msg', 503, 'missing_secret');
    expect(err.isRetryable()).toBe(true);
    expect(err.isRetryable()).toBe(true);
    expect(err.isRetryable()).toBe(true);
  });

  test('isRetryable() result is consistent with RETRYABLE_CODES / RETRYABLE_STATUSES exports', () => {
    for (const code of RETRYABLE_CODES) {
      expect(new KycWebhookError('m', 400, code).isRetryable()).toBe(true);
    }
    for (const status of RETRYABLE_STATUSES) {
      expect(new KycWebhookError('m', status, 'other').isRetryable()).toBe(true);
    }
  });

  test('CIRCUIT_OPEN at 400 is retryable (code takes precedence over non-retryable status)', () => {
    const err = new KycWebhookError('circuit open', 400, 'CIRCUIT_OPEN');
    expect(err.isRetryable()).toBe(true);
  });

  test('missing_secret at 400 is retryable', () => {
    const err = new KycWebhookError('no secret', 400, 'missing_secret');
    expect(err.isRetryable()).toBe(true);
  });
});

// ─── toRetryHint() ───────────────────────────────────────────────────────────

describe('KycWebhookError – toRetryHint()', () => {
  test('missing_secret → non-empty hint containing retry guidance', () => {
    const err = new KycWebhookError('msg', 503, 'missing_secret');
    const hint = err.toRetryHint();
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.toLowerCase()).toContain('retry');
  });

  test('CIRCUIT_OPEN → non-empty retry hint', () => {
    const err = new KycWebhookError('msg', 503, 'CIRCUIT_OPEN');
    expect(err.toRetryHint().length).toBeGreaterThan(0);
  });

  test('429 RATE_LIMITED → rate-limit-specific hint', () => {
    const err = new KycWebhookError('msg', 429, 'RATE_LIMITED');
    const hint = err.toRetryHint();
    expect(hint.toLowerCase()).toContain('rate limit');
  });

  test('503 with non-retryable-code → generic retry hint', () => {
    const err = new KycWebhookError('msg', 503, 'some_code');
    const hint = err.toRetryHint();
    expect(hint.toLowerCase()).toContain('retry');
  });

  test('non-retryable 400 returns empty string', () => {
    const err = new KycWebhookError('msg', 400, 'invalid_payload');
    expect(err.toRetryHint()).toBe('');
  });

  test('401 invalid_signature returns empty string', () => {
    const err = new KycWebhookError('msg', 401, 'invalid_signature');
    expect(err.toRetryHint()).toBe('');
  });

  test('500 persistence_error returns empty string', () => {
    const err = new KycWebhookError('msg', 500, 'persistence_error');
    expect(err.toRetryHint()).toBe('');
  });

  test('toRetryHint is deterministic over multiple calls', () => {
    const err = new KycWebhookError('msg', 503, 'missing_secret');
    expect(err.toRetryHint()).toBe(err.toRetryHint());
  });

  test('toRetryHint never leaks sensitive patterns', () => {
    const sensitivePatterns = [/password/i, /secret/i, /token/i, /key=/i];
    const err = new KycWebhookError('password=supersecret token=abc', 503, 'missing_secret');
    const hint = err.toRetryHint();
    for (const p of sensitivePatterns) {
      expect(p.test(hint)).toBe(false);
    }
  });
});

// ─── toLogContext() ──────────────────────────────────────────────────────────

describe('KycWebhookError – toLogContext()', () => {
  test('always includes code and status', () => {
    const err = new KycWebhookError('msg', 401, 'invalid_signature');
    const ctx = err.toLogContext();
    expect(ctx.code).toBe('invalid_signature');
    expect(ctx.status).toBe(401);
  });

  test('includes smeId when provided', () => {
    const err = new KycWebhookError('msg', 400, 'missing_sme_id', { smeId: 'sme_42' });
    expect(err.toLogContext().smeId).toBe('sme_42');
  });

  test('includes tenantId when provided', () => {
    const err = new KycWebhookError('msg', 403, 'tenant_mismatch', { tenantId: 'tenant_xyz' });
    expect(err.toLogContext().tenantId).toBe('tenant_xyz');
  });

  test('includes requestId when provided', () => {
    const err = new KycWebhookError('msg', 500, 'persistence_error', { requestId: 'req_abc' });
    expect(err.toLogContext().requestId).toBe('req_abc');
  });

  test('keys for absent context fields are NOT present in the returned object', () => {
    const err = new KycWebhookError('msg', 400, 'code');
    const ctx = err.toLogContext();
    expect(Object.keys(ctx)).toEqual(['code', 'status']);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'smeId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'tenantId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'requestId')).toBe(false);
  });

  test('toLogContext does NOT include the raw error message', () => {
    const err = new KycWebhookError('password=supersecret', 400, 'some_code');
    const ctx = err.toLogContext();
    expect(Object.prototype.hasOwnProperty.call(ctx, 'message')).toBe(false);
  });

  test('toLogContext does NOT expose the internal stack trace', () => {
    const err = new KycWebhookError('msg', 400, 'code');
    const ctx = err.toLogContext();
    expect(Object.prototype.hasOwnProperty.call(ctx, 'stack')).toBe(false);
  });

  test('toLogContext returns a plain object copy, not the internal _context reference', () => {
    const err = new KycWebhookError('msg', 400, 'code', { smeId: 'sme_1' });
    const ctx = err.toLogContext();
    expect(ctx).not.toBe(err._context);
  });

  test('mutating the returned context object does not affect subsequent calls', () => {
    const err = new KycWebhookError('msg', 400, 'code', { smeId: 'sme_1' });
    const ctx1 = err.toLogContext();
    ctx1.smeId = 'MUTATED';
    const ctx2 = err.toLogContext();
    expect(ctx2.smeId).toBe('sme_1');
  });

  test('toLogContext is deterministic over multiple calls', () => {
    const err = new KycWebhookError('msg', 403, 'tenant_mismatch', {
      smeId: 'sme_1',
      tenantId: 't_1',
      requestId: 'req_1',
    });
    expect(err.toLogContext()).toEqual(err.toLogContext());
  });

  test('toLogContext never contains sensitive key names', () => {
    const sensitivePatterns = [
      /password/i, /secret/i, /token/i, /api[-_]?key/i, /private[-_]?key/i,
    ];
    const err = new KycWebhookError('msg', 400, 'code', {
      smeId: 'sme_1',
      tenantId: 'tenant_1',
      requestId: 'req_1',
    });
    const keyList = Object.keys(err.toLogContext()).join(' ');
    for (const pattern of sensitivePatterns) {
      expect(pattern.test(keyList)).toBe(false);
    }
  });
});

// ─── RETRYABLE_STATUSES and RETRYABLE_CODES exports ─────────────────────────

describe('KycWebhookError – exported constants', () => {
  test('RETRYABLE_STATUSES is a Set', () => {
    expect(RETRYABLE_STATUSES instanceof Set).toBe(true);
    expect(RETRYABLE_STATUSES.size).toBeGreaterThan(0);
  });

  test('RETRYABLE_CODES is a Set', () => {
    expect(RETRYABLE_CODES instanceof Set).toBe(true);
    expect(RETRYABLE_CODES.size).toBeGreaterThan(0);
  });

  test('RETRYABLE_STATUSES contains 429 and 503', () => {
    expect(RETRYABLE_STATUSES.has(429)).toBe(true);
    expect(RETRYABLE_STATUSES.has(503)).toBe(true);
  });

  test('RETRYABLE_CODES contains missing_secret and CIRCUIT_OPEN', () => {
    expect(RETRYABLE_CODES.has('missing_secret')).toBe(true);
    expect(RETRYABLE_CODES.has('CIRCUIT_OPEN')).toBe(true);
  });

  test('exported sets are the canonical source of truth (values match isRetryable contract)', () => {
    // Verify the exports are the same Sets that isRetryable() uses internally.
    // We check this indirectly: every value in RETRYABLE_CODES makes an error
    // retryable, and every value in RETRYABLE_STATUSES makes an error retryable.
    for (const code of RETRYABLE_CODES) {
      expect(new KycWebhookError('m', 400, code).isRetryable()).toBe(true);
    }
    for (const status of RETRYABLE_STATUSES) {
      expect(new KycWebhookError('m', status, 'other_code').isRetryable()).toBe(true);
    }
  });
});

// ─── Regression: error handler delegation contract ───────────────────────────

describe('KycWebhookError – error handler delegation contract', () => {
  test('error handler can delegate isRetryable() instead of duplicating logic', () => {
    const err = new KycWebhookError('missing', 503, 'missing_secret');
    // Simulate kycWebhookErrorHandler delegation
    const retryable = err.isRetryable();
    const hint = err.toRetryHint();
    expect(retryable).toBe(true);
    expect(hint.length).toBeGreaterThan(0);
  });

  test('error handler receives structured log context with no sensitive values', () => {
    const err = new KycWebhookError('Tenant mismatch.', 403, 'tenant_mismatch', {
      smeId: 'sme_99',
      tenantId: 'tenant_foo',
    });
    const logCtx = err.toLogContext();
    expect(logCtx.code).toBe('tenant_mismatch');
    expect(logCtx.status).toBe(403);
    expect(logCtx.smeId).toBe('sme_99');
    expect(logCtx.tenantId).toBe('tenant_foo');
    // These must not be present — they could leak internals
    expect(logCtx.message).toBeUndefined();
    expect(logCtx.stack).toBeUndefined();
  });

  test('non-KycWebhookError is distinguishable and must be forwarded', () => {
    const plain = new Error('database error');
    expect(plain instanceof KycWebhookError).toBe(false);
    // This is the guard kycWebhookErrorHandler uses:
    expect(plain instanceof KycWebhookError).toBe(false);
  });
});
