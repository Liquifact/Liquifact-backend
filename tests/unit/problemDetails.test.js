const formatProblemDetails = require('../../src/utils/problemDetails');

describe('problemDetails Formatter Unit Tests', () => {
  const mockError = {
    type: 'https://example.com/probs/bad-request',
    title: 'Bad Request',
    status: 400,
    detail: 'The provided data is invalid.',
    instance: '/api/v1/resource',
    stack: 'Error at line 1...',
  };

  test('should return a properly formatted object in development', () => {
    const problem = formatProblemDetails({ ...mockError, isProduction: false });

    expect(problem).toEqual({
      type: mockError.type,
      title: mockError.title,
      status: mockError.status,
      detail: mockError.detail,
      instance: mockError.instance,
      stack: mockError.stack,
    });
  });

  test('should hide stack trace when in production', () => {
    const problem = formatProblemDetails({ ...mockError, isProduction: true });

    expect(problem).not.toHaveProperty('stack');
    expect(problem.type).toBe(mockError.type);
    expect(problem.title).toBe(mockError.title);
    expect(problem.status).toBe(mockError.status);
    expect(problem.detail).toBe(mockError.detail);
    expect(problem.instance).toBe(mockError.instance);
  });

  test('should use sensible defaults if fields are missing', () => {
    const problem = formatProblemDetails({});

    expect(problem.type).toBe('about:blank');
    expect(problem.title).toBe('An unexpected error occurred');
    expect(problem.status).toBe(500);
  });
});
