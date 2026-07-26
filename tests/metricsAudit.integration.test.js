'use strict';

/**
 * @fileoverview HTTP integration tests for the metrics mutation audit log
 * read endpoint (issue #872).
 *
 * Uses the real `adminStack` auth chain with a valid signed JWT so the
 * tests exercise the same code path as production callers.  The JWT
 * signing key is configured at module load via `JWT_SECRET`; the secret
 * is intentionally low-strength and NOT used outside of this test file.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-32-chars-long';
process.env.JWT_ALGORITHMS = 'HS256';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const metricsAudit = require('../src/metricsAudit');
const adminMetricsAuditRoutes = require('../src/routes/adminMetricsAudit');

const JWT_SECRET = process.env.JWT_SECRET;
const TENANT = 'tenant-metrics-test';

function makeToken({ tenantId = TENANT, role = 'admin' } = {}) {
  return jwt.sign({ sub: `metrics-audit-${role}`, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/metrics/audit', adminMetricsAuditRoutes);
  app.use((err, req, res, _next) => {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: err.detail || err.message || 'error' });
  });
  return app;
}

describe('GET /api/admin/metrics/audit', () => {
  let app;

  beforeEach(() => {
    metricsAudit.clearMetricAuditLog();
    app = buildApp();
  });

  describe('authentication', () => {
    it('returns 401 when no token is supplied', async () => {
      const res = await request(app).get('/api/admin/metrics/audit');
      expect(res.status).toBe(401);
    });

    it('returns 401 when the token is invalid', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/audit')
        .set('Authorization', 'Bearer not-a-real-token');
      expect(res.status).toBe(401);
    });
  });

  describe('happy path', () => {
    it('returns an empty envelope when the audit log is empty', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/audit')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [],
        meta: { total: 0, limit: 100, offset: 0, returned: 0 },
        filters: { metricName: null, action: null, actorId: null },
      });
    });

    it('lists CREATE / UPDATE / DELETE entries', async () => {
      metricsAudit.withActorContext({ actorType: 'user', actorId: 'admin-1' }, () => {
        metricsAudit.recordMetricMutation({
          metricName: 'metric_alpha_total',
          metricType: 'counter',
          labels: { kind: 'hits' },
          before: null,
          after: 1,
        });
        metricsAudit.recordMetricMutation({
          metricName: 'metric_alpha_total',
          metricType: 'counter',
          labels: { kind: 'hits' },
          before: 1,
          after: 2,
        });
        metricsAudit.recordMetricDelete({
          metricName: 'metric_alpha_total',
          metricType: 'counter',
          labels: { kind: 'hits' },
          before: 2,
          after: 0,
        });
      });

      const res = await request(app)
        .get('/api/admin/metrics/audit')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
      expect(res.body.data).toHaveLength(3);
      const actions = res.body.data.map((entry) => entry.action);
      expect(actions).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    });

    it('redacts secret labels in the response payload', async () => {
      metricsAudit.recordMetricMutation({
        metricName: 'metric_secret_total',
        metricType: 'counter',
        labels: { apiKey: 'very-secret', kind: 'cache' },
        before: null,
        after: 1,
      });

      const res = await request(app)
        .get('/api/admin/metrics/audit')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.data[0].labels.apiKey).toBe('***REDACTED***');
      expect(res.body.data[0].labels.kind).toBe('cache');
    });

    it('filters by metricName', async () => {
      metricsAudit.recordMetricMutation({ metricName: 'a_total', metricType: 'counter', labels: {}, before: null, after: 1 });
      metricsAudit.recordMetricMutation({ metricName: 'b_total', metricType: 'counter', labels: {}, before: null, after: 1 });

      const res = await request(app)
        .get('/api/admin/metrics/audit?metricName=a_total')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].metricName).toBe('a_total');
    });

    it('filters by action', async () => {
      metricsAudit.recordMetricMutation({ metricName: 'm', metricType: 'counter', labels: {}, before: null, after: 1 });
      metricsAudit.recordMetricMutation({ metricName: 'm', metricType: 'counter', labels: {}, before: 1, after: 2 });

      const res = await request(app)
        .get('/api/admin/metrics/audit?action=UPDATE')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].action).toBe('UPDATE');
    });

    it('rejects an invalid action filter', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/audit?action=BOGUS')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.action).toMatch(/must be one of/);
    });

    it('rejects an out-of-pattern metricName', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/audit?metricName=' + encodeURIComponent('1-bad-name'))
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.metricName).toBeDefined();
    });

    it('applies limit and offset', async () => {
      for (let i = 0; i < 5; i += 1) {
        metricsAudit.recordMetricMutation({
          metricName: 'paged_total',
          metricType: 'counter',
          labels: { seq: String(i) },
          before: null,
          after: i,
        });
      }
      const res = await request(app)
        .get('/api/admin/metrics/audit?limit=2&offset=2')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(5);
      expect(res.body.meta.limit).toBe(2);
      expect(res.body.meta.offset).toBe(2);
      expect(res.body.meta.returned).toBe(2);
    });

    it('clamps limit to the hard ceiling', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/audit?limit=99999')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBeLessThanOrEqual(1000);
    });

    it('caps offset at the maximum to avoid Array.slice DoS', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/audit?offset=99999999999')
        .set('Authorization', `Bearer ${makeToken()}`)
        .set('x-tenant-id', TENANT);

      expect(res.status).toBe(200);
      expect(res.body.meta.offset).toBeLessThanOrEqual(1_000_000);
    });
  });
});
