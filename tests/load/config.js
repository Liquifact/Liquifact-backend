const path = require('path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_DURATION_SECONDS = 15;
const DEFAULT_CONNECTIONS = 10;
const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_ESCROW_INVOICE_ID = 'placeholder-invoice';

/**
 * Resolve load test runtime configuration from environment variables.
 *
 * The suite is intentionally safe-by-default and will reject remote targets
 * unless explicitly approved through `ALLOW_REMOTE_LOAD_BASELINES=true`.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment values.
 * @returns {object}
 */
function loadLoadTestConfig(env = process.env) {
  const baseUrl = env.LOAD_BASE_URL || DEFAULT_BASE_URL;
  assertSafeBaseUrl(baseUrl, env.ALLOW_REMOTE_LOAD_BASELINES === 'true');

  const durationSeconds = parsePositiveInteger(
    env.LOAD_DURATION_SECONDS,
    DEFAULT_DURATION_SECONDS,
    'LOAD_DURATION_SECONDS',
  );
  const connections = parsePositiveInteger(
    env.LOAD_CONNECTIONS,
    DEFAULT_CONNECTIONS,
    'LOAD_CONNECTIONS',
  );
  const timeoutSeconds = parsePositiveInteger(
    env.LOAD_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    'LOAD_TIMEOUT_SECONDS',
  );

  return {
    baseUrl,
    durationSeconds,
    connections,
    timeoutSeconds,
    reportDir: path.resolve(env.LOAD_REPORT_DIR || path.join('tests', 'load', 'reports')),
    authToken: env.LOAD_AUTH_TOKEN || null,
    escrowInvoiceId: env.LOAD_ESCROW_INVOICE_ID || DEFAULT_ESCROW_INVOICE_ID,
  };
}

/**
 * Return the endpoint definitions used for the core baseline suite.
 *
 * @param {object} config Load test configuration.
 * @returns {Array<{name: string, method: string, path: string, headers: object, body?: string}>}
 */
function getLoadScenarios(config) {
  const authHeaders = buildAuthHeaders(config.authToken);

  return [
    {
      name: 'health',
      method: 'GET',
      path: '/health',
      headers: {},
    },
    {
      name: 'invoices-list',
      method: 'GET',
      path: '/api/invoices',
      headers: authHeaders,
    },
    {
      name: 'escrow-read',
      method: 'GET',
      path: `/api/escrow/${encodeURIComponent(config.escrowInvoiceId)}`,
      headers: authHeaders,
    },
  ];
}

/**
 * Build optional authorization headers without logging or exposing the token.
 *
 * @param {string|null} token Optional bearer token.
 * @returns {Record<string, string>}
 */
function buildAuthHeaders(token) {
  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Reject remote base URLs unless explicit opt-in is set.
 *
 * @param {string} baseUrl Candidate base URL.
 * @param {boolean} allowRemote Whether remote execution is explicitly allowed.
 * @returns {void}
 */
function assertSafeBaseUrl(baseUrl, allowRemote) {
  const parsed = new URL(baseUrl);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const isLocal = localHosts.has(parsed.hostname);

  if (!isLocal && !allowRemote) {
    throw new Error(
      'Remote load targets are blocked by default. Set ALLOW_REMOTE_LOAD_BASELINES=true to continue.',
    );
  }
}

/**
 * Parse a positive integer environment variable with a default fallback.
 *
 * @param {string|undefined} rawValue Raw environment variable.
 * @param {number} fallback Default value.
 * @param {string} name Variable name for error messages.
 * @returns {number}
 */
function parsePositiveInteger(rawValue, fallback, name) {
  if (rawValue == null || rawValue === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

module.exports = {
  DEFAULT_BASE_URL,
  loadLoadTestConfig,
  getLoadScenarios,
  buildAuthHeaders,
  assertSafeBaseUrl,
  parsePositiveInteger,
};
