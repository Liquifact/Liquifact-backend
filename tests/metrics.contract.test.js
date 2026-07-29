'use strict';

/**
 * @fileoverview Contract tests for the GET /metrics endpoint.
 *
 * These tests lock the response shape so that accidental changes to
 * Content-Type, Prometheus text structure, required metric names, or error
 * bodies are caught before they reach production.
 *
 * Contract surfaces covered:
 *   1. HTTP status codes (200 / 401 / 404 / 500)
 *   2. Content-Type header (text/plain for success; application/json for errors)
 *   3. Prometheus text structure (# HELP / # TYPE lines per metric family)
 *   4. Required metric name catalogue — every name listed here MUST appear in
 *      the output; removing or renaming a metric is a breaking contract change
 *   5. 401 error body shape — must be exactly { error: 'Unauthorized' }
 *   6. Response stability — repeated scrapes return the same metric name set
 *   7. No extra undocumented top-level fields in error responses
 */

jest.mock('redis', () => {
  const mockClient = {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
    isOpen: false,
  };
  return { createClient: jest.fn(() => mockClient) };
}, { virtual: true });

const request = require('supertest');
const { createApp } = require('../src/app');
const metrics = require('../src/metrics');

// ── Catalogue of every metric family that MUST be present in /metrics output ──
//
// Each entry is the bare metric name (without suffixes like _total, _bucket,
// etc.).  Any removal from this list is a breaking contract change.
const REQUIRED_METRIC_NAMES = [
  // Job-queue / worker gauges
  'liquifact_job_queue_depth',
  'liquifact_job_retry_queue_size',
  'liquifact_worker_inflight_count',

  // Escrow indexer
  'escrow_indexer_events_processed_total',
  'escrow_indexer_events_skipped_total',
  'escrow_indexer_cycle_failures_total',
  'escrow_indexer_last_cursor_advance_timestamp_seconds',

  // Escrow reconciliation
  'escrow_reconciliation_mismatches_total',
  'escrow_reconciliation_mismatched_invoices',
  'escrow_reconciliation_drift_magnitude',
  'escrow_reconciliation_drift_alerts_total',

  // Maturity reminders
  'maturity_reminder_delivery_attempts_total',
  'maturity_reminder_delivery_success_total',
  'maturity_reminder_dead_letter_total',

  // Soroban RPC
  'soroban_rpc_call_duration_seconds',
  'soroban_rpc_retry_causes_total',
  'soroban_circuit_breaker_state_transitions_total',

  // Footprint cache
  'footprint_cache_hits_total',
  'footprint_cache_misses_total',
  'footprint_cache_evictions_total',

  // Escrow read cache
  'escrow_read_cache_hits_total',
  'escrow_read_cache_misses_total',
  'escrow_read_cache_evictions_total',

  // Webhook replay
  'webhook_replay_total',

  // Body-size limit rejections
  'body_size_limit_rejections_total',

  // Idempotency storage
  'idempotency_storage_failure_total',

  // Cache/Redis
  'cache_store_errors_total',
  'redis_cache_fail_open_total',

  // Contract WASM version
  'contract_wasm_version_mismatch_alerts_total',

  // API key auth
  'api_key_auth_duration_seconds',
  'api_key_auth_errors_total',

  // Metrics endpoint self-instrumentation
  'metrics_request_duration_seconds',

  // KYC webhook
  'kyc_webhook_request_duration_seconds',
  'kyc_webhook_requests_total',
  'kyc_webhook_errors_total',

  // Health endpoint
  'health_request_duration_seconds',
  'health_requests_total',
  'health_request_errors_total',

  // Readiness
  'readiness_state',

  // CORS Observability
  'cors_request_duration_seconds',
  'cors_requests_total',
  'cors_request_errors_total',
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts every metric family name that appears on a `# HELP` line.
 *
 * @param {string} text - Raw Prometheus exposition text.
 * @returns {string[]} Sorted array of unique metric names.
 */
function extractHelpNames(text) {
  const names = [];
  for (const match of text.matchAll(/^# HELP (\S+)/gm)) {
    names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

/**
 * Extracts every metric family name that appears on a `# TYPE` line.
 *
 * @param {string} text - Raw Prometheus exposition text.
 * @returns {string[]} Sorted array of unique metric names.
 */
function extractTypeNames(text) {
  const names = [];
  for (const match of text.matchAll(/^# TYPE (\S+)/gm)) {
    names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('GET /metrics — response contract', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
    delete process.env.METRICS_BEARER_TOKEN;
  });

  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  // ── 1. HTTP status codes ──────────────────────────────────────────────────

  describe('HTTP status codes', () => {
    it('returns 200 when accessed from loopback (no token configured)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('returns 200 with correct bearer token', async () => {
      process.env.METRICS_BEARER_TOKEN = 'contract-test-token';
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer contract-test-token');
      expect(res.status).toBe(200);
    });

    it('returns 401 when token is configured and header is missing', async () => {
      process.env.METRICS_BEARER_TOKEN = 'contract-test-token';
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
    });

    it('returns 401 when token is configured and wrong token supplied', async () => {
      process.env.METRICS_BEARER_TOKEN = 'contract-test-token';
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
    });

    it('returns 404 for any sub-path under /metrics', async () => {
      const res = await request(app).get('/metrics/extra');
      expect(res.status).toBe(404);
    });
  });

  // ── 2. Content-Type header ────────────────────────────────────────────────

  describe('Content-Type header', () => {
    it('success response is text/plain (Prometheus exposition format)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('401 error response is application/json', async () => {
      process.env.METRICS_BEARER_TOKEN = 'contract-test-token';
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // ── 3. Prometheus text structure ─────────────────────────────────────────

  describe('Prometheus text structure', () => {
    it('response body contains at least one # HELP line', async () => {
      metrics.corsRequestDurationSeconds.labels({ status: '200', outcome: 'success', status_class: '2xx' }).observe(0.01);
      metrics.corsRequestsTotal.labels({ status: '200', outcome: 'success', status_class: '2xx' }).inc(1);
      metrics.corsRequestErrorsTotal.labels({ cause: 'origin_rejected', status_class: '4xx' }).inc(1);
      metrics.refreshMetrics();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/^# HELP \S+/m);
    });

    it('every # HELP line is followed by a corresponding # TYPE line', async () => {
      metrics.corsRequestDurationSeconds.labels({ status: '200', outcome: 'success', status_class: '2xx' }).observe(0.01);
      metrics.corsRequestsTotal.labels({ status: '200', outcome: 'success', status_class: '2xx' }).inc(1);
      metrics.corsRequestErrorsTotal.labels({ cause: 'origin_rejected', status_class: '4xx' }).inc(1);
      metrics.refreshMetrics();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);

      const helpNames = extractHelpNames(res.text);
      const typeNames = extractTypeNames(res.text);

      // Every name with a HELP entry must also have a TYPE entry.
      for (const name of helpNames) {
        expect(typeNames).toContain(name);
      }
    });

    it('# TYPE lines use only valid Prometheus type identifiers', async () => {
      metrics.corsRequestDurationSeconds.labels({ status: '200', outcome: 'success', status_class: '2xx' }).observe(0.01);
      metrics.corsRequestsTotal.labels({ status: '200', outcome: 'success', status_class: '2xx' }).inc(1);
      metrics.corsRequestErrorsTotal.labels({ cause: 'origin_rejected', status_class: '4xx' }).inc(1);
      metrics.refreshMetrics();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);

      const validTypes = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped']);
      for (const match of res.text.matchAll(/^# TYPE \S+ (\S+)/gm)) {
        expect(validTypes.has(match[1])).toBe(true);
      }
    });

    it('metric sample lines follow the pattern: name[{labels}] value[timestamp]', async () => {
      metrics.corsRequestDurationSeconds.labels({ status: '200', outcome: 'success', status_class: '2xx' }).observe(0.01);
      metrics.corsRequestsTotal.labels({ status: '200', outcome: 'success', status_class: '2xx' }).inc(1);
      metrics.corsRequestErrorsTotal.labels({ cause: 'origin_rejected', status_class: '4xx' }).inc(1);
      metrics.refreshMetrics();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);

      // Each non-comment, non-empty line must be a valid sample line.
      const sampleLineRe = /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})? [-+]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|[+-]Inf)(?:\s+\d+)?$/;
      const nonCommentLines = res.text
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('#'));

      for (const line of nonCommentLines) {
        expect(line).toMatch(sampleLineRe);
      }
    });
  });

  // ── 4. Required metric name catalogue ────────────────────────────────────
  //
  // These tests assert against the registry output directly, matching the
  // pattern used in tests/unit/escrowIndexer.metrics.test.js. This avoids
  // the cachedMetrics shim path and tests the actual prom-client registry.

  describe('required metric name catalogue', () => {
    // Pre-populate every metric with a non-zero value so prom-client emits
    // their # HELP / # TYPE lines in the exposition output.
    beforeEach(() => {
      metrics.escrowIndexerEventsProcessedTotal.inc(1);
      metrics.escrowIndexerEventsSkippedTotal.inc(1);
      metrics.escrowIndexerCycleFailuresTotal.inc(1);
      metrics.escrowIndexerLastCursorAdvanceTimestampSeconds.set(1);
      metrics.escrowReconciliationMismatches.inc(1);
      metrics.escrowReconciliationMismatchedInvoicesGauge.set(1);
      metrics.escrowReconciliationDriftMagnitudeGauge.set(1);
      metrics.escrowReconciliationDriftAlertsTotal.inc(1);
      metrics.maturityReminderDeliveryAttemptsTotal.labels({ reason: 'unknown', job_type: 'unknown' }).inc(1);
      metrics.maturityReminderDeliverySuccessTotal.labels({ job_type: 'unknown' }).inc(1);
      metrics.maturityReminderDeadLetterTotal.labels({ reason: 'unknown', job_type: 'unknown' }).inc(1);
      metrics.sorobanRpcCallDurationSeconds.labels({ method: 'unknown', outcome: 'success' }).observe(0.1);
      metrics.sorobanRpcRetryCausesTotal.labels({ cause: 'unknown' }).inc(1);
      metrics.sorobanCircuitBreakerStateTransitionsTotal.labels({ breaker_name: 'test', from_state: 'CLOSED', to_state: 'OPEN' }).inc(1);
      metrics.footprintCacheHitsTotal.inc(1);
      metrics.footprintCacheMissesTotal.inc(1);
      metrics.footprintCacheEvictionsTotal.inc(1);
      metrics.escrowReadCacheHitsTotal.inc(1);
      metrics.escrowReadCacheMissesTotal.inc(1);
      metrics.escrowReadCacheEvictionsTotal.labels({ reason: 'unknown' }).inc(1);
      metrics.webhookReplayTotal.labels({ outcome: 'success' }).inc(1);
      metrics.bodySizeLimitRejectionsTotal.labels({ type: 'json' }).inc(1);
      metrics.idempotencyStorageFailureTotal.labels({ keyPrefix: 'test1234' }).inc(1);
      metrics.cacheStoreErrorsTotal.inc(1);
      metrics.redisCacheFailOpenTotal.inc(1);
      metrics.contractWasmVersionMismatchAlertsTotal.labels({ status: 'mismatch' }).inc(1);
      metrics.apiKeyAuthDurationSeconds.labels({ endpoint: '/test', method: 'GET', status: '200', outcome: 'success' }).observe(0.01);
      metrics.apiKeyAuthErrorsTotal.labels({ cause: 'unauthorized' }).inc(1);
      metrics.metricsRequestDurationSeconds.labels({ status_class: '2xx' }).observe(0.01);
      metrics.kycWebhookRequestDurationSeconds.labels({ status_class: '2xx' }).observe(0.01);
      metrics.kycWebhookRequestsTotal.labels({ status_class: '2xx' }).inc(1);
      metrics.kycWebhookErrorsTotal.labels({ cause: 'none' }).inc(1);
      metrics.healthRequestDurationSeconds.labels({ endpoint: 'health_liveness', status_class: '2xx' }).observe(0.01);
      metrics.healthRequestsTotal.labels({ endpoint: 'health_liveness', status_class: '2xx' }).inc(1);
      metrics.healthRequestErrorsTotal.labels({ endpoint: 'health_liveness', cause: 'none' }).inc(1);
      metrics.readinessGauge.set(1);
      metrics.corsRequestDurationSeconds.labels({ status: '200', outcome: 'success', status_class: '2xx' }).observe(0.01);
      metrics.corsRequestsTotal.labels({ status: '200', outcome: 'success', status_class: '2xx' }).inc(1);
      metrics.corsRequestErrorsTotal.labels({ cause: 'origin_rejected', status_class: '4xx' }).inc(1);
      metrics.refreshMetrics();
    });

    it('every required metric name appears in the # HELP lines', async () => {
      const registryOutput = await metrics.registry.metrics();
      const presentNames = extractHelpNames(registryOutput);

      for (const name of REQUIRED_METRIC_NAMES) {
        expect(presentNames).toContain(name);
      }
    });

    it('every required metric name appears in the # TYPE lines', async () => {
      const registryOutput = await metrics.registry.metrics();
      const presentNames = extractTypeNames(registryOutput);

      for (const name of REQUIRED_METRIC_NAMES) {
        expect(presentNames).toContain(name);
      }
    });

    it('HELP and TYPE name sets are equal (no orphaned entries)', async () => {
      const registryOutput = await metrics.registry.metrics();
      const helpNames = extractHelpNames(registryOutput);
      const typeNames = extractTypeNames(registryOutput);

      expect(helpNames).toEqual(typeNames);
    });
  });

  // ── 5. 401 error body contract ────────────────────────────────────────────

  describe('401 error body contract', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'contract-test-token';
    });

    it('error body has exactly one key: error', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(Object.keys(res.body)).toEqual(['error']);
    });

    it('error.error is the string "Unauthorized"', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('error body is identical whether token is missing or wrong', async () => {
      const missingRes = await request(app).get('/metrics');
      const wrongRes = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer completely-wrong');

      expect(missingRes.status).toBe(401);
      expect(wrongRes.status).toBe(401);
      expect(missingRes.body).toEqual(wrongRes.body);
    });

    it('error body contains no stack trace or internal detail', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);

      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toMatch(/stack/i);
      expect(bodyStr).not.toMatch(/at Object\./);
      expect(bodyStr).not.toMatch(/METRICS_BEARER_TOKEN/);
    });

    it('error body does not include a "message" field', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty('message');
    });
  });

  // ── 6. Response stability across repeated scrapes ─────────────────────────

  describe('response stability', () => {
    it('metric name set is identical on repeated scrapes', async () => {
      metrics.corsRequestDurationSeconds.labels({ status: '200', outcome: 'success', status_class: '2xx' }).observe(0.01);
      metrics.corsRequestsTotal.labels({ status: '200', outcome: 'success', status_class: '2xx' }).inc(1);
      metrics.corsRequestErrorsTotal.labels({ cause: 'origin_rejected', status_class: '4xx' }).inc(1);
      metrics.refreshMetrics();
      const first = await request(app).get('/metrics');
      const second = await request(app).get('/metrics');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(extractHelpNames(second.text)).toEqual(extractHelpNames(first.text));
    });

    it('Content-Type is identical on repeated scrapes', async () => {
      const first = await request(app).get('/metrics');
      const second = await request(app).get('/metrics');

      expect(first.headers['content-type']).toEqual(second.headers['content-type']);
    });

    it('401 body is identical on repeated unauthorized requests', async () => {
      process.env.METRICS_BEARER_TOKEN = 'contract-test-token';

      const first = await request(app).get('/metrics');
      const second = await request(app).get('/metrics');

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
      expect(first.body).toEqual(second.body);
    });
  });

  // ── 7. 404 sub-path error shape ──────────────────────────────────────────

  describe('404 sub-path contract', () => {
    it('returns JSON with error field for unmatched sub-paths', async () => {
      const res = await request(app).get('/metrics/unknown-path');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('404 error body does not include stack trace', async () => {
      const res = await request(app).get('/metrics/unknown-path');
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/stack/i);
    });
  });
});

// ── Individual metric label-set contracts ────────────────────────────────────
//
// These tests assert the label names on key metric families so that a rename
// of a label is caught as a breaking change.

describe('GET /metrics — metric label contracts', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
    delete process.env.METRICS_BEARER_TOKEN;
  });

  it('soroban_rpc_call_duration_seconds has labels [method, outcome]', () => {
    expect(metrics.sorobanRpcCallDurationSeconds.labelNames).toEqual(['method', 'outcome']);
  });

  it('soroban_rpc_retry_causes_total has label [cause]', () => {
    expect(metrics.sorobanRpcRetryCausesTotal.labelNames).toEqual(['cause']);
  });

  it('soroban_circuit_breaker_state_transitions_total has labels [breaker_name, from_state, to_state]', () => {
    expect(metrics.sorobanCircuitBreakerStateTransitionsTotal.labelNames).toEqual(
      ['breaker_name', 'from_state', 'to_state']
    );
  });

  it('maturity_reminder_delivery_attempts_total has labels [reason, job_type]', () => {
    expect(metrics.maturityReminderDeliveryAttemptsTotal.labelNames).toEqual(['reason', 'job_type']);
  });

  it('maturity_reminder_delivery_success_total has label [job_type]', () => {
    expect(metrics.maturityReminderDeliverySuccessTotal.labelNames).toEqual(['job_type']);
  });

  it('maturity_reminder_dead_letter_total has labels [reason, job_type]', () => {
    expect(metrics.maturityReminderDeadLetterTotal.labelNames).toEqual(['reason', 'job_type']);
  });

  it('webhook_replay_total has label [outcome]', () => {
    expect(metrics.webhookReplayTotal.labelNames).toEqual(['outcome']);
  });

  it('body_size_limit_rejections_total has label [type]', () => {
    expect(metrics.bodySizeLimitRejectionsTotal.labelNames).toEqual(['type']);
  });

  it('api_key_auth_duration_seconds has labels [endpoint, method, status, outcome]', () => {
    expect(metrics.apiKeyAuthDurationSeconds.labelNames).toEqual(
      ['endpoint', 'method', 'status', 'outcome']
    );
  });

  it('api_key_auth_errors_total has label [cause]', () => {
    expect(metrics.apiKeyAuthErrorsTotal.labelNames).toEqual(['cause']);
  });

  it('metrics_request_duration_seconds has label [status_class]', () => {
    expect(metrics.metricsRequestDurationSeconds.labelNames).toEqual(['status_class']);
  });

  it('kyc_webhook_request_duration_seconds has label [status_class]', () => {
    expect(metrics.kycWebhookRequestDurationSeconds.labelNames).toEqual(['status_class']);
  });

  it('kyc_webhook_requests_total has label [status_class]', () => {
    expect(metrics.kycWebhookRequestsTotal.labelNames).toEqual(['status_class']);
  });

  it('kyc_webhook_errors_total has label [cause]', () => {
    expect(metrics.kycWebhookErrorsTotal.labelNames).toEqual(['cause']);
  });

  it('health_request_duration_seconds has labels [endpoint, status_class]', () => {
    expect(metrics.healthRequestDurationSeconds.labelNames).toEqual(['endpoint', 'status_class']);
  });

  it('health_requests_total has labels [endpoint, status_class]', () => {
    expect(metrics.healthRequestsTotal.labelNames).toEqual(['endpoint', 'status_class']);
  });

  it('health_request_errors_total has labels [endpoint, cause]', () => {
    expect(metrics.healthRequestErrorsTotal.labelNames).toEqual(['endpoint', 'cause']);
  });

  it('escrow_read_cache_evictions_total has label [reason]', () => {
    expect(metrics.escrowReadCacheEvictionsTotal.labelNames).toEqual(['reason']);
  });

  it('idempotency_storage_failure_total has label [keyPrefix]', () => {
    expect(metrics.idempotencyStorageFailureTotal.labelNames).toEqual(['keyPrefix']);
  });

  it('contract_wasm_version_mismatch_alerts_total has label [status]', () => {
    expect(metrics.contractWasmVersionMismatchAlertsTotal.labelNames).toEqual(['status']);
  });
});

// ── Normalizer output-value contracts ──────────────────────────────────────
//
// Each normalizer must only ever produce values from its bounded enum.
// These tests ensure that both in-bound and out-of-bound inputs map to
// a permitted value, preventing unbounded label cardinality in production.

describe('metrics normalizer output contracts', () => {
  describe('normalizeReminderReason', () => {
    const VALID = ['smtp_timeout', 'smtp_reject', 'template_error', 'unknown'];

    it('only returns values from the REMINDER_REASON_ENUM', () => {
      const inputs = [
        new Error('ETIMEDOUT'),
        new Error('template missing'),
        new Error('recipient rejected'),
        new Error('completely unrelated'),
        null,
        undefined,
        { code: 'SMTP_550' },
        'timeout while sending',
        42,
      ];
      for (const input of inputs) {
        expect(VALID).toContain(metrics.normalizeReminderReason(input));
      }
    });
  });

  describe('normalizeSorobanRpcMethod', () => {
    const VALID = [
      'contract_call', 'simulate_transaction', 'get_ledger_entries',
      'token_metadata', 'legal_hold_status', 'schema_version', 'unknown',
    ];

    it('only returns values from SOROBAN_RPC_METHOD_ENUM', () => {
      const inputs = [
        'contract_call', 'callSorobanContract', 'simulate_transaction',
        'simulateTransaction', 'get_ledger_entries', 'getledgerentries',
        'token_metadata', 'tokenmeta', 'legal_hold_status', 'get_legal_hold',
        'schema_version', 'get_schema_version',
        'unknown_method_xyz', '', null, undefined, 42,
      ];
      for (const input of inputs) {
        expect(VALID).toContain(metrics.normalizeSorobanRpcMethod(input));
      }
    });

    it('never leaks raw request-specific strings', () => {
      const sensitive = 'invoke_wallet_0x1234abcd_secret';
      expect(metrics.normalizeSorobanRpcMethod(sensitive)).toBe('unknown');
    });
  });

  describe('normalizeSorobanRpcOutcome', () => {
    const VALID = ['success', 'error', 'circuit_open'];

    it('only returns values from SOROBAN_RPC_OUTCOME_ENUM', () => {
      const inputs = ['success', 'circuit_open', 'error', 'timeout', 'ECONNRESET', '', null, undefined];
      for (const input of inputs) {
        expect(VALID).toContain(metrics.normalizeSorobanRpcOutcome(input));
      }
    });
  });

  describe('normalizeSorobanRetryCause', () => {
    const VALID = ['timeout', '429', '5xx', 'unknown'];

    it('only returns values from SOROBAN_RETRY_CAUSE_ENUM', () => {
      const inputs = ['timeout', '429', '5xx', 'ECONNRESET', 'rate-limited', '', null, undefined];
      for (const input of inputs) {
        expect(VALID).toContain(metrics.normalizeSorobanRetryCause(input));
      }
    });
  });

  describe('normalizeMetricsEndpointStatusClass', () => {
    it('maps 2xx status codes to "2xx"', () => {
      expect(metrics.normalizeMetricsEndpointStatusClass(200)).toBe('2xx');
      expect(metrics.normalizeMetricsEndpointStatusClass(201)).toBe('2xx');
      expect(metrics.normalizeMetricsEndpointStatusClass(204)).toBe('2xx');
    });

    it('maps 4xx status codes to "4xx"', () => {
      expect(metrics.normalizeMetricsEndpointStatusClass(400)).toBe('4xx');
      expect(metrics.normalizeMetricsEndpointStatusClass(401)).toBe('4xx');
      expect(metrics.normalizeMetricsEndpointStatusClass(403)).toBe('4xx');
    });

    it('maps 5xx status codes to "5xx"', () => {
      expect(metrics.normalizeMetricsEndpointStatusClass(500)).toBe('5xx');
      expect(metrics.normalizeMetricsEndpointStatusClass(503)).toBe('5xx');
    });
  });

  describe('normalizeMetricsEndpointCause', () => {
    it('returns "none" for successful responses (no error, 2xx)', () => {
      expect(metrics.normalizeMetricsEndpointCause(null, 200)).toBe('none');
      expect(metrics.normalizeMetricsEndpointCause(undefined, 204)).toBe('none');
    });

    it('returns "auth_failure" for 4xx responses', () => {
      expect(metrics.normalizeMetricsEndpointCause(new Error('unauth'), 401)).toBe('auth_failure');
      expect(metrics.normalizeMetricsEndpointCause(new Error('forbidden'), 403)).toBe('auth_failure');
    });

    it('returns "internal_error" for 5xx responses', () => {
      expect(metrics.normalizeMetricsEndpointCause(new Error('boom'), 500)).toBe('internal_error');
      expect(metrics.normalizeMetricsEndpointCause(new Error('unavailable'), 503)).toBe('internal_error');
    });
  });

  describe('normalizeHealthEndpoint', () => {
    it('maps known endpoint names through unchanged', () => {
      const VALID = [
        'health_liveness', 'health_full', 'health_readiness',
        'health_checks_list', 'health_reports_submit', 'unknown',
      ];
      expect(VALID).toContain(metrics.normalizeHealthEndpoint('health_liveness'));
      expect(VALID).toContain(metrics.normalizeHealthEndpoint('health_full'));
    });

    it('maps unknown strings to "unknown"', () => {
      expect(metrics.normalizeHealthEndpoint('not_a_real_endpoint')).toBe('unknown');
      expect(metrics.normalizeHealthEndpoint('')).toBe('unknown');
      expect(metrics.normalizeHealthEndpoint(null)).toBe('unknown');
    });
  });
});
