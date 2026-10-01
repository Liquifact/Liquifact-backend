'use strict';

/**
 * @fileoverview Focused unit tests for the deterministic failure-recovery
 * implementation in src/errors/KycWebhookError.js (issue #1374).
 *
 * Coverage:
 *  - Constructor: backward-compatible (message, status, code) signature
 *  - Owned properties: retryable and retryHint on every instance
 *  - Canonical recovery table: one test per error code
 *  - Retryable codes: missing_secret, CIRCUIT_OPEN, RATE_LIMITED
 *  - Non-retryable codes: all semantic / auth / validation failures
 *  - Fallback heuristics: unknown codes derive from HTTP status
 *  - Boundary cases: undefined code, empty message, null opts
 *  - captureStackTrace: stack does not include KycWebhookError constructor
 *  - createKycWebhookError factory: enforces code→status consistency
 *  - classifyKycWebhookError: identity / promotion / generic fallback
 *  - Regression: existing callers still receive the expected shape
 */

const KycWebhookError = require('../../src/errors/KycWebhookError');
const {
  KYC_WEBHOOK_ERROR_RECOVERY,
  KNOWN_KYC_WEBHOOK_CODES,
  createKycWebhookError,
  classifyKycWebhookError,
} = require('../../src/errors/KycWebhookError');
const { KYC_WEBHOOK_ERROR_CODES } = require('../../src/constants/kycWebhooks');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quick builder for a KycWebhookError with minimal noise */
const kwe = (msg, status, code) => new KycWebhookError(msg, status, code);

// ---------------------------------------------------------------------------
// Constructor — backward-compatible interface
// ---------------------------------------------------------------------------

describe('KycWebhookError constructor', () => {
  test('is an instance of Error and KycWebhookError', () => {
    const err = kwe('test', 400, 'invalid_payload');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KycWebhookError);
  });

  test('name is KycWebhookError', () => {
    const err = kwe('test', 400, 'invalid_payload');
    expect(err.name).toBe('KycWebhookError');
  });

  test('message is preserved exactly', () => {
    const err = kwe('Invalid webhook signature', 401, 'invalid_signature');
    expect(err.message).toBe('Invalid webhook signature');
  });

  test('status is preserved exactly', () => {
    const err = kwe('test', 403, 'tenant_mismatch');
    expect(err.status).toBe(403);
  });

  test('code is preserved exactly', () => {
    const err = kwe('test', 400, 'missing_sme_id');
    expect(err.code).toBe('missing_sme_id');
  });

  test('has a stack property', () => {
    const err = kwe('test', 400, 'invalid_payload');
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });

  test('stack does not mention KycWebhookError constructor when captureStackTrace is available', () => {
    if (typeof Error.captureStackTrace !== 'function') {
      return; // Skip on runtimes without captureStackTrace
    }
    const err = kwe('test', 400, 'invalid_payload');
    // The first frame in the stack should not be the KycWebhookError constructor
    const lines = err.stack.split('\n');
    // lines[0] = "KycWebhookError: test"
    // lines[1] = first real caller frame — must NOT be KycWebhookError constructor
    const firstFrame = lines[1] || '';
    expect(firstFrame).not.toMatch(/KycWebhookError\s*\(/);
  });

  test('empty message is accepted', () => {
    const err = kwe('', 400, 'invalid_payload');
    expect(err.message).toBe('');
  });

  test('undefined code is accepted without throwing', () => {
    expect(() => kwe('test', 500, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Owned retryable / retryHint properties
// ---------------------------------------------------------------------------

describe('KycWebhookError retryable / retryHint — owned properties', () => {
  test('every instance has own retryable property', () => {
    const err = kwe('test', 400, 'invalid_payload');
    expect(Object.prototype.hasOwnProperty.call(err, 'retryable')).toBe(true);
  });

  test('every instance has own retryHint property', () => {
    const err = kwe('test', 400, 'invalid_payload');
    expect(Object.prototype.hasOwnProperty.call(err, 'retryHint')).toBe(true);
  });

  test('retryable is a boolean', () => {
    const err = kwe('test', 503, 'missing_secret');
    expect(typeof err.retryable).toBe('boolean');
  });

  test('retryHint is a string', () => {
    const err = kwe('test', 401, 'invalid_signature');
    expect(typeof err.retryHint).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Canonical recovery table — one test per code
// ---------------------------------------------------------------------------

describe('KycWebhookError — canonical recovery table', () => {
  describe('retryable codes', () => {
    test('missing_secret → retryable true, status 503', () => {
      const err = kwe('msg', 503, KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
      expect(err.retryable).toBe(true);
      expect(err.retryHint).toBe('Retry the request in a few moments.');
    });

    test('CIRCUIT_OPEN → retryable true, status 503', () => {
      const err = kwe('msg', 503, KYC_WEBHOOK_ERROR_CODES.CIRCUIT_OPEN);
      expect(err.retryable).toBe(true);
      expect(err.retryHint).toBe('Retry the request in a few moments.');
    });

    test('RATE_LIMITED → retryable true, status 429', () => {
      const err = kwe('msg', 429, KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED);
      expect(err.retryable).toBe(true);
      expect(err.retryHint).toBe('Wait for the rate limit window to reset before retrying.');
    });
  });

  describe('non-retryable auth / signature codes', () => {
    test('missing_signature → retryable false, empty hint', () => {
      const err = kwe('msg', 401, KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('invalid_signature → retryable false, empty hint', () => {
      const err = kwe('msg', 401, KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });
  });

  describe('non-retryable tenant / authz codes', () => {
    test('tenant_mismatch → retryable false, empty hint', () => {
      const err = kwe('msg', 403, KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('missing_tenant_context → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });
  });

  describe('non-retryable validation / payload codes', () => {
    test('invalid_payload → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('invalid_event → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_EVENT);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('unknown_event_type → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.UNKNOWN_EVENT_TYPE);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('missing_sme_id → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('missing_status → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('unknown_status → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('INVALID_PAGINATION → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('INVALID_CURSOR → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('PAYLOAD_TOO_LARGE → retryable false, empty hint', () => {
      const err = kwe('msg', 413, KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });

    test('quarantined → retryable false, empty hint', () => {
      const err = kwe('msg', 400, KYC_WEBHOOK_ERROR_CODES.QUARANTINED);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });
  });

  describe('non-retryable server errors', () => {
    test('persistence_error → retryable false, empty hint', () => {
      const err = kwe('msg', 500, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
      expect(err.retryable).toBe(false);
      expect(err.retryHint).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// Fallback heuristics for unknown / future codes
// ---------------------------------------------------------------------------

describe('KycWebhookError — status-based fallback for unknown codes', () => {
  test('unknown code with status 503 → retryable true', () => {
    const err = kwe('test', 503, 'future_error_code');
    expect(err.retryable).toBe(true);
    expect(err.retryHint).toBe('Retry the request in a few moments.');
  });

  test('unknown code with status 429 → retryable true', () => {
    const err = kwe('test', 429, 'future_ratelimit_code');
    expect(err.retryable).toBe(true);
    expect(err.retryHint).toBe('Wait for the rate limit window to reset before retrying.');
  });

  test('unknown code with status 500 → retryable false', () => {
    const err = kwe('test', 500, 'future_server_error');
    expect(err.retryable).toBe(false);
    expect(err.retryHint).toBe('');
  });

  test('unknown code with status 400 → retryable false', () => {
    const err = kwe('test', 400, 'future_client_error');
    expect(err.retryable).toBe(false);
    expect(err.retryHint).toBe('');
  });

  test('undefined code with status 503 → retryable true (fallback)', () => {
    const err = kwe('test', 503, undefined);
    expect(err.retryable).toBe(true);
  });

  test('undefined code with status 400 → retryable false (fallback)', () => {
    const err = kwe('test', 400, undefined);
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Opts overrides
// ---------------------------------------------------------------------------

describe('KycWebhookError — opts overrides', () => {
  test('retryable override overrides table value', () => {
    // missing_secret is normally retryable, but can be forced to false
    const err = new KycWebhookError('msg', 503, KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET, {
      retryable: false,
    });
    expect(err.retryable).toBe(false);
  });

  test('retryHint override overrides table value', () => {
    const err = new KycWebhookError('msg', 503, KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET, {
      retryHint: 'Custom hint for ops.',
    });
    expect(err.retryHint).toBe('Custom hint for ops.');
  });

  test('partial override: only retryable, retryHint stays from table', () => {
    const err = new KycWebhookError('msg', 429, KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED, {
      retryable: false,
    });
    expect(err.retryable).toBe(false);
    expect(err.retryHint).toBe('Wait for the rate limit window to reset before retrying.');
  });
});

// ---------------------------------------------------------------------------
// createKycWebhookError factory
// ---------------------------------------------------------------------------

describe('createKycWebhookError factory', () => {
  test('returns a KycWebhookError instance', () => {
    const err = createKycWebhookError(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD, 'bad payload');
    expect(err).toBeInstanceOf(KycWebhookError);
  });

  test('uses status from recovery table', () => {
    const err = createKycWebhookError(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET, 'not configured');
    expect(err.status).toBe(503);
  });

  test('uses retryable from recovery table', () => {
    const err = createKycWebhookError(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET, 'not configured');
    expect(err.retryable).toBe(true);
  });

  test('preserves message', () => {
    const err = createKycWebhookError(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE, 'Signature mismatch');
    expect(err.message).toBe('Signature mismatch');
  });

  test('preserves code', () => {
    const err = createKycWebhookError(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH, 'Tenant scope mismatch');
    expect(err.code).toBe(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
  });

  test('throws TypeError for unknown codes', () => {
    expect(() => createKycWebhookError('NOT_A_REAL_CODE', 'msg')).toThrow(TypeError);
    expect(() => createKycWebhookError('NOT_A_REAL_CODE', 'msg')).toThrow(
      /Unknown KYC webhook error code/
    );
  });

  test('throws TypeError for undefined code', () => {
    expect(() => createKycWebhookError(undefined, 'msg')).toThrow(TypeError);
  });

  test('throws TypeError for null code', () => {
    expect(() => createKycWebhookError(null, 'msg')).toThrow(TypeError);
  });

  test('forwards opts through to constructor', () => {
    const err = createKycWebhookError(
      KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED,
      'rate limited',
      { retryHint: 'Try again in 60 seconds.' }
    );
    expect(err.retryHint).toBe('Try again in 60 seconds.');
  });

  test('all known codes can be created without throwing', () => {
    for (const code of Object.values(KYC_WEBHOOK_ERROR_CODES)) {
      expect(() => createKycWebhookError(code, 'test message')).not.toThrow();
    }
  });

  test('factory-created errors have deterministic status for every code in recovery table', () => {
    for (const [code, recovery] of Object.entries(KYC_WEBHOOK_ERROR_RECOVERY)) {
      const err = createKycWebhookError(code, 'test');
      expect(err.status).toBe(recovery.status);
      expect(err.retryable).toBe(recovery.retryable);
      expect(err.retryHint).toBe(recovery.retryHint);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyKycWebhookError classifier
// ---------------------------------------------------------------------------

describe('classifyKycWebhookError classifier', () => {
  test('returns KycWebhookError as-is', () => {
    const original = kwe('test', 401, KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
    const classified = classifyKycWebhookError(original);
    expect(classified).toBe(original);
  });

  test('promotes plain error with known code to KycWebhookError', () => {
    const plain = new Error('Signature mismatch');
    plain.code = KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE;

    const classified = classifyKycWebhookError(plain);
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.code).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);
    expect(classified.status).toBe(401);
    expect(classified.retryable).toBe(false);
  });

  test('promoted error preserves message from original', () => {
    const plain = new Error('Tenant scope mismatch.');
    plain.code = KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH;

    const classified = classifyKycWebhookError(plain);
    expect(classified.message).toBe('Tenant scope mismatch.');
  });

  test('classifies CIRCUIT_OPEN code objects as circuit error', () => {
    const plain = { code: 'CIRCUIT_OPEN', message: 'breaker open' };
    const classified = classifyKycWebhookError(plain);
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.retryable).toBe(true);
  });

  test('classifies generic Error (no code) as persistence_error 500', () => {
    const classified = classifyKycWebhookError(new Error('DB connection failed'));
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.code).toBe(KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
    expect(classified.status).toBe(500);
    expect(classified.retryable).toBe(false);
  });

  test('classifies null as persistence_error 500', () => {
    const classified = classifyKycWebhookError(null);
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.status).toBe(500);
  });

  test('classifies undefined as persistence_error 500', () => {
    const classified = classifyKycWebhookError(undefined);
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.status).toBe(500);
  });

  test('classifies string throw as persistence_error 500', () => {
    const classified = classifyKycWebhookError('boom');
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.status).toBe(500);
  });

  test('classifies object with unknown code as persistence_error 500', () => {
    const classified = classifyKycWebhookError({ code: 'UNKNOWN_INTERNAL_CODE', message: 'oops' });
    expect(classified).toBeInstanceOf(KycWebhookError);
    expect(classified.code).toBe(KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
  });
});

// ---------------------------------------------------------------------------
// KYC_WEBHOOK_ERROR_RECOVERY table completeness
// ---------------------------------------------------------------------------

describe('KYC_WEBHOOK_ERROR_RECOVERY table', () => {
  test('is exported', () => {
    expect(KYC_WEBHOOK_ERROR_RECOVERY).toBeDefined();
  });

  test('is frozen', () => {
    expect(Object.isFrozen(KYC_WEBHOOK_ERROR_RECOVERY)).toBe(true);
  });

  test('every entry has status, retryable, and retryHint', () => {
    for (const [code, entry] of Object.entries(KYC_WEBHOOK_ERROR_RECOVERY)) {
      expect(typeof entry.status).toBe('number');
      expect(typeof entry.retryable).toBe('boolean');
      expect(typeof entry.retryHint).toBe('string');
      if (entry.retryable) {
        expect(entry.retryHint.length).toBeGreaterThan(0);
      }
      _ = code; // suppress unused
    }
  });

  test('retryable codes always have non-empty retryHint', () => {
    for (const entry of Object.values(KYC_WEBHOOK_ERROR_RECOVERY)) {
      if (entry.retryable) {
        expect(entry.retryHint).not.toBe('');
      }
    }
  });

  test('non-retryable codes always have empty retryHint', () => {
    for (const entry of Object.values(KYC_WEBHOOK_ERROR_RECOVERY)) {
      if (!entry.retryable) {
        expect(entry.retryHint).toBe('');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// KNOWN_KYC_WEBHOOK_CODES set
// ---------------------------------------------------------------------------

describe('KNOWN_KYC_WEBHOOK_CODES set', () => {
  test('is exported', () => {
    expect(KNOWN_KYC_WEBHOOK_CODES).toBeDefined();
  });

  test('is frozen', () => {
    expect(Object.isFrozen(KNOWN_KYC_WEBHOOK_CODES)).toBe(true);
  });

  test('contains all KYC_WEBHOOK_ERROR_CODES values', () => {
    for (const code of Object.values(KYC_WEBHOOK_ERROR_CODES)) {
      expect(KNOWN_KYC_WEBHOOK_CODES.has(code)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: backward-compatible with existing KycWebhookError callers
// ---------------------------------------------------------------------------

describe('KycWebhookError — backward-compatibility regression', () => {
  test('existing kycWebhookService call-site shape: new KycWebhookError(msg, status, code)', () => {
    // This mirrors the exact pattern used throughout kycWebhookService.js
    const err = new KycWebhookError(
      'KYC webhook ingestion is not configured',
      503,
      'missing_secret'
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('KYC webhook ingestion is not configured');
    expect(err.status).toBe(503);
    expect(err.code).toBe('missing_secret');
    // NEW: recovery properties must now also be present
    expect(err.retryable).toBe(true);
    expect(err.retryHint).toBe('Retry the request in a few moments.');
  });

  test('401 missing_signature — existing call site still works', () => {
    const err = new KycWebhookError('Missing X-Signature header', 401, 'missing_signature');
    expect(err.status).toBe(401);
    expect(err.code).toBe('missing_signature');
    expect(err.retryable).toBe(false);
    expect(err.retryHint).toBe('');
  });

  test('400 invalid_payload — existing call site still works', () => {
    const err = new KycWebhookError('Invalid JSON payload', 400, 'invalid_payload');
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });

  test('500 persistence_error — existing call site still works', () => {
    const err = new KycWebhookError('KYC record persistence failed', 500, 'persistence_error');
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(false);
  });

  test('instanceof check still passes for error handler', () => {
    const err = new KycWebhookError('test', 400, 'invalid_payload');
    // The middleware checks `err instanceof KycWebhookError`
    expect(err instanceof KycWebhookError).toBe(true);
  });

  test('default export is the class itself (for existing require pattern)', () => {
    // require('../errors/KycWebhookError') returns the class directly
    expect(typeof KycWebhookError).toBe('function');
    expect(KycWebhookError.name).toBe('KycWebhookError');
  });
});

// ---------------------------------------------------------------------------
// Concurrent / duplicate construction (retries cannot produce inconsistent state)
// ---------------------------------------------------------------------------

describe('KycWebhookError — concurrent creation determinism', () => {
  test('same code always produces same retryable/retryHint regardless of call order', () => {
    const codes = [
      KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET,
      KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE,
      KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED,
      KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR,
    ];

    for (const code of codes) {
      const first = kwe('msg', 400, code);
      const second = kwe('msg', 400, code);
      expect(first.retryable).toBe(second.retryable);
      expect(first.retryHint).toBe(second.retryHint);
    }
  });

  test('two errors with different codes have independent retryable values', () => {
    const retryableErr = kwe('msg', 503, KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
    const notRetryableErr = kwe('msg', 401, KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE);

    expect(retryableErr.retryable).toBe(true);
    expect(notRetryableErr.retryable).toBe(false);
    // Mutation of one must not affect the other
    retryableErr.retryable = false;
    expect(notRetryableErr.retryable).toBe(false);
  });
});

// Suppress the `_` unused-variable warning in the table-completeness test.
let _;
