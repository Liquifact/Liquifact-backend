const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp, startServer } = require('../src/index');

/**
 * Assert the standard structured error response shape.
 *
 * @param {import('supertest').Response} response HTTP response.
 * @param {object} expected Expected fields.
 * @returns {void}
 */
function assertStructuredError(response, expected) {
  assert.equal(typeof response.body.error, 'object');
  assert.deepEqual(Object.keys(response.body.error).sort(), [
    'code',
    'correlation_id',
    'message',
    'retry_hint',
    'retryable',
  ]);
  assert.equal(response.body.error.code, expected.code);
  assert.equal(response.body.error.message, expected.message);
  assert.equal(response.body.error.retryable, expected.retryable);
  assert.equal(response.body.error.retry_hint, expected.retryHint);
  assert.match(response.body.error.correlation_id, /^req_[A-Za-z0-9]+$|^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(response.headers['x-correlation-id'], response.body.error.correlation_id);
}

test('unknown route returns structured NOT_FOUND response', async () => {
  const app = createApp();
  const response = await request(app).get('/missing-route');

  assert.equal(response.status, 404);
  assertStructuredError(response, {
    code: 'NOT_FOUND',
    message: 'Route GET /missing-route was not found.',
    retryable: false,
    retryHint: 'Verify the request path and method before trying again.',
  });
});

test('successful routes preserve their existing success shapes', async () => {
  const app = createApp();

  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const apiInfo = await request(app).get('/api');
  assert.equal(apiInfo.status, 200);
  assert.equal(apiInfo.body.endpoints.escrow, 'GET /api/escrow/:invoiceId');

  const invoices = await request(app).get('/api/invoices');
  assert.equal(invoices.status, 200);
  assert.deepEqual(invoices.body.data, []);

  const createInvoice = await request(app).post('/api/invoices').send({});
  assert.equal(createInvoice.status, 201);
  assert.equal(createInvoice.body.data.id, 'placeholder');

  const escrow = await request(app).get('/api/escrow/invoice_123');
  assert.equal(escrow.status, 200);
  assert.equal(escrow.body.data.invoiceId, 'invoice_123');
});

test('malformed JSON returns structured VALIDATION_ERROR response', async () => {
  const app = createApp();
  const response = await request(app)
    .post('/api/invoices')
    .set('Content-Type', 'application/json')
    .send('{"broken":');

  assert.equal(response.status, 400);
  assertStructuredError(response, {
    code: 'VALIDATION_ERROR',
    message: 'Malformed JSON request body.',
    retryable: false,
    retryHint: 'Fix the JSON payload and try again.',
  });
});

test('invoice validation failures return structured VALIDATION_ERROR response', async () => {
  const app = createApp();
  const response = await request(app).post('/api/invoices').send(null);

  assert.equal(response.status, 400);
  assertStructuredError(response, {
    code: 'VALIDATION_ERROR',
    message: 'Invoice payload must be a JSON object.',
    retryable: false,
    retryHint: 'Send a valid JSON object in the request body and try again.',
  });
});

test('escrow validation failures return structured VALIDATION_ERROR response', async () => {
  const app = createApp();
  const response = await request(app).get('/api/escrow/%24');

  assert.equal(response.status, 400);
  assertStructuredError(response, {
    code: 'VALIDATION_ERROR',
    message: 'Invoice ID is invalid.',
    retryable: false,
    retryHint: 'Provide a valid invoice ID and try again.',
  });
});

test('missing auth returns structured AUTHENTICATION_REQUIRED response', async () => {
  const app = createApp({ enableTestRoutes: true });
  const response = await request(app).get('/__test__/auth');

  assert.equal(response.status, 401);
  assertStructuredError(response, {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication is required for this endpoint.',
    retryable: false,
    retryHint: 'Provide valid credentials and try again.',
  });
});

test('authenticated test route keeps success responses intact', async () => {
  const app = createApp({ enableTestRoutes: true });
  const response = await request(app)
    .get('/__test__/auth')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('forbidden access returns structured FORBIDDEN response', async () => {
  const app = createApp({ enableTestRoutes: true });
  const response = await request(app).get('/__test__/forbidden');

  assert.equal(response.status, 403);
  assertStructuredError(response, {
    code: 'FORBIDDEN',
    message: 'You do not have access to this resource.',
    retryable: false,
    retryHint: 'Use an account with the required permissions and try again.',
  });
});

test('upstream failures return structured retryable response', async () => {
  const app = createApp({ enableTestRoutes: true });
  const response = await request(app).get('/__test__/upstream');

  assert.equal(response.status, 503);
  assertStructuredError(response, {
    code: 'UPSTREAM_ERROR',
    message: 'A dependent service is temporarily unavailable.',
    retryable: true,
    retryHint: 'Retry the request in a few moments.',
  });
});

test('unexpected errors are sanitized and do not leak stack details', async () => {
  const app = createApp({ enableTestRoutes: true });
  const response = await request(app).get('/__test__/explode');

  assert.equal(response.status, 500);
  assertStructuredError(response, {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An internal server error occurred.',
    retryable: false,
    retryHint: 'Do not retry until the issue is resolved or support is contacted.',
  });
  assert.equal(JSON.stringify(response.body).includes('Sensitive stack detail'), false);
});

test('non-Error thrown values are normalized safely', async () => {
  const app = createApp({ enableTestRoutes: true });
  const response = await request(app).get('/__test__/throw-string');

  assert.equal(response.status, 500);
  assertStructuredError(response, {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An internal server error occurred.',
    retryable: false,
    retryHint: 'Do not retry until the issue is resolved or support is contacted.',
  });
});

test('valid client correlation IDs are echoed back', async () => {
  const app = createApp();
  const response = await request(app)
    .get('/missing')
    .set('X-Correlation-Id', 'req_clienttrace123');

  assert.equal(response.status, 404);
  assert.equal(response.body.error.correlation_id, 'req_clienttrace123');
  assert.equal(response.headers['x-correlation-id'], 'req_clienttrace123');
});

test('invalid client correlation IDs are replaced with generated IDs', async () => {
  const app = createApp();
  const response = await request(app)
    .get('/missing')
    .set('X-Correlation-Id', 'bad value with spaces');

  assert.equal(response.status, 404);
  assert.notEqual(response.body.error.correlation_id, 'bad value with spaces');
  assert.match(response.body.error.correlation_id, /^req_[A-Za-z0-9]+$/);
});

test('startServer binds and serves requests', async () => {
  const server = startServer(0);

  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
