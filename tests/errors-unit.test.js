const test = require('node:test');
const assert = require('node:assert/strict');

const { AppError } = require('../src/errors/AppError');
const { mapError, isBodyParserSyntaxError } = require('../src/errors/mapError');
const { logError } = require('../src/middleware/errorHandler');

test('mapError preserves AppError metadata', () => {
  const mapped = mapError(
    new AppError({
      status: 409,
      code: 'CONFLICT',
      message: 'Conflict happened.',
      retryable: false,
      retryHint: 'Resolve the conflict and try again.',
    }),
  );

  assert.deepEqual(mapped, {
    status: 409,
    code: 'CONFLICT',
    message: 'Conflict happened.',
    retryable: false,
    retryHint: 'Resolve the conflict and try again.',
  });
});

test('mapError recognizes body parser syntax errors', () => {
  const mapped = mapError({
    type: 'entity.parse.failed',
    status: 400,
  });

  assert.equal(mapped.code, 'VALIDATION_ERROR');
  assert.equal(isBodyParserSyntaxError({ type: 'entity.parse.failed', status: 400 }), true);
  assert.equal(isBodyParserSyntaxError({}), false);
});

test('mapError recognizes upstream connection failures', () => {
  const error = new Error('upstream refused');
  error.code = 'ECONNREFUSED';
  const mapped = mapError(error);

  assert.equal(mapped.code, 'UPSTREAM_ERROR');
  assert.equal(mapped.retryable, true);
});

test('mapError sanitizes unknown errors', () => {
  const mapped = mapError(new Error('secret detail'));

  assert.deepEqual(mapped, {
    status: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An internal server error occurred.',
    retryable: false,
    retryHint: 'Do not retry until the issue is resolved or support is contacted.',
  });
});

test('logError handles non-error values safely', () => {
  const messages = [];
  const original = console.error;
  console.error = (value) => messages.push(value);

  try {
    logError('boom', 'req_test123');
  } finally {
    console.error = original;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[req_test123\] Non-error value thrown/);
});
