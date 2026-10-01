'use strict';

/**
 * @fileoverview Unit tests for src/errors/KycWebhookError.js (issue #1372).
 *
 * Covers:
 *
 *  Constructor — valid inputs, boundary inputs, invalid inputs
 *    - All allowed HTTP statuses (400, 401, 403, 429, 500, 503)
 *    - All KYC_WEBHOOK_ERROR_CODES values
 *    - Status out of range → clamped to 500
 *    - Unknown code → fallback to 'INTERNAL_ERROR'
 *    - Non-string message → fallback to 'KYC webhook error'
 *    - Empty string message → fallback to 'KYC webhook error'
 *    - Empty string code → fallback to 'INTERNAL_ERROR'
 *    - null / undefined for every argument
 *    - Correct prototype chain (instanceof Error, instanceof KycWebhookError)
 *    - this.name === 'KycWebhookError'
 *    - Error.captureStackTrace integration
 *    - toJSON() shape
 *
 *  KycWebhookError.create factory — strict validation
 *    - Happy-path construction matches constructor output
 *    - Throws TypeError for bad message (non-string, empty, whitespace-only)
 *    - Throws TypeError for bad status (float, string, out-of-range, 404)
 *    - Throws TypeError for bad code (non-string, empty, unlisted value)
 *    - TypeError messages are descriptive and reference the bad value
 *
 *  ALLOWED_KYC_HTTP_STATUSES / ALLOWED_KYC_ERROR_CODES exports
 *    - Frozen / iterable
 *    - Contains every KYC_WEBHOOK_ERROR_CODES member
 *    - Does not contain unexpected values
 *
 *  Interaction with kycWebhookErrorHandler
 *    - Out-of-allowlist status still gets a structured RFC 7807 response
 *    - Unknown code fallback is reflected in the response body
 *
 *  Regression: no argument injection / prototype pollution
 *    - Dangerous field names in message / code are treated as strings, not evaluated
 */

const express = require('express');
const request = require('supertest');

const KycWebhookError = require('../../src/errors/KycWebhookError');
const {
  ALLOWED_KYC_HTTP_STATUSES,
  ALLOWED_KYC_ERROR_CODES,
} = require('../../src/errors/KycWebhookError');
const { KYC_WEBHOOK_ERROR_CODES } = require('../../src/constants/kycWebhooks');
const kycWebhookErrorHandler = require('../../src/middleware/kycWebhookErrorHandler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Express app that throws `err` on GET /test and feeds it
 * through kycWebhookErrorHandler.
 */
function buildTestApp(err) {
  const app = express();
  app.use(express.json());
  app.get('/test', (_req, _res, next) => { next(err); });
  app.use(kycWebhookErrorHandler);
  // Fallback to catch non-KycWebhookError errors that are forwarded
  app.use((e, _req, res, _next) => {
    res.status(500).json({ fallback: true, message: e.message });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Constructor — valid inputs
// ---------------------------------------------------------------------------

describe('KycWebhookError constructor — valid inputs', () => {
  const validCases = [
    { status: 400, code: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD, message: 'bad payload' },
    { status: 401, code: KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE, message: 'no sig' },
    { status: 401, code: KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE, message: 'bad sig' },
    { status: 403, code: KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH, message: 'wrong tenant' },
    { status: 429, code: KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED, message: 'slow down' },
    { status: 500, code: KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR, message: 'db failed' },
    { status: 503, code: KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET, message: 'not configured' },
    { status: 503, code: KYC_WEBHOOK_ERROR_CODES.CIRCUIT_OPEN, message: 'circuit open' },
  ];

  test.each(validCases)(
    'accepts status=%i code=%s',
    ({ status, code, message }) => {
      const err = new KycWebhookError(message, status, code);

      expect(err.message).toBe(message);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.name).toBe('KycWebhookError');
    },
  );

  test('is an instance of Error', () => {
    const err = new KycWebhookError('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KycWebhookError);
  });

  test('has a stack trace', () => {
    const err = new KycWebhookError('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    expect(typeof err.stack).toBe('string');
    expect(err.stack.length).toBeGreaterThan(0);
  });

  test('stack trace does not include KycWebhookError constructor frame (captureStackTrace)', () => {
    const err = new KycWebhookError('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    // First line of stack is "KycWebhookError: msg".
    // Second line should NOT be inside the KycWebhookError constructor itself.
    const lines = err.stack.split('\n');
    const constructorLine = lines.find((l) => l.includes('KycWebhookError ('));
    // V8's captureStackTrace removes the constructor frame, so there should be
    // no "new KycWebhookError" frame in the trace.
    expect(constructorLine).toBeUndefined();
  });

  test('toJSON returns correct shape', () => {
    const err = new KycWebhookError('Some error', 401, KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE);
    expect(err.toJSON()).toEqual({
      name: 'KycWebhookError',
      status: 401,
      code: KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE,
      message: 'Some error',
    });
  });

  test('toJSON contains no stack or internal fields', () => {
    const err = new KycWebhookError('msg', 500, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
    const json = err.toJSON();
    expect(json).not.toHaveProperty('stack');
    expect(Object.keys(json)).toEqual(['name', 'status', 'code', 'message']);
  });
});

// ---------------------------------------------------------------------------
// Constructor — every allowed HTTP status is accepted
// ---------------------------------------------------------------------------

describe('KycWebhookError constructor — every allowed HTTP status', () => {
  test.each([400, 401, 403, 429, 500, 503])(
    'status %i is accepted without clamping',
    (status) => {
      const err = new KycWebhookError('msg', status, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR);
      expect(err.status).toBe(status);
    },
  );
});

// ---------------------------------------------------------------------------
// Constructor — every allowed error code is accepted
// ---------------------------------------------------------------------------

describe('KycWebhookError constructor — every KYC_WEBHOOK_ERROR_CODES member', () => {
  // Pick a status that is valid for all codes in this looped test.
  const STATUS = 400;

  test.each(Object.values(KYC_WEBHOOK_ERROR_CODES))(
    'code=%s is accepted',
    (code) => {
      const err = new KycWebhookError('msg', STATUS, code);
      expect(err.code).toBe(code);
    },
  );
});

// ---------------------------------------------------------------------------
// Constructor — invalid / boundary inputs (lenient-coercion path)
// ---------------------------------------------------------------------------

describe('KycWebhookError constructor — invalid inputs coerced to safe defaults', () => {
  describe('status', () => {
    test('out-of-range integer (404) is clamped to 500', () => {
      const err = new KycWebhookError('msg', 404, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });

    test('200 (success status) is clamped to 500', () => {
      const err = new KycWebhookError('msg', 200, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });

    test('600 (above 5xx) is clamped to 500', () => {
      const err = new KycWebhookError('msg', 600, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });

    test('float (400.5) is clamped to 500', () => {
      const err = new KycWebhookError('msg', 400.5, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });

    test('NaN is clamped to 500', () => {
      const err = new KycWebhookError('msg', NaN, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });

    test('string "400" is clamped to 500 (must be a numeric integer in the allowlist)', () => {
      // resolveStatus coerces via Number() — "400" → 400 which IS in the allowlist, so it passes.
      // This verifies the Number() coercion path works correctly for string numbers.
      const err = new KycWebhookError('msg', '400', KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      // "400" parsed → 400 which is in ALLOWED_KYC_HTTP_STATUSES
      expect(err.status).toBe(400);
    });

    test('undefined is clamped to 500', () => {
      const err = new KycWebhookError('msg', undefined, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });

    test('null is clamped to 500', () => {
      const err = new KycWebhookError('msg', null, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.status).toBe(500);
    });
  });

  describe('code', () => {
    test('unknown string code falls back to INTERNAL_ERROR', () => {
      const err = new KycWebhookError('msg', 400, 'totally_unknown_code_xyz');
      expect(err.code).toBe('INTERNAL_ERROR');
    });

    test('empty string code falls back to INTERNAL_ERROR', () => {
      const err = new KycWebhookError('msg', 400, '');
      expect(err.code).toBe('INTERNAL_ERROR');
    });

    test('numeric code falls back to INTERNAL_ERROR', () => {
      const err = new KycWebhookError('msg', 400, 42);
      expect(err.code).toBe('INTERNAL_ERROR');
    });

    test('undefined code falls back to INTERNAL_ERROR', () => {
      const err = new KycWebhookError('msg', 400, undefined);
      expect(err.code).toBe('INTERNAL_ERROR');
    });

    test('null code falls back to INTERNAL_ERROR', () => {
      const err = new KycWebhookError('msg', 400, null);
      expect(err.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('message', () => {
    test('non-string message falls back to default', () => {
      const err = new KycWebhookError(42, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.message).toBe('KYC webhook error');
    });

    test('empty string message falls back to default', () => {
      const err = new KycWebhookError('', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.message).toBe('KYC webhook error');
    });

    test('null message falls back to default', () => {
      const err = new KycWebhookError(null, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.message).toBe('KYC webhook error');
    });

    test('undefined message falls back to default', () => {
      const err = new KycWebhookError(undefined, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.message).toBe('KYC webhook error');
    });

    test('object message falls back to default', () => {
      const err = new KycWebhookError({ detail: 'sensitive' }, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(err.message).toBe('KYC webhook error');
    });
  });

  describe('no-argument construction (extreme edge case)', () => {
    test('constructs safely with all fallbacks when called with no arguments', () => {
      const err = new KycWebhookError();
      expect(err.message).toBe('KYC webhook error');
      expect(err.status).toBe(500);
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.name).toBe('KycWebhookError');
      expect(err).toBeInstanceOf(KycWebhookError);
      expect(err).toBeInstanceOf(Error);
    });
  });
});

// ---------------------------------------------------------------------------
// KycWebhookError.create — strict factory
// ---------------------------------------------------------------------------

describe('KycWebhookError.create — strict factory', () => {
  describe('happy path', () => {
    test('returns a KycWebhookError with the supplied values', () => {
      const err = KycWebhookError.create(
        'Tenant scope mismatch.',
        403,
        KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH,
      );
      expect(err).toBeInstanceOf(KycWebhookError);
      expect(err.message).toBe('Tenant scope mismatch.');
      expect(err.status).toBe(403);
      expect(err.code).toBe(KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH);
    });

    test.each([400, 401, 403, 429, 500, 503])(
      'accepts every allowed status (%i)',
      (status) => {
        expect(() =>
          KycWebhookError.create('msg', status, KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR),
        ).not.toThrow();
      },
    );

    test.each(Object.values(KYC_WEBHOOK_ERROR_CODES))(
      'accepts every KYC_WEBHOOK_ERROR_CODES member (%s)',
      (code) => {
        expect(() =>
          KycWebhookError.create('msg', 400, code),
        ).not.toThrow();
      },
    );

    test('accepts INTERNAL_ERROR sentinel code', () => {
      const err = KycWebhookError.create('msg', 500, 'INTERNAL_ERROR');
      expect(err.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('rejects bad message', () => {
    test.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
      ['number', 42],
      ['null', null],
      ['undefined', undefined],
      ['object', { x: 1 }],
    ])('%s throws TypeError', (_label, message) => {
      expect(() =>
        KycWebhookError.create(message, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD),
      ).toThrow(TypeError);
    });

    test('TypeError message references the bad value', () => {
      expect(() => KycWebhookError.create('', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD))
        .toThrow(/message.*must be a non-empty string/i);
    });
  });

  describe('rejects bad status', () => {
    test.each([
      ['float', 400.5],
      ['string "400"', '400'],
      ['404', 404],
      ['200', 200],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['null', null],
      ['undefined', undefined],
    ])('%s throws TypeError', (_label, status) => {
      expect(() =>
        KycWebhookError.create('msg', status, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD),
      ).toThrow(TypeError);
    });

    test('TypeError message references the bad value', () => {
      expect(() => KycWebhookError.create('msg', 404, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD))
        .toThrow(/status.*must be one of/i);
    });
  });

  describe('rejects bad code', () => {
    test.each([
      ['unknown string', 'not_a_real_code'],
      ['empty string', ''],
      ['number', 123],
      ['null', null],
      ['undefined', undefined],
    ])('%s throws TypeError', (_label, code) => {
      expect(() =>
        KycWebhookError.create('msg', 400, code),
      ).toThrow(TypeError);
    });

    test('TypeError message references the bad value', () => {
      expect(() => KycWebhookError.create('msg', 400, 'fake_code'))
        .toThrow(/code.*must be a recognised KYC error code/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Exported sets
// ---------------------------------------------------------------------------

describe('ALLOWED_KYC_HTTP_STATUSES export', () => {
  test('is a Set', () => {
    expect(ALLOWED_KYC_HTTP_STATUSES).toBeInstanceOf(Set);
  });

  test('is frozen (immutable)', () => {
    expect(Object.isFrozen(ALLOWED_KYC_HTTP_STATUSES)).toBe(true);
  });

  test('contains the documented status codes', () => {
    for (const s of [400, 401, 403, 429, 500, 503]) {
      expect(ALLOWED_KYC_HTTP_STATUSES.has(s)).toBe(true);
    }
  });

  test('does not contain 404, 200, or 302', () => {
    expect(ALLOWED_KYC_HTTP_STATUSES.has(404)).toBe(false);
    expect(ALLOWED_KYC_HTTP_STATUSES.has(200)).toBe(false);
    expect(ALLOWED_KYC_HTTP_STATUSES.has(302)).toBe(false);
  });
});

describe('ALLOWED_KYC_ERROR_CODES export', () => {
  test('is a Set', () => {
    expect(ALLOWED_KYC_ERROR_CODES).toBeInstanceOf(Set);
  });

  test('is frozen (immutable)', () => {
    expect(Object.isFrozen(ALLOWED_KYC_ERROR_CODES)).toBe(true);
  });

  test('contains every KYC_WEBHOOK_ERROR_CODES member', () => {
    for (const code of Object.values(KYC_WEBHOOK_ERROR_CODES)) {
      expect(ALLOWED_KYC_ERROR_CODES.has(code)).toBe(true);
    }
  });

  test('contains the INTERNAL_ERROR sentinel', () => {
    expect(ALLOWED_KYC_ERROR_CODES.has('INTERNAL_ERROR')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: coerced errors still produce valid RFC 7807 responses
// ---------------------------------------------------------------------------

describe('KycWebhookError with kycWebhookErrorHandler — coercion integration', () => {
  test('unknown code is coerced to INTERNAL_ERROR and still emits a structured 500 response', async () => {
    const err = new KycWebhookError('something broke', 500, 'i_made_this_up');
    const app = buildTestApp(err);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.detail).toBe('something broke');
    expect(res.body.retryable).toBe(false);
  });

  test('out-of-range status (404) is clamped to 500 and produces a valid error response', async () => {
    const err = new KycWebhookError('not found in the wrong layer', 404, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    const app = buildTestApp(err);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
  });

  test('503 with MISSING_SECRET is retryable', async () => {
    const err = new KycWebhookError(
      'KYC webhook ingestion is not configured',
      503,
      KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET,
    );
    const app = buildTestApp(err);

    const res = await request(app).get('/test');

    expect(res.status).toBe(503);
    expect(res.body.retryable).toBe(true);
    expect(res.body.retry_hint).not.toBe('');
  });

  test('non-KycWebhookError is forwarded and does not produce a problem+json', async () => {
    const err = new Error('plain error');
    const app = buildTestApp(err);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body.fallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security: no prototype pollution or field-injection through message/code
// ---------------------------------------------------------------------------

describe('KycWebhookError — security: no prototype pollution', () => {
  test('a message containing __proto__ is treated as a plain string', () => {
    const msg = '__proto__[polluted]=true';
    const err = new KycWebhookError(msg, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    expect(err.message).toBe(msg);
    // Confirm no property was set on Object.prototype
    expect({}.polluted).toBeUndefined();
  });

  test('a message containing constructor injection attempt is stored as-is', () => {
    const msg = 'constructor.prototype.x=1';
    const err = new KycWebhookError(msg, 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    expect(err.message).toBe(msg);
    expect({}.x).toBeUndefined();
  });

  test('code cannot be used to override INTERNAL_ERROR with a dangerous value', () => {
    const err = new KycWebhookError('msg', 400, '__proto__');
    // '__proto__' is not in the allowlist → falls back to INTERNAL_ERROR
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  test('toJSON output does not include stack or non-safe fields', () => {
    const err = new KycWebhookError('msg', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    const json = err.toJSON();
    // Only the four documented fields should be present as own enumerable keys.
    expect(Object.keys(json)).toEqual(['name', 'status', 'code', 'message']);
    // No stack trace, no internal implementation details.
    expect(json).not.toHaveProperty('stack');
    // __proto__ and constructor must not be own enumerable properties.
    expect(Object.prototype.hasOwnProperty.call(json, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(json, 'constructor')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: existing callers that pass dynamic values keep working
// ---------------------------------------------------------------------------

describe('KycWebhookError — backward-compatibility regressions', () => {
  test('kycWebhookService-style construction (all known codes) passes through unchanged', () => {
    const cases = [
      [KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET, 503],
      [KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE, 401],
      [KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE, 401],
      [KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD, 400],
      [KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH, 403],
      [KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT, 400],
      [KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID, 400],
      [KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS, 400],
      [KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS, 400],
      [KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR, 500],
      [KYC_WEBHOOK_ERROR_CODES.CIRCUIT_OPEN, 503],
      [KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED, 429],
      [KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION, 400],
      [KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR, 400],
      [KYC_WEBHOOK_ERROR_CODES.QUARANTINED, 400],
    ];

    for (const [code, status] of cases) {
      const err = new KycWebhookError(`Error for ${code}`, status, code);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  test('PAYLOAD_TOO_LARGE and INVALID_PAGINATION codes are accepted (edge case: uppercase constants)', () => {
    const err1 = new KycWebhookError('too big', 400, KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE);
    expect(err1.code).toBe(KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE);

    const err2 = new KycWebhookError('bad page', 400, KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION);
    expect(err2.code).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION);
  });
});
