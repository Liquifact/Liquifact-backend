'use strict';

/**
 * @fileoverview Integration tests for the metrics-audit wrap installed by
 * `src/metrics.js` (issue #872).
 *
 * NOTE: The wrap-before/after reads rely on the `prom-client` shim's
 * `metric.get(labels)` returning a numeric value; in environments where
 * the shim is not active (production / CI with the real prom-client)
 * the public `get()` API does not support labels and `before`/`after`
 * come back as `null`. The lifecycle classification (CREATE / UPDATE /
 * DELETE) still works correctly, so the tests below focus on lifecycle
 * rather than exact numeric values.
 */

const metrics = require('../src/metrics');
const metricsAudit = require('../src/metricsAudit');

const WRAPPED_GAUGES = [
  ['liquifact_job_queue_depth', 'queueDepthGauge'],
  ['liquifact_job_retry_queue_size', 'retryQueueSizeGauge'],
  ['liquifact_worker_inflight_count', 'workerInFlightGauge'],
];

describe('src/metrics.js — narrow audit wrap integration', () => {
  beforeEach(() => {
    metrics.resetMetricsForTests();
    metricsAudit.clearMetricAuditLog();
  });

  afterAll(() => {
    metricsAudit.clearMetricAuditLog();
    metrics.resetMetricsForTests();
  });

  describe.each(WRAPPED_GAUGES)('wrapped gauge %s', (metricName, gaugeKey) => {
    it('records a CREATE entry on the first .set() call', () => {
      metrics[gaugeKey].set(7);
      const page = metricsAudit.getMetricAuditLog({ metricName });
      expect(page.total).toBe(1);
      const [entry] = page.entries;
      expect(entry.action).toBe('CREATE');
      expect(entry.metricType).toBe('gauge');
      expect(entry.labels).toEqual({});
      expect(entry.source).toBe('set');
      // before/after are best-effort (depends on prom-client `.get(labels)`).
      // See comment at top of file.
    });

    it('records UPDATE entries on subsequent .set() calls', () => {
      metrics[gaugeKey].set(1);
      metrics[gaugeKey].set(2);
      metrics[gaugeKey].set(3);
      const page = metricsAudit.getMetricAuditLog({ metricName });
      expect(page.total).toBe(3);
      expect(page.entries.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    });
  });

  describe('refreshMetrics hook', () => {
    it('tags wrapped-gauge writes with actorId=refreshMetrics', () => {
      metrics.refreshMetrics();
      const entries = metricsAudit.getMetricAuditLog({ actorId: 'refreshMetrics' });
      const wrappedGaugeNames = entries.entries
        .filter((entry) => WRAPPED_GAUGES.some(([name]) => name === entry.metricName))
        .map((entry) => entry.metricName);
      expect(new Set(wrappedGaugeNames).size).toBeGreaterThan(0);
      expect(new Set(wrappedGaugeNames)).toEqual(new Set([
        'liquifact_job_queue_depth',
        'liquifact_job_retry_queue_size',
        'liquifact_worker_inflight_count',
      ]));
    });
  });

  describe('resetMetricsForTests hook', () => {
    it('records DELETE entries for the three wrapped gauges', () => {
      metricsAudit.clearMetricAuditLog();
      metrics.resetMetricsForTests();
      const deletions = metricsAudit.getMetricAuditLog({ action: 'DELETE' });
      const deletedMetricNames = deletions.entries.map((entry) => entry.metricName);
      expect(deletedMetricNames).toEqual(expect.arrayContaining([
        'liquifact_job_queue_depth',
        'liquifact_job_retry_queue_size',
        'liquifact_worker_inflight_count',
      ]));
      deletions.entries.forEach((entry) => {
        expect(entry.source).toBe('reset');
        expect(entry.actor.actorId).toBe('resetMetricsForTests');
      });
    });
  });

  describe('narrow wrap scope — high-frequency counters are NOT wrapped', () => {
    it('does NOT record audit entries from footprint counter .inc() calls', () => {
      metrics.footprintCacheHitsTotal.inc(1);
      metrics.footprintCacheHitsTotal.inc(2);
      metrics.footprintCacheHitsTotal.inc(3);
      const page = metricsAudit.getMetricAuditLog({ metricName: 'footprint_cache_hits_total' });
      expect(page.total).toBe(0);
    });

    it('does NOT record audit entries from histogram .observe() calls', () => {
      metrics.sorobanRpcCallDurationSeconds.observe(
        { method: 'contract_call', outcome: 'success' },
        0.123
      );
      const page = metricsAudit.getMetricAuditLog({ metricName: 'soroban_rpc_call_duration_seconds' });
      expect(page.total).toBe(0);
    });
  });
});

