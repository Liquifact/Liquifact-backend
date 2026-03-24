const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/index');
const { parseBearerAuthorizationHeader, tokensMatch } = require('../src/middleware/auth');

const VALID_TOKEN = 'test-suite-token';

/**
 * Build an Authorization header value for security middleware tests.
 *
 * @param {string} token Token to embed after the Bearer scheme.
 * @returns {string}
 */
function buildBearerHeader(token) {
  return `Bearer ${token}`;
}

/**
 * Assert the stable structured error contract returned by middleware failures.
 *
 * @param {import('supertest').Response} response HTTP response object.
 * @param {{ code: string, message: string, retryable: boolean, retryHint: string }} expected Expected error fields.
 * @returns {void}
 */
function assertStructuredError(response, expected) {
  assert.equal(typeof response.body.error, 'object');
  assert.equal(response.body.error.code, expected.code);
  assert.equal(response.body.error.message, expected.message);
  assert.equal(response.body.error.retryable, expected.retryable);
  assert.equal(response.body.error.retry_hint, expected.retryHint);
  assert.match(response.body.error.correlation_id, /^req_[A-Za-z0-9]+$|^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(response.headers['x-correlation-id'], response.body.error.correlation_id);
}

test('protected endpoint rejects requests without Authorization header', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const response = await request(app).get('/__test__/auth');

  assert.equal(response.status, 401);
  assertStructuredError(response, {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication is required for this endpoint.',
    retryable: false,
    retryHint: 'Provide a valid Bearer token and try again.',
  });
});

test('protected endpoint accepts requests with the configured Bearer token', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const response = await request(app)
    .get('/__test__/auth')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('malformed Authorization headers fail safely', async (t) => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const malformedHeaders = [
    '',
    'Bearer',
    'Basic abc123',
    'Bearer token extra',
    'Bearer token,second',
  ];

  await Promise.all(
    malformedHeaders.map((headerValue) =>
      t.test(`header "${headerValue || '<empty>'}" is rejected`, async () => {
        const response = await request(app)
          .get('/__test__/auth')
          .set('Authorization', headerValue);

        assert.equal(response.status, 400);
        assertStructuredError(response, {
          code: 'VALIDATION_ERROR',
          message: 'Authorization header is malformed.',
          retryable: false,
          retryHint: 'Send a Bearer token in the Authorization header and try again.',
        });
      }),
    ),
  );
});

test('invalid or tampered tokens are rejected without leaking internals', async (t) => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const invalidTokens = ['garbage-token', `${VALID_TOKEN}-tampered`, 'BearerInsideToken'];

  await Promise.all(
    invalidTokens.map((token) =>
      t.test(`token "${token}" is rejected`, async () => {
        const response = await request(app)
          .get('/__test__/auth')
          .set('Authorization', buildBearerHeader(token));

        assert.equal(response.status, 401);
        assertStructuredError(response, {
          code: 'INVALID_TOKEN',
          message: 'The provided access token is invalid.',
          retryable: false,
          retryHint: 'Provide a valid Bearer token and try again.',
        });
        assert.equal(JSON.stringify(response.body).includes(VALID_TOKEN), false);
      }),
    ),
  );
});

test('malformed headers on public routes do not block public access', async () => {
  const app = createApp({ enableTestRoutes: true, securityToken: VALID_TOKEN });
  const response = await request(app)
    .get('/health')
    .set('Authorization', 'Basic should-not-matter');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('rate limiter allows initial requests and then blocks abuse with safe headers', async () => {
  const app = createApp({
    enableTestRoutes: true,
    securityToken: VALID_TOKEN,
    securityRateLimitMaxRequests: 2,
    securityRateLimitWindowMs: 60_000,
  });

  const first = await request(app)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const second = await request(app)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const third = await request(app)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));

  assert.equal(first.status, 200);
  assert.equal(first.headers['x-ratelimit-limit'], '2');
  assert.equal(first.headers['x-ratelimit-remaining'], '1');

  assert.equal(second.status, 200);
  assert.equal(second.headers['x-ratelimit-remaining'], '0');

  assert.equal(third.status, 429);
  assertStructuredError(third, {
    code: 'RATE_LIMITED',
    message: 'Too many requests were sent to this endpoint.',
    retryable: true,
    retryHint: 'Wait for the rate-limit window to reset before retrying.',
  });
  assert.equal(third.headers['x-ratelimit-limit'], '2');
  assert.equal(third.headers['x-ratelimit-remaining'], '0');
  assert.match(third.headers['retry-after'], /^\d+$/);
});

test('rate limiter state stays isolated between app instances', async () => {
  const firstApp = createApp({
    enableTestRoutes: true,
    securityToken: VALID_TOKEN,
    securityRateLimitMaxRequests: 1,
    securityRateLimitWindowMs: 60_000,
  });
  const secondApp = createApp({
    enableTestRoutes: true,
    securityToken: VALID_TOKEN,
    securityRateLimitMaxRequests: 1,
    securityRateLimitWindowMs: 60_000,
  });

  const firstResponse = await request(firstApp)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const limitedResponse = await request(firstApp)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));
  const isolatedResponse = await request(secondApp)
    .get('/__test__/rate-limited')
    .set('Authorization', buildBearerHeader(VALID_TOKEN));

  assert.equal(firstResponse.status, 200);
  assert.equal(limitedResponse.status, 429);
  assert.equal(isolatedResponse.status, 200);
});

test('auth parsing helpers normalize and compare tokens safely', () => {
  assert.equal(parseBearerAuthorizationHeader('Bearer abc123'), 'abc123');
  assert.equal(tokensMatch('same-token', 'same-token'), true);
  assert.equal(tokensMatch('same-token', 'different-token'), false);
  assert.equal(tokensMatch('short', 'longer'), false);
});
