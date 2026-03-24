const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_BASE_URL,
  loadLoadTestConfig,
  getLoadScenarios,
  buildAuthHeaders,
  assertSafeBaseUrl,
  parsePositiveInteger,
} = require('./config');

test('loadLoadTestConfig uses safe defaults', () => {
  const config = loadLoadTestConfig({});

  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.durationSeconds, 15);
  assert.equal(config.connections, 10);
  assert.equal(config.timeoutSeconds, 10);
  assert.equal(config.authToken, null);
  assert.equal(config.escrowInvoiceId, 'placeholder-invoice');
});

test('loadLoadTestConfig rejects remote targets by default', () => {
  assert.throws(
    () => loadLoadTestConfig({ LOAD_BASE_URL: 'https://api.example.com' }),
    /Remote load targets are blocked by default/,
  );
});

test('loadLoadTestConfig allows remote targets with explicit opt-in', () => {
  const config = loadLoadTestConfig({
    LOAD_BASE_URL: 'https://api.example.com',
    ALLOW_REMOTE_LOAD_BASELINES: 'true',
  });

  assert.equal(config.baseUrl, 'https://api.example.com');
});

test('getLoadScenarios builds the canonical endpoint set', () => {
  const scenarios = getLoadScenarios({
    authToken: 'secret',
    escrowInvoiceId: 'invoice-123',
  });

  assert.deepEqual(
    scenarios.map((scenario) => scenario.path),
    ['/health', '/api/invoices', '/api/escrow/invoice-123'],
  );
  assert.match(scenarios[1].headers.Authorization, /^Bearer /);
});

test('buildAuthHeaders omits authorization when no token is provided', () => {
  assert.deepEqual(buildAuthHeaders(null), {});
  assert.deepEqual(buildAuthHeaders('abc'), { Authorization: 'Bearer abc' });
});

test('assertSafeBaseUrl accepts local targets', () => {
  assert.doesNotThrow(() => assertSafeBaseUrl('http://127.0.0.1:3001', false));
  assert.doesNotThrow(() => assertSafeBaseUrl('http://localhost:3001', false));
});

test('parsePositiveInteger validates numeric inputs', () => {
  assert.equal(parsePositiveInteger('5', 10, 'VALUE'), 5);
  assert.equal(parsePositiveInteger(undefined, 10, 'VALUE'), 10);
  assert.throws(() => parsePositiveInteger('0', 10, 'VALUE'), /VALUE must be a positive integer/);
  assert.throws(() => parsePositiveInteger('abc', 10, 'VALUE'), /VALUE must be a positive integer/);
});
