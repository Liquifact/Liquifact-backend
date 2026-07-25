const AppError = require('../src/errors/AppError');
const { mapError, isBodyParserSyntaxError } = require('../src/errors/mapError');

describe('httpStatusToCode via mapError (status code extension #616)', () => {
  const cases = [
    { status: 409, code: 'CONFLICT' },
    { status: 422, code: 'UNPROCESSABLE_ENTITY' },
    { status: 429, code: 'TOO_MANY_REQUESTS' },
    { status: 500, code: 'INTERNAL_SERVER_ERROR' },
    { status: 503, code: 'SERVICE_UNAVAILABLE' },
  ];

  describe('AppError with no explicit code resolves via httpStatusToCode', () => {
    it.each(cases)(
      'maps AppError status $status to code $code',
      ({ status, code }) => {
        const mapped = mapError(
          new AppError({
            type: `https://liquifact.com/probs/${code.toLowerCase()}`,
            title: code,
            status,
            detail: 'test detail',
            instance: '/api/test',
          }),
        );
        expect(mapped.status).toBe(status);
        expect(mapped.code).toBe(code);
        expect(mapped.message).toBe('test detail');
      },
    );

    it('still respects an explicit code on AppError over the default mapping', () => {
      const mapped = mapError(
        new AppError({
          type: 'https://liquifact.com/probs/custom',
          title: 'Custom',
          status: 409,
          detail: 'custom conflict',
          instance: '/api/test',
          code: 'DUPLICATE_INVOICE',
        }),
      );
      expect(mapped.code).toBe('DUPLICATE_INVOICE');
    });
  });

  describe('generic (non-AppError) fallback path is status-aware', () => {
    it.each(cases)(
      'maps a generic error with status $status to code $code',
      ({ status, code }) => {
        const error = new Error('generic failure');
        error.status = status;
        const mapped = mapError(error);
        expect(mapped.status).toBe(status);
        expect(mapped.code).toBe(code);
      },
    );

    it('sets retryable=true and a rate-limit hint for 429', () => {
      const error = new Error('rate limited');
      error.status = 429;
      const mapped = mapError(error);
      expect(mapped.retryable).toBe(true);
      expect(mapped.retryHint).toBe(
        'Wait for the rate limit window to reset before retrying.',
      );
    });

    it('sets retryable=true and a retry-shortly hint for a generic 503', () => {
      const error = new Error('service down');
      error.status = 503;
      const mapped = mapError(error);
      expect(mapped.retryable).toBe(true);
      expect(mapped.retryHint).toBe('Retry the request in a few moments.');
    });

    it('sets retryable=false for 409 (conflicts are not retryable as-is)', () => {
      const error = new Error('conflict');
      error.status = 409;
      const mapped = mapError(error);
      expect(mapped.retryable).toBe(false);
    });

    it('sets retryable=false for 422 (validation errors are not retryable as-is)', () => {
      const error = new Error('invalid');
      error.status = 422;
      const mapped = mapError(error);
      expect(mapped.retryable).toBe(false);
    });

    it('sets retryable=false for a generic 500', () => {
      const error = new Error('internal failure');
      error.status = 500;
      const mapped = mapError(error);
      expect(mapped.retryable).toBe(false);
      expect(mapped.message).toBe('An internal server error occurred.');
    });
  });

  describe('existing special-case 503 handling still takes priority', () => {
    it('still maps ECONNREFUSED to UPSTREAM_ERROR, not the generic SERVICE_UNAVAILABLE', () => {
      const error = new Error('upstream refused');
      error.code = 'ECONNREFUSED';
      const mapped = mapError(error);
      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe('UPSTREAM_ERROR');
      expect(mapped.retryable).toBe(true);
    });

    it('still maps CIRCUIT_OPEN to CIRCUIT_OPEN, not the generic SERVICE_UNAVAILABLE', () => {
      const error = new Error('circuit open');
      error.code = 'CIRCUIT_OPEN';
      const mapped = mapError(error);
      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe('CIRCUIT_OPEN');
      expect(mapped.retryable).toBe(true);
    });
  });

  describe('genuinely unmapped statuses still fall back to HTTP_<status>', () => {
    it('maps an unrecognized status like 418 to HTTP_418', () => {
      const error = new Error("I'm a teapot");
      error.status = 418;
      const mapped = mapError(error);
      expect(mapped.code).toBe('HTTP_418');
      expect(mapped.retryable).toBe(false);
    });
  });

  describe('body parser and CORS special cases remain unaffected', () => {
    it('still maps body parser syntax errors to VALIDATION_ERROR at 400', () => {
      const mapped = mapError({ type: 'entity.parse.failed', status: 400 });
      expect(mapped.code).toBe('VALIDATION_ERROR');
      expect(isBodyParserSyntaxError({ type: 'entity.parse.failed', status: 400 })).toBe(true);
    });

    it('still maps CORS rejection to FORBIDDEN at 403', () => {
      const mapped = mapError({ isCorsOriginRejected: true, message: 'blocked' });
      expect(mapped.status).toBe(403);
      expect(mapped.code).toBe('FORBIDDEN');
    });
  });
});

describe('httpStatusToCode direct coverage (pre-existing statuses)', () => {
  const { mapError: _mapError } = require('../src/errors/mapError');
  // Exercised indirectly via mapError's generic fallback path, to close
  // coverage gaps on branches that existed before this change but were
  // never directly tested.
  it.each([
    { status: 400, code: 'BAD_REQUEST' },
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 403, code: 'FORBIDDEN' },
  ])('maps generic error status $status to code $code', ({ status, code }) => {
    const error = new Error('generic');
    error.status = status;
    const mapped = mapError(error);
    expect(mapped.code).toBe(code);
  });

  it('falls back to HTTP_<status> for a second unmapped status (451)', () => {
    const error = new Error('unavailable for legal reasons');
    error.status = 451;
    const mapped = mapError(error);
    expect(mapped.code).toBe('HTTP_451');
  });
});

describe('httpStatusToCode direct coverage — 404', () => {
  it('maps generic error status 404 to code NOT_FOUND', () => {
    const error = new Error('missing');
    error.status = 404;
    const mapped = mapError(error);
    expect(mapped.code).toBe('NOT_FOUND');
  });
});
