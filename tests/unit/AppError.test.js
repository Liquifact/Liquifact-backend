'use strict';

const AppError = require('../../src/errors/AppError');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ownFieldKeys(err) {
  return Object.getOwnPropertyNames(err)
    .filter((k) => k !== 'stack')
    .sort();
}

// ---------------------------------------------------------------------------
// Construction — happy path
// ---------------------------------------------------------------------------
describe('AppError — happy-path construction', () => {
  test('creates instance with all explicit fields', () => {
    const error = new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'Resource Not Found',
      status: 404,
      detail: 'The resource could not be found.',
      instance: '/api/resource/123',
      code: 'INVOICE_NOT_FOUND',
      retryable: false,
      retryHint: 'Check the invoice ID and retry.',
    });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.type).toBe('https://liquifact.com/probs/not-found');
    expect(error.title).toBe('Resource Not Found');
    expect(error.status).toBe(404);
    expect(error.detail).toBe('The resource could not be found.');
    expect(error.instance).toBe('/api/resource/123');
    expect(error.code).toBe('INVOICE_NOT_FOUND');
    expect(error.retryable).toBe(false);
    expect(error.retryHint).toBe('Check the invoice ID and retry.');
    expect(error.stack).toBeDefined();
  });

  test('error.message equals title (never the literal "undefined")', () => {
    const error = new AppError({ status: 400, detail: 'bad input' });
    expect(error.message).toBe('Bad Request');
    expect(error.message).not.toBe('undefined');
  });

  test('name is always "AppError"', () => {
    const error = new AppError({ title: 'Test', status: 400 });
    expect(error.name).toBe('AppError');
  });

  test('stack trace points to test file, not constructor internals', () => {
    const error = new AppError({ title: 'Test Stack', detail: 'testing stack trace' });
    expect(error.stack).toContain('AppError.test.js');
  });
});

// ---------------------------------------------------------------------------
// Construction — defaults / coercion
// ---------------------------------------------------------------------------
describe('AppError — defaults and coercion', () => {
  test('missing params object → safe defaults', () => {
    const error = new AppError();
    expect(error.status).toBe(500);
    expect(error.title).toBe('Internal Server Error');
    expect(error.type).toBe('https://liquifact.com/probs/internal-server-error');
    expect(error.retryable).toBe(false);
    expect(error.retryHint).toBe('');
    expect(error.context).toBeNull();
  });

  test('null params → safe defaults (no throw)', () => {
    expect(() => new AppError(null)).not.toThrow();
    const error = new AppError(null);
    expect(error.status).toBe(500);
    expect(typeof error.retryable).toBe('boolean');
  });

  test('undefined params → safe defaults (no throw)', () => {
    expect(() => new AppError(undefined)).not.toThrow();
    const error = new AppError(undefined);
    expect(error.status).toBe(500);
  });

  test('non-object params (string) → safe defaults (no throw)', () => {
    // Passing a primitive should never crash construction
    expect(() => new AppError('bad')).not.toThrow();
    const error = new AppError('bad');
    expect(error.status).toBe(500);
  });

  test('missing type → derived from status, not "about:blank"', () => {
    const error = new AppError({ status: 404 });
    expect(error.type).toBe('https://liquifact.com/probs/not-found');
    expect(error.type).not.toBe('about:blank');
  });

  test('missing title → derived from status', () => {
    const error = new AppError({ status: 403 });
    expect(error.title).toBe('Forbidden');
  });

  test('missing status → 500', () => {
    const error = new AppError({ title: 'Oops' });
    expect(error.status).toBe(500);
  });

  test('status below 100 → clamped to 500', () => {
    const error = new AppError({ status: 0 });
    expect(error.status).toBe(500);
  });

  test('status above 599 → clamped to 500', () => {
    const error = new AppError({ status: 600 });
    expect(error.status).toBe(500);
  });

  test('non-integer status → clamped to 500', () => {
    const error = new AppError({ status: 40.5 });
    expect(error.status).toBe(500);
  });

  test('string status that coerces to a valid integer is accepted', () => {
    // Number('404') === 404, which is in [100, 599] — accepted as a safe
    // convenience so callers that accidentally pass a numeric string still get
    // the correct status rather than a silent 500.
    const error = new AppError({ status: '404' });
    expect(error.status).toBe(404);
  });

  test('non-numeric string status → clamped to 500', () => {
    const error = new AppError({ status: 'bad' });
    expect(error.status).toBe(500);
  });

  test('retryable defaults to boolean false (not undefined)', () => {
    const error = new AppError({ status: 400 });
    expect(error.retryable).toBe(false);
    expect(typeof error.retryable).toBe('boolean');
  });

  test('retryHint defaults to empty string (not undefined)', () => {
    const error = new AppError({ status: 400 });
    expect(error.retryHint).toBe('');
    expect(typeof error.retryHint).toBe('string');
  });

  test('code is excluded when empty/whitespace', () => {
    const error = new AppError({ status: 400, code: '   ' });
    expect(error.code).toBeUndefined();
  });

  test('code is trimmed when present', () => {
    const error = new AppError({ status: 400, code: '  CONFLICT  ' });
    expect(error.code).toBe('CONFLICT');
  });

  test('detail is excluded when not a string', () => {
    const error = new AppError({ status: 400, detail: 42 });
    expect(error.detail).toBeUndefined();
  });

  test('instance is excluded when not a string', () => {
    const error = new AppError({ status: 400, instance: { path: '/x' } });
    expect(error.instance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Construction — fieldErrors
// ---------------------------------------------------------------------------
describe('AppError — fieldErrors', () => {
  test('fieldErrors stored when array', () => {
    const errors = [{ field: 'amount', message: 'Must be positive' }];
    const error = new AppError({ status: 422, fieldErrors: errors });
    expect(error.fieldErrors).toEqual(errors);
  });

  test('fieldErrors excluded when not an array', () => {
    const error = new AppError({ status: 422, fieldErrors: 'bad' });
    expect(error.fieldErrors).toBeUndefined();
  });

  test('fieldErrors excluded when null', () => {
    const error = new AppError({ status: 422, fieldErrors: null });
    expect(error.fieldErrors).toBeUndefined();
  });

  test('fieldErrors included in toJSON', () => {
    const error = new AppError({
      status: 422,
      detail: 'Validation failed.',
      fieldErrors: [{ field: 'amount', message: 'Required' }],
    });
    const json = error.toJSON();
    expect(json.field_errors).toEqual([{ field: 'amount', message: 'Required' }]);
  });
});

// ---------------------------------------------------------------------------
// Construction — context
// ---------------------------------------------------------------------------
describe('AppError — context', () => {
  test('context stored when provided', () => {
    const ctx = { requestId: 'req_123' };
    const error = new AppError({ status: 500, context: ctx });
    expect(error.context).toBe(ctx);
  });

  test('context defaults to null when absent', () => {
    const error = new AppError({ status: 500 });
    expect(error.context).toBeNull();
  });

  test('context NOT included in toJSON', () => {
    const error = new AppError({ status: 500, context: { secret: 'xyz' } });
    const json = error.toJSON();
    expect(json).not.toHaveProperty('context');
  });

  test('context NOT included in toHTTPResponse', () => {
    const error = new AppError({ status: 500, context: { secret: 'xyz' } });
    const response = error.toHTTPResponse('req_abc');
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// toJSON
// ---------------------------------------------------------------------------
describe('AppError — toJSON', () => {
  test('produces RFC 7807 shape', () => {
    const error = new AppError({
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Duplicate invoice.',
      instance: '/api/invoices/1',
      code: 'DUPLICATE_INVOICE',
      retryable: false,
      retryHint: 'Resolve the conflict.',
    });

    expect(error.toJSON()).toEqual({
      type: 'https://liquifact.com/probs/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Duplicate invoice.',
      instance: '/api/invoices/1',
      code: 'DUPLICATE_INVOICE',
      retryable: false,
      retry_hint: 'Resolve the conflict.',
    });
  });

  test('omits optional fields when absent', () => {
    const error = new AppError({ status: 500 });
    const json = error.toJSON();
    expect(json).not.toHaveProperty('detail');
    expect(json).not.toHaveProperty('instance');
    expect(json).not.toHaveProperty('code');
    expect(json).not.toHaveProperty('field_errors');
    // retryHint is falsy (empty string) so retry_hint should be omitted
    expect(json).not.toHaveProperty('retry_hint');
  });

  test('does not include context', () => {
    const error = new AppError({ status: 500, context: { internal: true } });
    expect(error.toJSON()).not.toHaveProperty('context');
  });
});

// ---------------------------------------------------------------------------
// toHTTPResponse
// ---------------------------------------------------------------------------
describe('AppError — toHTTPResponse', () => {
  test('wraps fields in { error: ... } envelope', () => {
    const error = new AppError({
      status: 404,
      detail: 'Not found.',
      code: 'NOT_FOUND',
      retryable: false,
    });

    const response = error.toHTTPResponse('req_xyz');
    expect(response).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not found.',
        correlation_id: 'req_xyz',
        retryable: false,
        retry_hint: '',
      },
    });
  });

  test('derives code from status when no explicit code', () => {
    const error = new AppError({ status: 422, detail: 'Invalid.' });
    const { error: body } = error.toHTTPResponse();
    expect(body.code).toBe('UNPROCESSABLE_ENTITY');
  });

  test('omits correlation_id when not provided', () => {
    const error = new AppError({ status: 500 });
    const { error: body } = error.toHTTPResponse();
    expect(body).not.toHaveProperty('correlation_id');
  });

  test('includes field_errors when present', () => {
    const error = new AppError({
      status: 422,
      fieldErrors: [{ field: 'x', message: 'Required' }],
    });
    const { error: body } = error.toHTTPResponse();
    expect(body.field_errors).toEqual([{ field: 'x', message: 'Required' }]);
  });
});

// ---------------------------------------------------------------------------
// AppError.is — type guard
// ---------------------------------------------------------------------------
describe('AppError.is — type guard', () => {
  test('returns true for AppError instances', () => {
    expect(AppError.is(new AppError({ status: 400 }))).toBe(true);
  });

  test('returns true for deserialized objects with name "AppError"', () => {
    expect(AppError.is({ name: 'AppError', status: 400 })).toBe(true);
  });

  test('returns false for plain Error', () => {
    expect(AppError.is(new Error('boom'))).toBe(false);
  });

  test('returns false for null', () => {
    expect(AppError.is(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(AppError.is(undefined)).toBe(false);
  });

  test('returns false for primitive string', () => {
    expect(AppError.is('error string')).toBe(false);
  });

  test('returns false for plain object without name', () => {
    expect(AppError.is({ status: 400 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Static factory helpers
// ---------------------------------------------------------------------------
describe('AppError — static factory helpers', () => {
  const cases = [
    { factory: 'badRequest', status: 400, detail: 'Bad.' },
    { factory: 'unauthorized', status: 401, detail: 'Auth required.' },
    { factory: 'forbidden', status: 403, detail: 'Forbidden.' },
    { factory: 'notFound', status: 404, detail: 'Not found.' },
    { factory: 'conflict', status: 409, detail: 'Conflict.' },
    { factory: 'unprocessable', status: 422, detail: 'Unprocessable.' },
    { factory: 'internal', status: 500, detail: 'Internal.' },
  ];

  test.each(cases)(
    'AppError.$factory creates status $status with detail',
    ({ factory, status, detail }) => {
      const error = AppError[factory](detail);
      expect(error).toBeInstanceOf(AppError);
      expect(error.status).toBe(status);
      expect(error.detail).toBe(detail);
    },
  );

  test('tooManyRequests sets retryable=true and a retry hint', () => {
    const error = AppError.tooManyRequests('Rate limited.');
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.retryHint).toBeTruthy();
  });

  test('serviceUnavailable sets retryable=true and a retry hint', () => {
    const error = AppError.serviceUnavailable('Down.');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.retryHint).toBeTruthy();
  });

  test('factory extras are merged correctly', () => {
    const error = AppError.notFound('Not found.', { code: 'INVOICE_NOT_FOUND' });
    expect(error.code).toBe('INVOICE_NOT_FOUND');
    expect(error.status).toBe(404);
  });

  test('factory without detail produces meaningful message', () => {
    const error = AppError.badRequest();
    expect(error.message).not.toBe('undefined');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AppError.wrap
// ---------------------------------------------------------------------------
describe('AppError.wrap', () => {
  test('wraps an unknown error into an AppError', () => {
    const cause = new Error('database failure');
    const wrapped = AppError.wrap(cause);
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.status).toBe(500);
    expect(wrapped.context).toBe(cause);
  });

  test('returns the original AppError unchanged', () => {
    const original = AppError.notFound('Not found.');
    const wrapped = AppError.wrap(original);
    expect(wrapped).toBe(original);
  });

  test('wraps a null cause safely', () => {
    const wrapped = AppError.wrap(null);
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.context).toBeNull();
  });

  test('wraps a string cause safely', () => {
    const wrapped = AppError.wrap('crash');
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.context).toBe('crash');
  });

  test('extras override defaults', () => {
    const wrapped = AppError.wrap(new Error('x'), {
      status: 503,
      detail: 'Upstream failed.',
      retryable: true,
    });
    expect(wrapped.status).toBe(503);
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.detail).toBe('Upstream failed.');
  });
});

// ---------------------------------------------------------------------------
// Well-known constant
// ---------------------------------------------------------------------------
describe('AppError — constants', () => {
  test('FENCING_TOKEN_REJECTED is defined', () => {
    expect(AppError.FENCING_TOKEN_REJECTED).toBe('FENCING_TOKEN_REJECTED');
  });
});

// ---------------------------------------------------------------------------
// Own-key snapshot (regression guard)
// ---------------------------------------------------------------------------
describe('AppError — own-key snapshot', () => {
  test('minimal error has expected set of own keys', () => {
    const error = new AppError({ status: 400, detail: 'Invalid.' });
    // detail is set; code / instance / fieldErrors absent
    expect(ownFieldKeys(error)).toEqual([
      'context',
      'detail',
      'message',
      'name',
      'retryHint',
      'retryable',
      'status',
      'title',
      'type',
    ]);
  });

  test('full error adds code, instance, fieldErrors', () => {
    const error = new AppError({
      status: 422,
      code: 'VALIDATION_ERROR',
      detail: 'Bad.',
      instance: '/api/x',
      fieldErrors: [{ field: 'x', message: 'Required' }],
    });
    expect(ownFieldKeys(error)).toEqual([
      'code',
      'context',
      'detail',
      'fieldErrors',
      'instance',
      'message',
      'name',
      'retryHint',
      'retryable',
      'status',
      'title',
      'type',
    ]);
  });

  test('retry_hint (snake_case) is NOT an own property', () => {
    const error = new AppError({ status: 429, retryable: true, retryHint: 'Wait.' });
    expect(error).not.toHaveProperty('retry_hint');
    expect(error.retryHint).toBe('Wait.');
  });
});

// ---------------------------------------------------------------------------
// Boundary: concurrent construction
// ---------------------------------------------------------------------------
describe('AppError — concurrent construction is safe', () => {
  test('1000 concurrent AppErrors each have independent state', () => {
    const errors = Array.from({ length: 1000 }, (_, i) =>
      new AppError({ status: 400 + (i % 200), detail: `error-${i}` }),
    );

    for (let i = 0; i < errors.length; i++) {
      const expected = 400 + (i % 200);
      const safeExpected =
        expected >= 100 && expected <= 599 ? expected : 500;
      expect(errors[i].status).toBe(safeExpected);
      expect(errors[i].detail).toBe(`error-${i}`);
    }
  });

  describe('State invariants (v1.0)', () => {
    test('rejects invalid status codes - non-number', () => {
      expect(() => new AppError({ title: 'Test', status: '400' })).toThrow(TypeError);
      expect(() => new AppError({ title: 'Test', status: null })).toThrow(TypeError);
    });

    test('rejects invalid status codes - out of range', () => {
      expect(() => new AppError({ title: 'Test', status: 99 })).toThrow(RangeError);
      expect(() => new AppError({ title: 'Test', status: 600 })).toThrow(RangeError);
      expect(() => new AppError({ title: 'Test', status: 3.5 })).toThrow(RangeError);
    });

    test('rejects invalid type - non-string', () => {
      expect(() => new AppError({ title: 'Test', type: 123 })).toThrow(TypeError);
      expect(() => new AppError({ title: 'Test', type: null })).toThrow(TypeError);
      expect(() => new AppError({ title: 'Test', type: {} })).toThrow(TypeError);
    });

    test('instance is frozen - prevents property mutation', () => {
      const error = new AppError({
        title: 'Test',
        status: 404,
        detail: 'Not found',
      });

      expect(Object.isFrozen(error)).toBe(true);

      // Attempting to mutate should fail silently in non-strict mode
      // but the property should not actually change
      error.status = 500;
      expect(error.status).toBe(404);

      error.detail = 'Changed';
      expect(error.detail).toBe('Not found');
    });

    test('accepts valid status codes within range', () => {
      const error100 = new AppError({ title: 'Test', status: 100 });
      expect(error100.status).toBe(100);

      const error599 = new AppError({ title: 'Test', status: 599 });
      expect(error599.status).toBe(599);

      const error404 = new AppError({ title: 'Test', status: 404 });
      expect(error404.status).toBe(404);
    });

    test('accepts valid string type', () => {
      const error = new AppError({
        title: 'Test',
        type: 'https://example.com/error',
      });
      expect(error.type).toBe('https://example.com/error');
    });

    test('allows retryable without retryHint (logs warning)', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const error = new AppError({
        title: 'Test',
        status: 429,
        retryable: true,
      });

      expect(error.retryable).toBe(true);
      expect(error.retryHint).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith('[AppError] retryable=true without retryHint is discouraged');

      consoleWarnSpy.mockRestore();
    });

    test('does not warn when retryable has retryHint', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const error = new AppError({
        title: 'Test',
        status: 429,
        retryable: true,
        retryHint: 'Wait 5 seconds',
      });

      expect(error.retryable).toBe(true);
      expect(error.retryHint).toBe('Wait 5 seconds');
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });
});
