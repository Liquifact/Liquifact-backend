/**
 * AppError validation-boundary tests (issue #1367).
 *
 * `AppError` is the error type every route funnels through the RFC 7807
 * middleware, so its constructor is a trust boundary: whatever it accepts will
 * eventually be handed to `res.status(...)` and serialised to clients. These
 * tests pin the boundary itself —
 *
 *   - what a caller may supply (valid, minimal, boundary statuses),
 *   - what is rejected and with which error type,
 *   - that rejection messages stay diagnosable without echoing the offending
 *     value (an object passed by mistake may hold a secret),
 *   - that a genuinely defaulted error keeps its defaults instead of quietly
 *     becoming a validation failure.
 *
 * @jest-environment node
 */

'use strict';

const AppError = require('../../src/errors/AppError');

describe('AppError constructor validation boundary', () => {
  describe('accepted input', () => {
    it('accepts a complete problem-details object', () => {
      const error = new AppError({
        type: 'https://liquifact.com/probs/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: 'The request body is malformed.',
        instance: '/api/invoices',
        code: 'VALIDATION_ERROR',
        retryable: false,
        retryHint: '',
        fieldErrors: { amount: 'must be positive' },
      });

      expect(error).toBeInstanceOf(AppError);
      expect(error.status).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.fieldErrors).toEqual({ amount: 'must be positive' });
    });

    it('accepts an empty object and applies canonical defaults', () => {
      const error = new AppError({});

      expect(error.type).toBe('about:blank');
      expect(error.status).toBe(500);
      expect(error.title).toBe('An unexpected error occurred');
    });

    it('accepts both ends of the allowed status range', () => {
      expect(new AppError({ status: 400 }).status).toBe(400);
      expect(new AppError({ status: 599 }).status).toBe(599);
    });

    it('accepts the non-standard-but-real statuses used by this codebase', () => {
      // 423 = legal hold, 429 = rate limited. Both are produced by existing
      // callers (fundingErrors, rate-limit middleware) and must keep working.
      expect(new AppError({ status: 423 }).status).toBe(423);
      expect(new AppError({ status: 429 }).status).toBe(429);
      expect(new AppError({ status: 502 }).status).toBe(502);
    });

    it('accepts an own property whose value is undefined (treated as absent)', () => {
      // `status: undefined` must behave exactly like omitting the key, which is
      // what the shared `mapError` defaulting helpers rely on.
      const withUndefined = new AppError({ status: undefined, title: 'x' });
      const withoutKey = new AppError({ title: 'x' });

      expect(withUndefined.status).toBe(withoutKey.status);
      expect(withUndefined.status).toBe(500);
    });

    it('accepts a numeric status derived from another error (status || 400 pattern)', () => {
      const upstream = { status: 409 };
      expect(new AppError({ status: upstream.status || 400 }).status).toBe(409);
      expect(new AppError({ status: undefined || 400 }).status).toBe(400);
    });

    it('keeps the error name stable so name-based checks still match', () => {
      expect(new AppError({}).name).toBe('AppError');
    });
  });

  describe('rejected input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'Bad Request'],
      ['a number', 404],
      ['a boolean', true],
      ['an array', [400]],
      ['a function', () => {}],
    ])('rejects %s as the params object', (_label, params) => {
      expect(() => new AppError(params)).toThrow(TypeError);
    });

    it('rejects out-of-range statuses', () => {
      // Below the error range: a 2xx/3xx is not a failure, so accepting it here
      // would let a success code reach the error middleware.
      expect(() => new AppError({ status: 200 })).toThrow(TypeError);
      expect(() => new AppError({ status: 399 })).toThrow(TypeError);
      expect(() => new AppError({ status: 600 })).toThrow(TypeError);
      expect(() => new AppError({ status: 0 })).toThrow(TypeError);
      expect(() => new AppError({ status: -1 })).toThrow(TypeError);
    });

    it('rejects non-integer statuses', () => {
      expect(() => new AppError({ status: 404.5 })).toThrow(TypeError);
      expect(() => new AppError({ status: Number.NaN })).toThrow(TypeError);
      expect(() => new AppError({ status: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    });

    it('rejects a numeric-looking status string instead of coercing it', () => {
      expect(() => new AppError({ status: '404' })).toThrow(TypeError);
      expect(() => new AppError({ status: '500' })).toThrow(TypeError);
    });

    it('rejects a null status (null is not a meaningful status)', () => {
      expect(() => new AppError({ status: null })).toThrow(TypeError);
    });

    it.each([
      'type',
      'title',
      'detail',
      'instance',
      'code',
      'retryHint',
    ])('rejects a non-string %s', (field) => {
      expect(() => new AppError({ [field]: 42 })).toThrow(TypeError);
      expect(() => new AppError({ [field]: { nested: true } })).toThrow(TypeError);
      expect(() => new AppError({ [field]: ['a'] })).toThrow(TypeError);
    });

    it('rejects a non-boolean retryable', () => {
      expect(() => new AppError({ retryable: 'true' })).toThrow(TypeError);
      expect(() => new AppError({ retryable: 1 })).toThrow(TypeError);
    });

    it('rejects non-object fieldErrors', () => {
      expect(() => new AppError({ fieldErrors: 'amount is invalid' })).toThrow(TypeError);
      expect(() => new AppError({ fieldErrors: ['amount is invalid'] })).toThrow(TypeError);
      expect(() => new AppError({ fieldErrors: null })).toThrow(TypeError);
    });

    it('throws TypeError specifically, so callers can branch on it', () => {
      expect(() => new AppError(null)).toThrow(TypeError);
      expect(() => new AppError({ status: 200 })).toThrow(TypeError);
      expect(() => new AppError({ detail: 7 })).toThrow(TypeError);
    });
  });

  describe('diagnostics without leaking values', () => {
    it('names the offending field in the message', () => {
      expect(() => new AppError({ status: 200 })).toThrow(/status/);
      expect(() => new AppError({ detail: 7 })).toThrow(/detail/);
      expect(() => new AppError({ retryable: 'yes' })).toThrow(/retryable/);
      expect(() => new AppError({ fieldErrors: [] })).toThrow(/fieldErrors/);
    });

    it('reports an out-of-range status with the accepted range', () => {
      expect(() => new AppError({ status: 302 })).toThrow(/400/);
      expect(() => new AppError({ status: 302 })).toThrow(/599/);
    });

    it('does not echo an object value into the message', () => {
      // A caller that forgets to stringify may pass credentials by accident;
      // the rejection must not copy them into a message or a log line.
      const leak = { apiKey: 'sk-live-do-not-log', token: 'ghp_secret' };
      let message = '';
      try {
        new AppError({ title: 'Bad Request', detail: leak });
      } catch (err) {
        message = err.message;
      }
      expect(message).not.toMatch(/sk-live-do-not-log/);
      expect(message).not.toMatch(/ghp_secret/);
      expect(message).toMatch(/object/);
    });

    it('reports a string argument by shape without echoing its content', () => {
      expect(() => new AppError('Bearer super-secret-token')).toThrow(/string/);
      expect(() => new AppError('Bearer super-secret-token')).not.toThrow(/super-secret-token/);
    });

    it('reports the length of a string supplied where a number is required', () => {
      // `describeValue` must not echo the value, but the length still gives the
      // caller enough detail to locate the mistake.
      expect(() => new AppError({ status: '404' })).toThrow(/3 characters/);
    });

    it('distinguishes an empty string from a populated one', () => {
      expect(() => new AppError({ status: '' })).toThrow(/an empty string/);
    });

    it('describes a non-string in a string field by type', () => {
      expect(() => new AppError({ detail: 42 })).toThrow(/a number/);
      expect(() => new AppError({ code: false })).toThrow(/a boolean/);
    });
  });

  describe('fieldErrors property presence', () => {
    it('is not an own property when the caller omits it', () => {
      const error = new AppError({ status: 400, title: 'Bad Request' });

      expect(Object.prototype.hasOwnProperty.call(error, 'fieldErrors')).toBe(false);
      expect(error.fieldErrors).toBeUndefined();
      expect('fieldErrors' in error).toBe(false);
    });

    it('is an own property when the caller supplies it', () => {
      const fieldErrors = { amount: 'must be positive' };
      const error = new AppError({ status: 422, fieldErrors });

      expect(Object.prototype.hasOwnProperty.call(error, 'fieldErrors')).toBe(true);
      expect(error.fieldErrors).toBe(fieldErrors);
    });

    it('keeps the documented own-property surface free of phantom keys', () => {
      const ownKeys = Object.getOwnPropertyNames(
        new AppError({ status: 400, title: 'Bad Request' }),
      )
        .filter((key) => key !== 'stack')
        .sort();

      expect(ownKeys).toEqual([
        'code',
        'context',
        'detail',
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

    it('still exposes snake_case retry_hint nowhere on the instance', () => {
      const error = new AppError({ status: 429, retryable: true, retryHint: 'Wait and retry.' });

      expect(error.retryHint).toBe('Wait and retry.');
      expect(error).not.toHaveProperty('retry_hint');
    });
  });

  describe('determinism', () => {
    it('produces identical fields for identical input on repeated construction', () => {
      const params = {
        type: 'https://liquifact.com/probs/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'Version mismatch.',
        code: 'CONFLICT',
        retryable: false,
      };

      const first = new AppError(params);
      const second = new AppError(params);

      expect(first.status).toBe(second.status);
      expect(first.type).toBe(second.type);
      expect(first.code).toBe(second.code);
      expect(first.message).toBe(second.message);
    });

    it('does not mutate the caller-supplied params object', () => {
      const params = { status: 400, title: 'Bad Request', detail: 'Broken.' };
      const snapshot = { ...params };

      new AppError(params);

      expect(params).toEqual(snapshot);
    });

    it('rejects invalid input before allocating a partially-built error', () => {
      // Validation happens ahead of `super()`, so a failed construction cannot
      // hand a half-initialised AppError to a caller's catch block.
      let caught;
      try {
        new AppError({ status: 999 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught).not.toBeInstanceOf(AppError);
    });
  });

  describe('exported range constants', () => {
    it('exposes the validated status bounds for callers and tests', () => {
      expect(AppError.MIN_ERROR_STATUS).toBe(400);
      expect(AppError.MAX_ERROR_STATUS).toBe(599);
    });
  });
});
