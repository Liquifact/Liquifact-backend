'use strict';

/**
 * @fileoverview Focused unit tests for AppError compatibility contracts.
 *
 * These tests enforce the public interface that ~37 callers across the
 * codebase depend on. Changing any assertion here without a matching
 * compatibility plan must be treated as a breaking change.
 *
 * Coverage map:
 *  ✓ Valid construction — all instance properties present and typed correctly
 *  ✓ Invalid / boundary inputs — null params, bad status, missing fields
 *  ✓ Duplicate / redundant construction — same params produce equivalent objects
 *  ✓ retryable semantics — defaults, explicit true/false, factory defaults
 *  ✓ fieldErrors — present only when explicitly supplied (hasOwnProperty contract)
 *  ✓ context — defaults to null, never undefined
 *  ✓ FENCING_TOKEN_REJECTED — frozen constant value and non-mutability
 *  ✓ instanceof chain — AppError is also an Error
 *  ✓ Duck-typing — error.name === 'AppError' for cross-module-cache checks
 *  ✓ isAppError() static type-guard
 *  ✓ Wire-format invariant — retryHint (camelCase) on instance, NOT retry_hint
 *  ✓ Own-property set — only expected keys exist on the instance
 *  ✓ Static factories — each factory produces the correct status/type/title
 *  ✓ Stack trace — excluded from serialised problem, captured on Error.stack
 *  ✓ mapError integration — retryHint and code are surfaced correctly
 */

const AppError = require('../../src/errors/AppError');
const { mapError } = require('../../src/errors/mapError');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all own enumerable + non-enumerable property names on the instance
 * (excluding the inherited Error prototype chain), sorted for stable comparison.
 */
function ownKeys(err) {
  return Object.getOwnPropertyNames(err).filter((k) => k !== 'stack').sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Valid construction
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — valid construction', () => {
  test('creates instance with all supplied fields', () => {
    const err = new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Invoice inv_123 was not found.',
      instance: '/api/invoices/inv_123',
      code: 'INVOICE_NOT_FOUND',
      retryable: false,
      retryHint: 'Verify the invoice ID and retry.',
    });

    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.type).toBe('https://liquifact.com/probs/not-found');
    expect(err.title).toBe('Not Found');
    expect(err.status).toBe(404);
    expect(err.detail).toBe('Invoice inv_123 was not found.');
    expect(err.instance).toBe('/api/invoices/inv_123');
    expect(err.code).toBe('INVOICE_NOT_FOUND');
    expect(err.retryable).toBe(false);
    expect(err.retryHint).toBe('Verify the invoice ID and retry.');
    expect(err.message).toBe('Not Found');
    expect(err.stack).toBeDefined();
    expect(err.context).toBeNull();
  });

  test('message equals title (Error base class contract)', () => {
    const err = new AppError({ title: 'Conflict', status: 409 });
    expect(err.message).toBe('Conflict');
  });

  test('RFC 7807 defaults apply when type / title / status are omitted', () => {
    const err = new AppError({ detail: 'Something went wrong.' });
    expect(err.type).toBe('about:blank');
    expect(err.title).toBe('An unexpected error occurred');
    expect(err.status).toBe(500);
  });

  test('retryable defaults to false when not supplied', () => {
    const err = new AppError({ status: 404 });
    expect(err.retryable).toBe(false);
  });

  test('retryable is exactly false (boolean), not falsy', () => {
    const err = new AppError({ status: 500 });
    expect(typeof err.retryable).toBe('boolean');
    expect(err.retryable).toBe(false);
  });

  test('retryable is true when explicitly set', () => {
    const err = new AppError({ status: 503, retryable: true });
    expect(err.retryable).toBe(true);
  });

  test('context is null by default', () => {
    const err = new AppError({ status: 400 });
    expect(err.context).toBeNull();
    expect(err.context).not.toBeUndefined();
  });

  test('context carries supplied value', () => {
    const ctx = { tenantId: 'tenant-001', invoiceId: 'inv_777' };
    const err = new AppError({ status: 400, context: ctx });
    expect(err.context).toBe(ctx);
  });

  test('context: false preserves falsy non-null value', () => {
    const err = new AppError({ status: 400, context: false });
    expect(err.context).toBe(false);
  });

  test('context: 0 preserves falsy non-null value', () => {
    const err = new AppError({ status: 400, context: 0 });
    expect(err.context).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invalid / boundary inputs
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — invalid and boundary inputs', () => {
  test('null params does not throw — falls back to all defaults', () => {
    expect(() => new AppError(null)).not.toThrow();
    const err = new AppError(null);
    expect(err.status).toBe(500);
    expect(err.name).toBe('AppError');
  });

  test('undefined params does not throw — falls back to all defaults', () => {
    expect(() => new AppError(undefined)).not.toThrow();
    const err = new AppError(undefined);
    expect(err.status).toBe(500);
  });

  test('no-argument construction does not throw', () => {
    expect(() => new AppError()).not.toThrow();
    const err = new AppError();
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(false);
  });

  test('non-integer status (float) defaults to 500', () => {
    const err = new AppError({ status: 400.5 });
    expect(err.status).toBe(500);
  });

  test('negative status defaults to 500', () => {
    const err = new AppError({ status: -1 });
    expect(err.status).toBe(500);
  });

  test('status 0 defaults to 500', () => {
    const err = new AppError({ status: 0 });
    expect(err.status).toBe(500);
  });

  test('status 99 (below range) defaults to 500', () => {
    const err = new AppError({ status: 99 });
    expect(err.status).toBe(500);
  });

  test('status 600 (above range) defaults to 500', () => {
    const err = new AppError({ status: 600 });
    expect(err.status).toBe(500);
  });

  test('status NaN defaults to 500', () => {
    const err = new AppError({ status: NaN });
    expect(err.status).toBe(500);
  });

  test('string status defaults to 500', () => {
    const err = new AppError({ status: '404' });
    expect(err.status).toBe(500);
  });

  test('boundary status 100 is accepted', () => {
    const err = new AppError({ status: 100 });
    expect(err.status).toBe(100);
  });

  test('boundary status 599 is accepted', () => {
    const err = new AppError({ status: 599 });
    expect(err.status).toBe(599);
  });

  test('empty title string falls back to default', () => {
    const err = new AppError({ title: '' });
    expect(err.title).toBe('An unexpected error occurred');
    expect(err.message).toBe('An unexpected error occurred');
  });

  test('non-string title falls back to default', () => {
    const err = new AppError({ title: 42 });
    expect(err.title).toBe('An unexpected error occurred');
  });

  test('primitive params (string) does not throw — falls back to all defaults', () => {
    expect(() => new AppError('oops')).not.toThrow();
    const err = new AppError('oops');
    expect(err.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Duplicate / redundant construction
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — duplicate construction produces equivalent objects', () => {
  const PARAMS = Object.freeze({
    type: 'https://liquifact.com/probs/conflict',
    title: 'Conflict',
    status: 409,
    detail: 'Invoice is already linked.',
    code: 'DUPLICATE_INVOICE',
    retryable: false,
  });

  test('two instances with the same params have equal field values', () => {
    const a = new AppError(PARAMS);
    const b = new AppError(PARAMS);

    expect(a.type).toBe(b.type);
    expect(a.title).toBe(b.title);
    expect(a.status).toBe(b.status);
    expect(a.detail).toBe(b.detail);
    expect(a.code).toBe(b.code);
    expect(a.retryable).toBe(b.retryable);
    expect(a.name).toBe(b.name);
  });

  test('two instances with the same params are distinct objects', () => {
    const a = new AppError(PARAMS);
    const b = new AppError(PARAMS);
    expect(a).not.toBe(b);
  });

  test('params object is not mutated by the constructor', () => {
    const params = { title: 'Test', status: 400, detail: 'Bad.' };
    const paramsBefore = JSON.stringify(params);
    new AppError(params); // eslint-disable-line no-new
    expect(JSON.stringify(params)).toBe(paramsBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. retryable semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — retryable semantics', () => {
  test('retryable false when not supplied', () => {
    expect(new AppError({ status: 400 }).retryable).toBe(false);
    expect(new AppError({ status: 404 }).retryable).toBe(false);
    expect(new AppError({ status: 409 }).retryable).toBe(false);
    expect(new AppError({ status: 500 }).retryable).toBe(false);
  });

  test('retryable true when explicitly set', () => {
    expect(new AppError({ status: 503, retryable: true }).retryable).toBe(true);
    expect(new AppError({ status: 429, retryable: true }).retryable).toBe(true);
  });

  test('retryable false when explicitly set to false', () => {
    expect(new AppError({ status: 503, retryable: false }).retryable).toBe(false);
  });

  test('tooManyRequests factory defaults retryable to true', () => {
    expect(AppError.tooManyRequests('Rate limited.').retryable).toBe(true);
  });

  test('serviceUnavailable factory defaults retryable to true', () => {
    expect(AppError.serviceUnavailable().retryable).toBe(true);
  });

  test('badRequest factory defaults retryable to false', () => {
    expect(AppError.badRequest('Bad body.').retryable).toBe(false);
  });

  test('factory retryable can be overridden via options', () => {
    const err = AppError.tooManyRequests('Limit.', { retryable: false });
    expect(err.retryable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. retryHint — camelCase on instance, NOT retry_hint
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — retryHint wire-format invariant', () => {
  test('retryHint is set on the instance in camelCase', () => {
    const err = new AppError({
      status: 429,
      retryable: true,
      retryHint: 'Wait 60 seconds.',
    });
    expect(err.retryHint).toBe('Wait 60 seconds.');
  });

  test('retry_hint (snake_case) is NOT a property on the instance', () => {
    const err = new AppError({
      status: 429,
      retryable: true,
      retryHint: 'Wait 60 seconds.',
    });
    expect(err).not.toHaveProperty('retry_hint');
  });

  test('retryHint is undefined when not supplied', () => {
    const err = new AppError({ status: 400 });
    expect(err.retryHint).toBeUndefined();
    expect(err).not.toHaveProperty('retry_hint');
  });

  test('mapError surfaces retryHint as retryHint (camelCase) on mapped result', () => {
    const err = new AppError({
      status: 409,
      retryable: false,
      retryHint: 'Resolve the conflict and retry.',
    });
    const mapped = mapError(err);
    expect(mapped.retryHint).toBe('Resolve the conflict and retry.');
    expect(mapped).not.toHaveProperty('retry_hint');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. fieldErrors — hasOwnProperty contract
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — fieldErrors hasOwnProperty contract', () => {
  test('fieldErrors is present when explicitly supplied', () => {
    const err = new AppError({
      status: 400,
      fieldErrors: { email: 'Invalid format.' },
    });
    expect(Object.prototype.hasOwnProperty.call(err, 'fieldErrors')).toBe(true);
    expect(err.fieldErrors).toEqual({ email: 'Invalid format.' });
  });

  test('fieldErrors is absent when not supplied', () => {
    const err = new AppError({ status: 400 });
    expect(Object.prototype.hasOwnProperty.call(err, 'fieldErrors')).toBe(false);
    expect(err.fieldErrors).toBeUndefined();
  });

  test('fieldErrors absent even with code, retryable, and other extensions', () => {
    const err = new AppError({
      status: 422,
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
    expect(Object.prototype.hasOwnProperty.call(err, 'fieldErrors')).toBe(false);
  });

  test('fieldErrors: null is treated as explicitly supplied', () => {
    const err = new AppError({ status: 400, fieldErrors: null });
    expect(Object.prototype.hasOwnProperty.call(err, 'fieldErrors')).toBe(true);
    expect(err.fieldErrors).toBeNull();
  });

  test('fieldErrors: empty object is preserved', () => {
    const err = new AppError({ status: 400, fieldErrors: {} });
    expect(err.fieldErrors).toEqual({});
  });

  test('fieldErrors: multiple field keys', () => {
    const errs = { amount: 'Must be positive.', currency: 'Required.' };
    const err = new AppError({ status: 400, fieldErrors: errs });
    expect(err.fieldErrors).toEqual(errs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. context
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — context defaults to null', () => {
  test('context is null when not supplied', () => {
    const err = new AppError({ status: 400 });
    expect(err.context).toBeNull();
  });

  test('context is never undefined', () => {
    const err = new AppError({ status: 400 });
    expect(err.context).not.toBeUndefined();
  });

  test('context carries supplied object reference', () => {
    const ctx = { requestId: 'req_abc' };
    const err = new AppError({ status: 400, context: ctx });
    expect(err.context).toBe(ctx);
  });

  test('context: explicit null is preserved', () => {
    const err = new AppError({ status: 400, context: null });
    expect(err.context).toBeNull();
  });

  test('context: arbitrary string value', () => {
    const err = new AppError({ status: 400, context: 'tenant-001' });
    expect(err.context).toBe('tenant-001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. FENCING_TOKEN_REJECTED static constant
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — FENCING_TOKEN_REJECTED constant', () => {
  test('FENCING_TOKEN_REJECTED equals the expected string', () => {
    expect(AppError.FENCING_TOKEN_REJECTED).toBe('FENCING_TOKEN_REJECTED');
  });

  test('FENCING_TOKEN_REJECTED is a string', () => {
    expect(typeof AppError.FENCING_TOKEN_REJECTED).toBe('string');
  });

  test('FENCING_TOKEN_REJECTED is non-writable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AppError, 'FENCING_TOKEN_REJECTED');
    expect(descriptor.writable).toBe(false);
  });

  test('FENCING_TOKEN_REJECTED is non-configurable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AppError, 'FENCING_TOKEN_REJECTED');
    expect(descriptor.configurable).toBe(false);
  });

  test('FENCING_TOKEN_REJECTED is enumerable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AppError, 'FENCING_TOKEN_REJECTED');
    expect(descriptor.enumerable).toBe(true);
  });

  test('attempt to overwrite FENCING_TOKEN_REJECTED does not change the value', () => {
    const original = AppError.FENCING_TOKEN_REJECTED;
    try {
      AppError.FENCING_TOKEN_REJECTED = 'MUTATED';
    } catch (_) {
      // strict-mode will throw; non-strict silently ignores
    }
    expect(AppError.FENCING_TOKEN_REJECTED).toBe(original);
  });

  test('FENCING_TOKEN_REJECTED can be used as a code in an AppError', () => {
    const err = new AppError({
      status: 409,
      code: AppError.FENCING_TOKEN_REJECTED,
      detail: 'Lease expired.',
    });
    expect(err.code).toBe('FENCING_TOKEN_REJECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. instanceof chain and duck-typing
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — instanceof chain', () => {
  test('AppError instanceof AppError', () => {
    expect(new AppError({ status: 400 })).toBeInstanceOf(AppError);
  });

  test('AppError instanceof Error', () => {
    expect(new AppError({ status: 400 })).toBeInstanceOf(Error);
  });

  test('name is always "AppError"', () => {
    expect(new AppError({ status: 404 }).name).toBe('AppError');
  });

  test('duck-type check: error.name === "AppError" identifies the instance', () => {
    const err = new AppError({ status: 403 });
    expect(err.name === 'AppError').toBe(true);
  });

  test('plain Error is NOT an AppError', () => {
    expect(new Error('oops')).not.toBeInstanceOf(AppError);
  });

  test('isAppError() returns true for an AppError instance', () => {
    expect(AppError.isAppError(new AppError({ status: 400 }))).toBe(true);
  });

  test('isAppError() returns true for an object with name === "AppError"', () => {
    // Simulates cross-module-cache duck-typing scenario
    const fakeAppError = { name: 'AppError', status: 404 };
    expect(AppError.isAppError(fakeAppError)).toBe(true);
  });

  test('isAppError() returns false for plain Error', () => {
    expect(AppError.isAppError(new Error('boom'))).toBe(false);
  });

  test('isAppError() returns false for null', () => {
    expect(AppError.isAppError(null)).toBe(false);
  });

  test('isAppError() returns false for undefined', () => {
    expect(AppError.isAppError(undefined)).toBe(false);
  });

  test('isAppError() returns false for a plain object', () => {
    expect(AppError.isAppError({ status: 400 })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Own-property set — no unexpected keys
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — own-property set', () => {
  test('instance without fieldErrors has exactly the expected own keys', () => {
    const err = new AppError({
      type: 'https://liquifact.com/probs/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'Invalid.',
    });

    const expected = [
      'code', 'context', 'detail', 'instance', 'message', 'name',
      'retryHint', 'retryable', 'status', 'title', 'type',
    ].sort();

    expect(ownKeys(err)).toEqual(expected);
  });

  test('instance with fieldErrors adds exactly one extra own key', () => {
    const err = new AppError({
      status: 400,
      fieldErrors: { name: 'Required.' },
    });
    const keys = ownKeys(err);
    expect(keys).toContain('fieldErrors');
    // Ensure no other spurious keys exist beyond the standard set + fieldErrors
    const expected = [
      'code', 'context', 'detail', 'fieldErrors', 'instance', 'message', 'name',
      'retryHint', 'retryable', 'status', 'title', 'type',
    ].sort();
    expect(keys).toEqual(expected);
  });

  test('retry_hint (snake_case) is never an own property on the instance', () => {
    const err = new AppError({ status: 429, retryHint: 'Try again.' });
    expect(Object.prototype.hasOwnProperty.call(err, 'retry_hint')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Static factories
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — static factories', () => {
  const FACTORY_CASES = [
    {
      name: 'badRequest',
      call: () => AppError.badRequest('Bad input.'),
      status: 400,
      titleContains: 'Bad Request',
      typeContains: 'bad-request',
    },
    {
      name: 'unauthorized',
      call: () => AppError.unauthorized(),
      status: 401,
      titleContains: 'Unauthorized',
      typeContains: 'unauthorized',
    },
    {
      name: 'forbidden',
      call: () => AppError.forbidden(),
      status: 403,
      titleContains: 'Forbidden',
      typeContains: 'forbidden',
    },
    {
      name: 'notFound',
      call: () => AppError.notFound(),
      status: 404,
      titleContains: 'Not Found',
      typeContains: 'not-found',
    },
    {
      name: 'conflict',
      call: () => AppError.conflict(),
      status: 409,
      titleContains: 'Conflict',
      typeContains: 'conflict',
    },
    {
      name: 'unprocessableEntity',
      call: () => AppError.unprocessableEntity(),
      status: 422,
      titleContains: 'Unprocessable',
      typeContains: 'unprocessable',
    },
    {
      name: 'tooManyRequests',
      call: () => AppError.tooManyRequests(),
      status: 429,
      titleContains: 'Too Many',
      typeContains: 'too-many-requests',
    },
    {
      name: 'internal',
      call: () => AppError.internal(),
      status: 500,
      titleContains: 'Internal',
      typeContains: 'internal-server-error',
    },
    {
      name: 'serviceUnavailable',
      call: () => AppError.serviceUnavailable(),
      status: 503,
      titleContains: 'Service Unavailable',
      typeContains: 'service-unavailable',
    },
  ];

  test.each(FACTORY_CASES)(
    '$name() produces an AppError with status $status',
    ({ call, status, titleContains, typeContains }) => {
      const err = call();
      expect(err).toBeInstanceOf(AppError);
      expect(err.status).toBe(status);
      expect(err.title).toContain(titleContains);
      expect(err.type).toContain(typeContains);
    }
  );

  test('factory options are merged and can override defaults', () => {
    const err = AppError.notFound('Custom detail.', {
      code: 'INVOICE_NOT_FOUND',
      instance: '/api/invoices/inv_001',
    });
    expect(err.detail).toBe('Custom detail.');
    expect(err.code).toBe('INVOICE_NOT_FOUND');
    expect(err.instance).toBe('/api/invoices/inv_001');
  });

  test('tooManyRequests factory provides sensible retryHint', () => {
    const err = AppError.tooManyRequests();
    expect(typeof err.retryHint).toBe('string');
    expect(err.retryHint.length).toBeGreaterThan(0);
  });

  test('serviceUnavailable factory provides sensible retryHint', () => {
    const err = AppError.serviceUnavailable();
    expect(typeof err.retryHint).toBe('string');
    expect(err.retryHint.length).toBeGreaterThan(0);
  });

  test('factory with fieldErrors option propagates fieldErrors', () => {
    const err = AppError.badRequest('Validation failed.', {
      fieldErrors: { email: 'Invalid format.' },
    });
    expect(err.fieldErrors).toEqual({ email: 'Invalid format.' });
    expect(Object.prototype.hasOwnProperty.call(err, 'fieldErrors')).toBe(true);
  });

  test('factory with context option propagates context', () => {
    const ctx = { invoiceId: 'inv_999' };
    const err = AppError.internal('Unexpected.', { context: ctx });
    expect(err.context).toBe(ctx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Stack trace
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — stack trace', () => {
  test('stack is defined', () => {
    const err = new AppError({ status: 400 });
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });

  test('stack contains the test file name (captured from throw site)', () => {
    const err = new AppError({ title: 'Test Stack', detail: 'testing stack trace' });
    expect(err.stack).toContain('AppError.contracts.test.js');
  });

  test('stack does NOT reference the AppError constructor itself', () => {
    const err = new AppError({ status: 500 });
    // The first frame should be from the caller, not from within AppError constructor
    const firstCallFrame = err.stack.split('\n')[1] || '';
    expect(firstCallFrame).not.toContain('new AppError');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. mapError integration
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — mapError integration', () => {
  test('mapError preserves status, code, detail, retryable, retryHint', () => {
    const err = new AppError({
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Conflict happened.',
      instance: '/api/invoices/1',
      code: 'CONFLICT',
      retryable: false,
      retryHint: 'Resolve the conflict and try again.',
    });

    const mapped = mapError(err);
    expect(mapped).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'Conflict happened.',
      retryable: false,
      retryHint: 'Resolve the conflict and try again.',
    });
  });

  test('mapError falls back to httpStatusToCode when code is absent', () => {
    const err = new AppError({ status: 404, detail: 'Not found.' });
    const mapped = mapError(err);
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.message).toBe('Not found.');
  });

  test('mapError sets retryable false on AppError that omits retryable', () => {
    const err = new AppError({ status: 400 });
    const mapped = mapError(err);
    expect(mapped.retryable).toBe(false);
  });

  test('duck-typed AppError (name === "AppError") is handled by mapError', () => {
    const fake = {
      name: 'AppError',
      status: 403,
      code: 'FORBIDDEN',
      detail: 'Not allowed.',
      retryable: false,
      retryHint: '',
    };
    const mapped = mapError(fake);
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('FORBIDDEN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Regression — existing AppError.test.js compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('AppError — regression: existing test compatibility', () => {
  test('creates instance with correct properties (original test)', () => {
    const errorData = {
      type: 'https://liquifact.com/probs/not-found',
      title: 'Resource Not Found',
      status: 404,
      detail: 'The resource could not be found.',
      instance: '/api/resource/123',
    };

    const error = new AppError(errorData);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.type).toBe(errorData.type);
    expect(error.title).toBe(errorData.title);
    expect(error.status).toBe(errorData.status);
    expect(error.detail).toBe(errorData.detail);
    expect(error.instance).toBe(errorData.instance);
    expect(error.stack).toBeDefined();
  });

  test('uses default values if some parameters are missing (original test)', () => {
    const error = new AppError({
      title: 'Generic Error',
      detail: 'Something happened',
    });

    expect(error.type).toBe('about:blank');
    expect(error.status).toBe(500);
    expect(error.title).toBe('Generic Error');
  });

  test('includes extension fields from canonical builder (original test)', () => {
    const error = new AppError({
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Resource conflict.',
      code: 'CONFLICT',
      retryable: false,
      retryHint: 'Resolve conflict and retry.',
    });

    expect(error.code).toBe('CONFLICT');
    expect(error.retryable).toBe(false);
    expect(error.retryHint).toBe('Resolve conflict and retry.');
  });

  test('has no unexpected properties (original test)', () => {
    const error = new AppError({
      type: 'https://liquifact.com/probs/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'Invalid.',
    });

    const keys = ownKeys(error);
    expect(keys).toEqual([
      'code', 'context', 'detail', 'instance', 'message',
      'name', 'retryHint', 'retryable', 'status', 'title', 'type',
    ].sort());
  });

  test('does not expose retry_hint (snake_case) on the instance (original test)', () => {
    const error = new AppError({
      status: 429,
      retryable: true,
      retryHint: 'Wait and retry.',
    });

    expect(error.retryHint).toBe('Wait and retry.');
    expect(error).not.toHaveProperty('retry_hint');
  });
});
