const AppError = require('../../src/errors/AppError');

describe('AppError Unit Tests', () => {
  test('should create an AppError instance with correct properties', () => {
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

  test('should use default values if some parameters are missing', () => {
    const error = new AppError({
      title: 'Generic Error',
      detail: 'Something happened',
    });

    expect(error.type).toBe('about:blank'); // RFC 7807 default
    expect(error.status).toBe(500); // Internal Server Error default
    expect(error.title).toBe('Generic Error');
  });

  test('should capture the stack trace correctly', () => {
    const error = new AppError({ title: 'Test Stack', detail: 'testing stack trace' });
    expect(error.stack).toContain('AppError.test.js');
  });

  test('should include extension fields from canonical builder', () => {
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

  test('should have no unexpected properties', () => {
    const error = new AppError({
      type: 'https://liquifact.com/probs/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'Invalid.',
    });

    const ownKeys = Object.getOwnPropertyNames(error).filter(
      (k) => k !== 'stack',
    );
    expect(ownKeys.sort()).toEqual([
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

  test('should not expose retry_hint (snake_case) on the instance', () => {
    const error = new AppError({
      status: 429,
      retryable: true,
      retryHint: 'Wait and retry.',
    });

    expect(error.retryHint).toBe('Wait and retry.');
    expect(error).not.toHaveProperty('retry_hint');
  });
});
