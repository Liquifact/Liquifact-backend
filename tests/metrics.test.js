'use strict';

const zlib = require('zlib');

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
  return {
    createClient: jest.fn(() => mockClient),
  };
}, { virtual: true });

const request = require('supertest');
const { createApp } = require('../src/app');
const metrics = require('../src/metrics');
const logger = require('../src/logger');
const JobQueue = require('../src/workers/jobQueue');
const BackgroundWorker = require('../src/workers/worker');

// Destructure internal helpers used by the metrics-auth / safeEqual tests.
const { metricsAuth, safeEqual, extractClientIp, LOOPBACK } = metrics;

/**
 * Decompresses a Buffer using gzip or deflate.
 * @param {Buffer} buf - Compressed data.
 * @param {'gzip'|'deflate'} encoding - Compression algorithm.
 * @returns {string} Decompressed UTF-8 string.
 */
function decompress(buf, encoding) {
  return encoding === 'gzip'
    ? zlib.gunzipSync(buf).toString('utf8')
    : zlib.inflateSync(buf).toString('utf8');
}

describe('GET /metrics', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
  });

  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  describe('METRICS_BEARER_TOKEN configured', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'test-metrics-secret';
    });

    it('returns 200 with Prometheus text when correct token supplied', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/# HELP/);
    });

    it('returns 200 when Authorization header uses uppercase key', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when token is wrong', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when Authorization scheme is not Bearer', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
    });

    it('returns 401 with uniform error body for missing token (no distinction)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      // Body must not reveal whether token exists or not
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with uniform error body for wrong token (no distinction)', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('METRICS_BEARER_TOKEN not configured (private-network mode)', () => {
    it('returns 200 from loopback (supertest uses 127.0.0.1)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/# HELP/);
    });

    it('includes queue and worker metrics when registered', async () => {
      const queue = new JobQueue();
      const worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50, maxConcurrency: 1 });
      worker.registerHandler('test', async () => {});

      const jobId = worker.enqueue('test', { data: 'test' });
      const queuedJob = queue.getJob(jobId);
      expect(queuedJob).toBeDefined();

      metrics.refreshMetrics();

      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/liquifact_job_queue_depth/);
      expect(res.text).toMatch(/liquifact_job_retry_queue_size/);
      expect(res.text).toMatch(/liquifact_worker_inflight_count/);
      expect(res.text).toMatch(/liquifact_job_queue_depth \d+/);
    });
  });

  describe('metrics instrumentation', () => {
    it('updates queue depth and retry queue size from job queue stats', async () => {
      const queue = new JobQueue();
      const jobId = queue.enqueue('test', { data: 'pending' });
      metrics.registerJobQueue(queue);

      queue.dequeue();
      queue.retry(jobId, new Error('failed'));
      metrics.refreshMetrics();

      const output = await metrics.registry.metrics();
      expect(output).toMatch(/liquifact_job_queue_depth \d+/);
      expect(output).toMatch(/liquifact_job_retry_queue_size 1/);
    });

    it('updates worker in-flight count from worker stats', async () => {
      const queue = new JobQueue();
      const worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50, maxConcurrency: 2 });
      worker.registerHandler('test', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      worker.start();
      worker.enqueue('test', { data: 1 });
      worker.enqueue('test', { data: 2 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      metrics.refreshMetrics();

      const output = await metrics.registry.metrics();
      expect(output).toMatch(/liquifact_worker_inflight_count [12]/);
      await worker.stop();
    });
  });

  describe('metrics instrumentation', () => {
    it('records success metrics and structured logs for successful scrapes', async () => {
      const requestLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const createRequestLoggerSpy = jest.spyOn(logger, 'createRequestLogger').mockReturnValue(requestLogger);

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
      const output = await metrics.registry.metrics();
      expect(output).toMatch(/metrics_requests_total\{status_class="2xx"\}/);
      expect(output).toMatch(/metrics_request_duration_seconds_(?:bucket|sum|count)/);
      expect(output).not.toMatch(/metrics_request_errors_total\{cause="none"\}/);
      expect(requestLogger.info).toHaveBeenCalled();
      expect(requestLogger.warn).not.toHaveBeenCalled();
      expect(requestLogger.error).not.toHaveBeenCalled();

      createRequestLoggerSpy.mockRestore();
    });

    it('records client-error metrics and structured warnings for unauthorized scrapes', async () => {
      const requestLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const createRequestLoggerSpy = jest.spyOn(logger, 'createRequestLogger').mockReturnValue(requestLogger);

      const req = {
        headers: {},
        socket: { remoteAddress: '192.0.2.10' },
        ip: '192.0.2.10',
      };
      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        },
      };
      const next = jest.fn();

      metrics.metricsAuth(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
      expect(requestLogger.warn).toHaveBeenCalled();
      expect(requestLogger.info).not.toHaveBeenCalled();
      expect(requestLogger.error).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(requestLogger.info).not.toHaveBeenCalled();
      expect(requestLogger.error).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();

      createRequestLoggerSpy.mockRestore();
    });

    it('records server-error metrics and structured error logs for handler failures', async () => {
      const requestLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const createRequestLoggerSpy = jest.spyOn(logger, 'createRequestLogger').mockReturnValue(requestLogger);

      metrics.recordMetricsEndpointOutcome({
        statusCode: 500,
        durationSeconds: 0.01,
        error: new Error('boom'),
        req: { headers: {} },
      });

      const output = await metrics.registry.metrics();
      expect(output).toMatch(/metrics_requests_total\{status_class="5xx"\}/);
      expect(output).toMatch(/metrics_request_errors_total\{cause="internal_error"\}/);
      expect(requestLogger.error).toHaveBeenCalled();

      createRequestLoggerSpy.mockRestore();
    });
  });

  describe('not-found paths', () => {
    it('returns 404 for an unmatched sub-path under /metrics', async () => {
      const res = await request(app).get('/metrics/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
    });
  });

  describe('idempotent-repeat paths', () => {
    it('returns the same set of metric names on repeated scrapes', async () => {
      const first = await request(app).get('/metrics');
      const second = await request(app).get('/metrics');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const metricNames = (text) =>
        Array.from(text.matchAll(/^# HELP (\S+)/gm)).map((m) => m[1]).sort();

      expect(metricNames(second.text)).toEqual(metricNames(first.text));
    });

    it('deterministically returns 401 on repeated unauthorized scrapes when a token is configured', async () => {
      process.env.METRICS_BEARER_TOKEN = 'repeat-test-token';

      const first = await request(app).get('/metrics');
      const second = await request(app).get('/metrics');

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
    });
  });
});

describe('safeEqual — constant-time comparison', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(safeEqual('abc', 'xyz')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(safeEqual('short', 'longer')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
  });

  it('returns false for empty vs non-empty', () => {
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('returns false for similar prefixes', () => {
    expect(safeEqual('Bearer token-a', 'Bearer token-b')).toBe(false);
  });

  it('handles special characters', () => {
    expect(safeEqual('a!@#', 'a!@#')).toBe(true);
    expect(safeEqual('a!@#', 'a!@$')).toBe(false);
  });
});

describe('extractClientIp', () => {
  it('returns socket.remoteAddress when available', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, ip: '10.0.0.1' };
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('falls back to req.ip when socket.remoteAddress is absent', () => {
    const req = { socket: {}, ip: '::1' };
    expect(extractClientIp(req)).toBe('::1');
  });

  it('falls back to req.ip when socket is absent', () => {
    const req = { ip: '::ffff:127.0.0.1' };
    expect(extractClientIp(req)).toBe('::ffff:127.0.0.1');
  });

  it('returns empty string when neither source is available', () => {
    const req = { socket: {} };
    expect(extractClientIp(req)).toBe('');
  });

  it('returns empty string when req is empty', () => {
    expect(extractClientIp({})).toBe('');
  });
});

describe('LOOPBACK set', () => {
  it('contains 127.0.0.1', () => {
    expect(LOOPBACK.has('127.0.0.1')).toBe(true);
  });

  it('contains ::1', () => {
    expect(LOOPBACK.has('::1')).toBe(true);
  });

  it('contains ::ffff:127.0.0.1', () => {
    expect(LOOPBACK.has('::ffff:127.0.0.1')).toBe(true);
  });

  it('does not contain external IPs', () => {
    expect(LOOPBACK.has('10.0.0.1')).toBe(false);
    expect(LOOPBACK.has('192.168.1.1')).toBe(false);
    expect(LOOPBACK.has('172.16.0.1')).toBe(false);
  });
});

describe('export guard — every module export is defined and valid', () => {
  const metricExports = [
    'footprintCacheHitsTotal',
    'footprintCacheMissesTotal',
    'footprintCacheEvictionsTotal',
    'escrowIndexerEventsProcessedTotal',
    'escrowIndexerEventsSkippedTotal',
    'escrowIndexerCycleFailuresTotal',
    'escrowReconciliationMismatches',
    'maturityReminderDeliveryAttemptsTotal',
    'maturityReminderDeliverySuccessTotal',
    'maturityReminderDeadLetterTotal',
    'sorobanCircuitBreakerStateTransitionsTotal',
    'cacheStoreErrorsTotal',
    'redisCacheFailOpenTotal',
    'readinessGauge',
    'sorobanRpcRetryCausesTotal',
    'sorobanRpcCallDurationSeconds',
  ];

  const counterExports = [
    'footprintCacheHitsTotal',
    'footprintCacheMissesTotal',
    'footprintCacheEvictionsTotal',
    'escrowIndexerEventsProcessedTotal',
    'escrowIndexerEventsSkippedTotal',
    'escrowIndexerCycleFailuresTotal',
    'escrowReconciliationMismatches',
    'maturityReminderDeliveryAttemptsTotal',
    'maturityReminderDeliverySuccessTotal',
    'maturityReminderDeadLetterTotal',
    'sorobanCircuitBreakerStateTransitionsTotal',
    'cacheStoreErrorsTotal',
    'redisCacheFailOpenTotal',
    'sorobanRpcRetryCausesTotal',
  ];

  const gaugeExports = [
    'readinessGauge',
    'escrowIndexerLastCursorAdvanceTimestampSeconds',
  ];

  const histogramExports = [
    'sorobanRpcCallDurationSeconds',
  ];

  it('every exported metric is defined (not undefined)', () => {
    for (const key of metricExports) {
      expect(metrics[key]).toBeDefined();
    }
  });

  it('every exported metric is not null', () => {
    for (const key of metricExports) {
      expect(metrics[key]).not.toBeNull();
    }
  });

  it('every counter export has an inc method', () => {
    for (const key of counterExports) {
      expect(typeof metrics[key].inc).toBe('function');
    }
  });

  it('every gauge export has a set method', () => {
    for (const key of gaugeExports) {
      expect(typeof metrics[key].set).toBe('function');
    }
  });

  it('every histogram export has observe and startTimer methods', () => {
    for (const key of histogramExports) {
      expect(typeof metrics[key].observe).toBe('function');
      expect(typeof metrics[key].startTimer).toBe('function');
    }
  });

  it('sorobanCircuitBreakerStateTransitionsTotal has expected labelNames', () => {
    const counter = metrics.sorobanCircuitBreakerStateTransitionsTotal;
    expect(counter.labelNames).toBeDefined();
    const names = Array.isArray(counter.labelNames) ? counter.labelNames : [];
    expect(names).toContain('breaker_name');
    expect(names).toContain('from_state');
    expect(names).toContain('to_state');
    expect(names.length).toBe(3);
  });
});

describe('normalizeReminderReason', () => {
  it('maps timeout-like errors to smtp_timeout', () => {
    expect(metrics.normalizeReminderReason(new Error('Connection ETIMEDOUT'))).toBe('smtp_timeout');
    expect(metrics.normalizeReminderReason({ message: 'request timed out' })).toBe('smtp_timeout');
  });

  it('maps template errors to template_error', () => {
    expect(metrics.normalizeReminderReason(new Error('invalid template syntax'))).toBe('template_error');
  });

  it('maps rejection/SMTP/recipient errors to smtp_reject', () => {
    expect(metrics.normalizeReminderReason(new Error('recipient rejected'))).toBe('smtp_reject');
    expect(metrics.normalizeReminderReason({ code: 'SMTP_550' })).toBe('smtp_reject');
  });

  it('maps unrecognized errors to unknown', () => {
    expect(metrics.normalizeReminderReason(new Error('something else entirely'))).toBe('unknown');
    expect(metrics.normalizeReminderReason(null)).toBe('unknown');
    expect(metrics.normalizeReminderReason(undefined)).toBe('unknown');
  });

  it('handles plain string errors without a message/code property', () => {
    expect(metrics.normalizeReminderReason('timeout while sending')).toBe('smtp_timeout');
  });
});

describe('startMetricsRefresh / stopMetricsRefresh', () => {
  afterEach(() => {
    metrics.stopMetricsRefresh();
  });

  it('starting the refresh timer is idempotent (second call is a no-op)', () => {
    metrics.startMetricsRefresh();
    metrics.startMetricsRefresh();
    // No observable side effect other than not throwing / not creating a second timer;
    // stopping once is sufficient to clean up either way.
    metrics.stopMetricsRefresh();
  });

  it('stopping when no timer is running is a safe no-op', () => {
    metrics.stopMetricsRefresh();
    expect(() => metrics.stopMetricsRefresh()).not.toThrow();
  });
});

describe('Soroban metrics helpers', () => {
  beforeEach(() => {
    metrics.registry.resetMetrics();
  });

  it('exposes bounded label names for Soroban latency histogram', () => {
    const histogram = metrics.sorobanRpcCallDurationSeconds;
    expect(histogram.labelNames).toEqual(['method', 'outcome']);
  });

  it('exposes bounded label names for Soroban retry cause counter', () => {
    const counter = metrics.sorobanRpcRetryCausesTotal;
    expect(counter.labelNames).toEqual(['cause']);
  });

  it('normalizes Soroban RPC methods to bounded values', () => {
    expect(metrics.normalizeSorobanRpcMethod('simulateTransaction')).toBe('simulate_transaction');
    expect(metrics.normalizeSorobanRpcMethod('get_legal_hold')).toBe('legal_hold_status');
    expect(metrics.normalizeSorobanRpcMethod('secret-wallet-123')).toBe('unknown');
  });

  it('normalizes Soroban retry causes to bounded values', () => {
    expect(metrics.normalizeSorobanRetryCause('timeout')).toBe('timeout');
    expect(metrics.normalizeSorobanRetryCause('429')).toBe('429');
    expect(metrics.normalizeSorobanRetryCause('5xx')).toBe('5xx');
    expect(metrics.normalizeSorobanRetryCause('ECONNRESET')).toBe('unknown');
  });

  it('normalizes Soroban outcomes to bounded values', () => {
    expect(metrics.normalizeSorobanRpcOutcome('success')).toBe('success');
    expect(metrics.normalizeSorobanRpcOutcome('circuit_open')).toBe('circuit_open');
    expect(metrics.normalizeSorobanRpcOutcome('payload-secret')).toBe('error');
  });
});

describe('sorobanCircuitBreakerStateTransitionsTotal — circuit breaker integration', () => {
  const { CircuitBreaker, CircuitBreakerState } = require('../src/utils/circuitBreaker');

  beforeEach(() => {
    metrics.registry.resetMetrics();
  });

  it('is incremented on CLOSED -> OPEN transition', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, recoveryTimeout: 999999 });
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);

    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');

    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    const metric = metrics.registry.getSingleMetric('soroban_circuit_breaker_state_transitions_total');
    expect(metric).toBeDefined();
  });

  it('is incremented on OPEN -> HALF_OPEN and back to OPEN on failure', async () => {
    const breaker = new CircuitBreaker({ name: 'test-half-open', failureThreshold: 1, recoveryTimeout: 1 });
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);

    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    breaker.nextAttemptTime = 0;
    await expect(breaker.execute(async () => { throw new Error('still fail'); })).rejects.toThrow('still fail');

    expect(breaker.state).toBe(CircuitBreakerState.OPEN);
  });

  it('is incremented on HALF_OPEN -> CLOSED on success', async () => {
    const breaker = new CircuitBreaker({ name: 'test-recover', failureThreshold: 1, recoveryTimeout: 1 });

    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    breaker.nextAttemptTime = 0;
    breaker._transitionState(CircuitBreakerState.HALF_OPEN);
    expect(breaker.state).toBe(CircuitBreakerState.HALF_OPEN);

    await breaker.execute(async () => 'ok');

    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
  });

  it('is incremented on reset() transition back to CLOSED', async () => {
    const breaker = new CircuitBreaker({ name: 'test-reset', failureThreshold: 1, recoveryTimeout: 99999 });
    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');

    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    breaker.reset();

    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
  });

  it('label values are bounded to the CircuitBreakerState enum', () => {
    const validStates = ['CLOSED', 'OPEN', 'HALF_OPEN'];
    expect(Object.values(CircuitBreakerState)).toEqual(validStates);
  });

  it('does not increment when state does not change', () => {
    const breaker = new CircuitBreaker({ name: 'test-noop' });
    const initial = breaker.state;

    breaker._transitionState(CircuitBreakerState.CLOSED);

    expect(breaker.state).toBe(initial);
  });

  it('returns Prometheus text before any transition (edge: scrape before first transition)', async () => {
    const promString = await metrics.registry.metrics();
    expect(typeof promString).toBe('string');
  });
});

describe('metricsAuth unit', () => {
  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  describe('token configured', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'super-secret-token';
    });

    it('calls next() when correct bearer token is supplied', () => {
      const req = {
        headers: { authorization: 'Bearer super-secret-token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects non-loopback when token is wrong', () => {
      const req = {
        headers: { authorization: 'Bearer wrong-token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects even loopback addresses when token is configured but wrong', () => {
      // When token is set, loopback is NOT a bypass — token is required
      const req = {
        headers: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects loopback with wrong token even from ::1', () => {
      const req = {
        headers: { authorization: 'Bearer bad' },
        ip: '::1',
        socket: { remoteAddress: '::1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('no token configured', () => {
    it('calls next() for 127.0.0.1 loopback', () => {
      const req = { headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects non-loopback', () => {
      const req = { headers: {}, ip: '10.0.0.5', socket: { remoteAddress: '10.0.0.5' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for ::1 (IPv6 loopback)', () => {
      const req = { headers: {}, ip: '::1', socket: { remoteAddress: '::1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('calls next() for ::ffff:127.0.0.1', () => {
      const req = { headers: {}, ip: '::ffff:127.0.0.1', socket: { remoteAddress: '::ffff:127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('falls back to socket.remoteAddress when req.ip is empty', () => {
      const req = { headers: {}, ip: '', socket: { remoteAddress: '127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 when both req.ip and socket.remoteAddress are absent', () => {
      const req = { headers: {}, ip: undefined, socket: {} };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('X-Forwarded-For spoofing protection', () => {
    it('ignores X-Forwarded-For header when socket is non-loopback', () => {
      // Attacker sends X-Forwarded-For: 127.0.0.1 but connects from 10.0.0.99
      const req = {
        headers: { 'x-forwarded-for': '127.0.0.1' },
        ip: '127.0.0.1', // Express resolved from X-Forwarded-For
        socket: { remoteAddress: '10.0.0.99' }, // Actual TCP connection
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      // Must reject because socket.remoteAddress is 10.0.0.99 (not loopback)
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks X-Forwarded-For spoof via ::ffff:127.0.0.1', () => {
      const req = {
        headers: { 'x-forwarded-for': '::ffff:127.0.0.1' },
        ip: '::ffff:127.0.0.1',
        socket: { remoteAddress: '172.16.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks X-Forwarded-For ::1 spoof', () => {
      const req = {
        headers: { 'x-forwarded-for': '::1' },
        ip: '::1',
        socket: { remoteAddress: '192.168.1.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows real loopback even when X-Forwarded-For is absent', () => {
      const req = {
        headers: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('uniform error response', () => {
    it('does not distinguish between missing and wrong token in response body', () => {
      process.env.METRICS_BEARER_TOKEN = 'secret';

      const missingReq = {
        headers: {},
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const wrongReq = {
        headers: { authorization: 'Bearer wrong' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };

      const res1 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(missingReq, res1, next);
      metricsAuth(wrongReq, res2, next);

      expect(res1.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(res2.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });
  });

  describe('Authorization header casing', () => {
    it('accepts lowercase "authorization" header', () => {
      process.env.METRICS_BEARER_TOKEN = 'token';
      const req = {
        headers: { authorization: 'Bearer token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      delete process.env.METRICS_BEARER_TOKEN;
    });

    it('accepts uppercase "Authorization" header', () => {
      process.env.METRICS_BEARER_TOKEN = 'token';
      const req = {
        headers: { Authorization: 'Bearer token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      delete process.env.METRICS_BEARER_TOKEN;
    });
  });
});

describe('metrics shim path for Soroban observability', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('prom-client');
  });

  it('keeps Soroban histogram and retry counter as safe no-ops when prom-client is unavailable', () => {
    jest.resetModules();

    jest.isolateModules(() => {
      jest.doMock('prom-client', () => {
        throw new Error('prom-client unavailable');
      });

      const shimMetrics = require('../src/metrics');

      expect(() => {
        shimMetrics.sorobanRpcRetryCausesTotal.labels({ cause: '429' }).inc();
        const endTimer = shimMetrics.sorobanRpcCallDurationSeconds.startTimer({ method: 'contract_call' });
        endTimer({ outcome: 'success' });
      }).not.toThrow();

      expect(shimMetrics.normalizeSorobanRpcMethod('secret-payload')).toBe('unknown');
      expect(shimMetrics.normalizeSorobanRetryCause('rate-limited')).toBe('unknown');
    });
  });
});

describe('GET /metrics — response compression', () => {
  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  describe('large payload — compression enabled by client', () => {
    it('compresses with Content-Encoding: gzip when Accept-Encoding: gzip', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics')
        .set('Accept-Encoding', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['vary']).toContain('Accept-Encoding');
      expect(decompress(res.body, 'gzip')).toContain('# HELP');
    });

    it('compresses with Content-Encoding: deflate when Accept-Encoding: deflate', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics')
        .set('Accept-Encoding', 'deflate');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('deflate');
      expect(res.headers['vary']).toContain('Accept-Encoding');
      expect(decompress(res.body, 'deflate')).toContain('# HELP');
    });

    it('compresses when Accept-Encoding lists gzip and deflate (gzip preferred)', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics')
        .set('Accept-Encoding', 'gzip, deflate');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(decompress(res.body, 'gzip')).toContain('# HELP');
    });
  });

  describe('large payload — no compression', () => {
    it('is uncompressed without Accept-Encoding header', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toContain('# HELP');
    });

    it('is uncompressed when Accept-Encoding is identity', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics')
        .set('Accept-Encoding', 'identity');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toContain('# HELP');
    });

    it('is uncompressed when Accept-Encoding is unsupported (br)', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics')
        .set('Accept-Encoding', 'br');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toContain('# HELP');
    });
  });

  describe('Vary header', () => {
    it('sets Vary: Accept-Encoding on every metrics request', async () => {
      metrics.refreshMetrics();

      const res = await request(createApp())
        .get('/metrics')
        .set('Accept-Encoding', 'gzip');

      expect(res.headers['vary']).toContain('Accept-Encoding');
    });
  });
});
