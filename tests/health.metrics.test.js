'use strict';

const express = require('express');
const request = require('supertest');
const { instrumentHealth, recordHealthOutcome } = require('../src/middleware/healthMetrics');
const metrics = require('../src/metrics');

/** Reads a single counter value for a label set (real prom-client, async get). */
async function counterValue(counter, labels) {
  const metric = await counter.get();
  const keys = Object.keys(labels);
  const match = (metric.values || []).find((v) =>
    keys.every((k) => String(v.labels[k]) === String(labels[k])),
  );
  return match ? match.value : 0;
}

describe('health metrics instrumentation', () => {
  beforeEach(() => {
    metrics.healthRequestDurationSeconds.reset();
    metrics.healthRequestsTotal.reset();
    metrics.healthRequestErrorsTotal.reset();
  });

  describe('normalizeHealthStatusClass', () => {
    it('maps 2xx, 4xx, 5xx correctly', () => {
      expect(metrics.normalizeHealthStatusClass(200)).toBe('2xx');
      expect(metrics.normalizeHealthStatusClass(201)).toBe('2xx');
      expect(metrics.normalizeHealthStatusClass(400)).toBe('4xx');
      expect(metrics.normalizeHealthStatusClass(404)).toBe('4xx');
      expect(metrics.normalizeHealthStatusClass(503)).toBe('5xx');
      expect(metrics.normalizeHealthStatusClass(500)).toBe('5xx');
      expect(metrics.normalizeHealthStatusClass('200')).toBe('2xx');
    });
  });

  describe('normalizeHealthEndpoint', () => {
    it('passes known endpoints', () => {
      expect(metrics.normalizeHealthEndpoint('health_liveness')).toBe('health_liveness');
      expect(metrics.normalizeHealthEndpoint('health_full')).toBe('health_full');
      expect(metrics.normalizeHealthEndpoint('health_readiness')).toBe('health_readiness');
      expect(metrics.normalizeHealthEndpoint('health_checks_list')).toBe('health_checks_list');
      expect(metrics.normalizeHealthEndpoint('health_reports_submit')).toBe('health_reports_submit');
    });

    it('collapses unknown endpoints to unknown', () => {
      expect(metrics.normalizeHealthEndpoint('nope')).toBe('unknown');
      expect(metrics.normalizeHealthEndpoint('')).toBe('unknown');
      expect(metrics.normalizeHealthEndpoint(42)).toBe('unknown');
      expect(metrics.normalizeHealthEndpoint(null)).toBe('unknown');
    });
  });

  describe('normalizeHealthCause', () => {
    it('returns none for success (no error, 2xx)', () => {
      expect(metrics.normalizeHealthCause(null, 200)).toBe('none');
      expect(metrics.normalizeHealthCause(undefined, 201)).toBe('none');
    });

    it('maps 4xx to validation', () => {
      expect(metrics.normalizeHealthCause(null, 400)).toBe('validation');
      expect(metrics.normalizeHealthCause({ message: 'invalid' }, 400)).toBe('validation');
      expect(metrics.normalizeHealthCause({ message: 'bad request' }, 404)).toBe('validation');
    });

    it('maps timeout-like errors to timeout', () => {
      expect(metrics.normalizeHealthCause({ code: 'ETIMEDOUT' }, 500)).toBe('timeout');
      expect(metrics.normalizeHealthCause({ code: 'ECONNABORTED' }, 500)).toBe('timeout');
      expect(metrics.normalizeHealthCause({ code: 'ABORT_ERR' }, 500)).toBe('timeout');
      expect(metrics.normalizeHealthCause({ message: 'Connection timed out' }, 500)).toBe('timeout');
      expect(metrics.normalizeHealthCause({ message: 'Request aborted' }, 503)).toBe('timeout');
    });

    it('maps dependency failures to dependency_failure', () => {
      expect(metrics.normalizeHealthCause({ code: 'ECONNREFUSED' }, 500)).toBe('dependency_failure');
      expect(metrics.normalizeHealthCause({ code: 'ENOTFOUND' }, 500)).toBe('dependency_failure');
      expect(metrics.normalizeHealthCause({ code: 'POOL_ACQUIRE_TIMEOUT' }, 503)).toBe('dependency_failure');
      expect(metrics.normalizeHealthCause({ message: 'Database unreachable' }, 503)).toBe('dependency_failure');
      expect(metrics.normalizeHealthCause({ message: 'Soroban RPC error' }, 503)).toBe('dependency_failure');
      expect(metrics.normalizeHealthCause({ message: 'Storage connectivity failed' }, 503)).toBe('dependency_failure');
      expect(metrics.normalizeHealthCause({ message: 'Reconciliation check failed' }, 503)).toBe('dependency_failure');
    });

    it('maps other server errors to internal', () => {
      expect(metrics.normalizeHealthCause(new Error('boom'), 500)).toBe('internal');
      expect(metrics.normalizeHealthCause({}, 500)).toBe('internal');
      expect(metrics.normalizeHealthCause({ code: 'UNKNOWN_ERR' }, 500)).toBe('internal');
    });

    it('handles non-error objects gracefully', () => {
      expect(metrics.normalizeHealthCause('just a string', 500)).toBe('internal');
      expect(metrics.normalizeHealthCause(42, 500)).toBe('internal');
    });
  });

  describe('recordHealthOutcome', () => {
    it('records duration + request count and no error on success', async () => {
      recordHealthOutcome({
        endpoint: 'health_liveness',
        statusCode: 200,
        durationSeconds: 0.02,
      });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_liveness', status_class: '2xx' })).toBe(1);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_liveness', cause: 'none' })).toBe(0);
    });

    it('records a validation error on a 4xx', async () => {
      recordHealthOutcome({
        endpoint: 'health_checks_list',
        statusCode: 400,
        durationSeconds: 0.01,
        error: { message: 'Invalid cursor' },
      });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_checks_list', status_class: '4xx' })).toBe(1);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_checks_list', cause: 'validation' })).toBe(1);
    });

    it('records a dependency_failure error on a 5xx with dependency message', async () => {
      recordHealthOutcome({
        endpoint: 'health_full',
        statusCode: 503,
        durationSeconds: 0.5,
        error: { message: 'Database unreachable' },
      });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_full', status_class: '5xx' })).toBe(1);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_full', cause: 'dependency_failure' })).toBe(1);
    });

    it('records a timeout error on a 5xx with timeout message', async () => {
      recordHealthOutcome({
        endpoint: 'health_readiness',
        statusCode: 503,
        durationSeconds: 5.0,
        error: { message: 'Connection timed out' },
      });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_readiness', status_class: '5xx' })).toBe(1);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_readiness', cause: 'timeout' })).toBe(1);
    });

    it('records an internal error on an unknown 5xx', async () => {
      recordHealthOutcome({
        endpoint: 'health_reports_submit',
        statusCode: 500,
        durationSeconds: 0.1,
        error: new Error('unexpected'),
      });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_reports_submit', status_class: '5xx' })).toBe(1);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_reports_submit', cause: 'internal' })).toBe(1);
    });

    it('collapses an unknown endpoint to the bounded label', async () => {
      recordHealthOutcome({ endpoint: 'mystery_endpoint', statusCode: 200, durationSeconds: 0.01 });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'unknown', status_class: '2xx' })).toBe(1);
    });

    it('uses a request-scoped logger when a req is supplied', async () => {
      const req = { id: 'r2', correlationId: 'c2' };
      expect(() => recordHealthOutcome({
        endpoint: 'health_liveness',
        statusCode: 200,
        durationSeconds: 0.01,
        req,
      })).not.toThrow();
    });

    it('records correct status_class for 503 (5xx)', async () => {
      recordHealthOutcome({ endpoint: 'health_full', statusCode: 503, durationSeconds: 0.3 });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_full', status_class: '5xx' })).toBe(1);
    });

    it('records correct status_class for 201 (2xx)', async () => {
      recordHealthOutcome({ endpoint: 'health_reports_submit', statusCode: 201, durationSeconds: 0.05 });
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_reports_submit', status_class: '2xx' })).toBe(1);
    });
  });

  describe('instrumentHealth guard branches', () => {
    const { EventEmitter } = require('events');

    /** Minimal fake res that lets us emit finish manually and toggle locals. */
    function fakeRes({ withLocals = true, statusCode = 200 } = {}) {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headersSent = false;
      if (withLocals) { res.locals = {}; }
      return res;
    }

    it('records only once even if finish fires twice', async () => {
      const res = fakeRes({ statusCode: 200 });
      const handler = async () => {};
      await instrumentHealth('health_liveness', handler)({}, res, () => {});
      res.emit('finish');
      res.emit('finish'); // second emit must hit the `recorded` guard and no-op
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_liveness', status_class: '2xx' })).toBe(1);
    });

    it('does not throw when res.locals is absent and the handler throws', async () => {
      const res = fakeRes({ withLocals: false, statusCode: 500 });
      const err = new Error('no-locals');
      const handler = async () => { throw err; };
      let passed;
      await instrumentHealth('health_full', handler)({}, res, (e) => { passed = e; });
      expect(passed).toBe(err);
      res.emit('finish'); // records with undefined error, status 500 -> internal
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_full', cause: 'internal' })).toBe(1);
    });
  });

  describe('instrumentHealth wrapper', () => {
    function buildApp(handler, endpoint = 'health_liveness') {
      const app = express();
      app.use(express.json());
      app.get('/test-health', instrumentHealth(endpoint, handler));
      app.use((err, _req, res, _next) => res.status(res.statusCode >= 400 ? res.statusCode : 500).json({ error: 'x' }));
      return app;
    }

    it('records a 2xx for a successful handler', async () => {
      const app = buildApp(async (_req, res) => { res.status(200).json({ status: 'ok' }); });
      const res = await request(app).get('/test-health');
      expect(res.status).toBe(200);
      expect(await counterValue(metrics.healthRequestsTotal, { endpoint: 'health_liveness', status_class: '2xx' })).toBe(1);
    });

    it('records a 4xx when the handler responds with a client error', async () => {
      const app = buildApp(async (_req, res) => { res.status(400).json({ error: 'bad' }); }, 'health_checks_list');
      const res = await request(app).get('/test-health');
      expect(res.status).toBe(400);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_checks_list', cause: 'validation' })).toBe(1);
    });

    it('records and re-throws when the handler throws', async () => {
      const app = buildApp(async () => { const e = new Error('kaboom'); throw e; }, 'health_full');
      const res = await request(app).get('/test-health');
      expect(res.status).toBe(500);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_full', cause: 'internal' })).toBeGreaterThanOrEqual(1);
    });

    it('records a timeout cause when handler throws a timeout-like error', async () => {
      const app = buildApp(async () => { const e = new Error('Connection timed out'); e.code = 'ETIMEDOUT'; throw e; }, 'health_full');
      const res = await request(app).get('/test-health');
      expect(res.status).toBe(500);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_full', cause: 'timeout' })).toBeGreaterThanOrEqual(1);
    });

    it('records a dependency_failure cause for a 503 with dependency error', async () => {
      const app = buildApp(async (_req, res) => {
        const err = new Error('Database unreachable');
        res.locals.healthError = err;
        res.status(503).json({ ready: false, error: err.message });
      }, 'health_readiness');
      const res = await request(app).get('/test-health');
      expect(res.status).toBe(503);
      expect(await counterValue(metrics.healthRequestErrorsTotal, { endpoint: 'health_readiness', cause: 'dependency_failure' })).toBeGreaterThanOrEqual(1);
    });

    it('records all endpoint types correctly', async () => {
      const endpoints = [
        'health_liveness',
        'health_full',
        'health_readiness',
        'health_checks_list',
        'health_reports_submit',
      ];

      for (const ep of endpoints) {
        const app = buildApp(async (_req, res) => { res.status(200).json({ ok: true }); }, ep);
        await request(app).get('/test-health');
        expect(await counterValue(metrics.healthRequestsTotal, { endpoint: ep, status_class: '2xx' })).toBe(1);
      }
    });
  });

  describe('health metrics counters are exported on /metrics endpoint', () => {
    it('metrics module exposes health metrics', () => {
      expect(metrics.healthRequestDurationSeconds).toBeDefined();
      expect(metrics.healthRequestsTotal).toBeDefined();
      expect(metrics.healthRequestErrorsTotal).toBeDefined();
    });

    it('health metrics use the shared registry', () => {
      const registry = metrics.getRegistry();
      const healthDurationMetric = registry.getSingleMetric('health_request_duration_seconds');
      const healthRequestsTotalMetric = registry.getSingleMetric('health_requests_total');
      const healthRequestErrorsMetric = registry.getSingleMetric('health_request_errors_total');

      expect(healthDurationMetric).toBeDefined();
      expect(healthRequestsTotalMetric).toBeDefined();
      expect(healthRequestErrorsMetric).toBeDefined();
    });
  });

  describe('HEALTH_ENDPOINT_ENUM completeness', () => {
    it('contains all expected endpoint labels', () => {
      const enm = metrics.HEALTH_ENDPOINT_ENUM;
      expect(enm).toContain('health_liveness');
      expect(enm).toContain('health_full');
      expect(enm).toContain('health_readiness');
      expect(enm).toContain('health_checks_list');
      expect(enm).toContain('health_reports_submit');
      expect(enm).toContain('unknown');
    });
  });

  describe('HEALTH_CAUSE_ENUM completeness', () => {
    it('contains all expected cause labels', () => {
      const enm = metrics.HEALTH_CAUSE_ENUM;
      expect(enm).toContain('validation');
      expect(enm).toContain('timeout');
      expect(enm).toContain('dependency_failure');
      expect(enm).toContain('internal');
      expect(enm).toContain('none');
    });
  });
});
