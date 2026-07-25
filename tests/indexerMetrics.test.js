'use strict';

const express = require('express');
const request = require('supertest');
const {
  instrumentIndexer,
  recordIndexerOutcome,
} = require('../src/middleware/indexerMetrics');
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

describe('indexer metrics instrumentation', () => {
  beforeEach(() => {
    metrics.indexerRequestDurationSeconds.reset();
    metrics.indexerRequestsTotal.reset();
    metrics.indexerRequestErrorsTotal.reset();
  });

  describe('normalizeIndexerStatusClass', () => {
    it('maps 2xx, 4xx, 5xx correctly', () => {
      expect(metrics.normalizeIndexerStatusClass(200)).toBe('2xx');
      expect(metrics.normalizeIndexerStatusClass(201)).toBe('2xx');
      expect(metrics.normalizeIndexerStatusClass(400)).toBe('4xx');
      expect(metrics.normalizeIndexerStatusClass(401)).toBe('4xx');
      expect(metrics.normalizeIndexerStatusClass(403)).toBe('4xx');
      expect(metrics.normalizeIndexerStatusClass(503)).toBe('5xx');
      expect(metrics.normalizeIndexerStatusClass('200')).toBe('2xx');
    });
  });

  describe('normalizeIndexerCause', () => {
    it('returns none for success', () => {
      expect(metrics.normalizeIndexerCause(null, 200)).toBe('none');
    });

    it('returns authorization for 401/403', () => {
      expect(metrics.normalizeIndexerCause(null, 401)).toBe('authorization');
      expect(metrics.normalizeIndexerCause(null, 403)).toBe('authorization');
    });

    it('returns validation for other 4xx errors', () => {
      expect(metrics.normalizeIndexerCause(null, 400)).toBe('validation');
      expect(metrics.normalizeIndexerCause(null, 422)).toBe('validation');
      expect(metrics.normalizeIndexerCause(new Error('bad input'), 400)).toBe('validation');
    });

    it('returns internal for 5xx errors', () => {
      expect(metrics.normalizeIndexerCause(new Error('boom'), 500)).toBe('internal');
      expect(metrics.normalizeIndexerCause(null, 500)).toBe('internal');
      expect(metrics.normalizeIndexerCause({}, 503)).toBe('internal');
    });
  });

  describe('recordIndexerOutcome', () => {
    it('records duration + request count and no error on success', async () => {
      recordIndexerOutcome({
        statusCode: 200,
        durationSeconds: 0.05,
      });
      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '2xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'none' })).toBe(0);
    });

    it('records a validation error on a 4xx', async () => {
      recordIndexerOutcome({
        statusCode: 400,
        durationSeconds: 0.01,
        error: new Error('invalid query'),
      });
      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '4xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'validation' })).toBe(1);
    });

    it('records an authorization error on 401/403', async () => {
      recordIndexerOutcome({
        statusCode: 401,
        durationSeconds: 0.01,
        error: new Error('unauthorized'),
      });
      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '4xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'authorization' })).toBe(1);
    });

    it('records an internal error on a 5xx', async () => {
      recordIndexerOutcome({
        statusCode: 500,
        durationSeconds: 0.1,
        error: new Error('database error'),
      });
      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '5xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'internal' })).toBe(1);
    });
  });

  describe('instrumentIndexer', () => {
    let app;

    beforeEach(() => {
      app = express();
    });

    it('wraps handler and records metrics on success', async () => {
      app.get('/test', instrumentIndexer(async (req, res) => {
        res.json({ data: 'test' });
      }));

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);

      // Give time for the finish event
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '2xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'none' })).toBe(0);
    });

    it('wraps handler and records metrics on 4xx error', async () => {
      app.get('/test', instrumentIndexer(async (req, res) => {
        res.status(400).json({ error: 'bad request' });
      }));

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '4xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'validation' })).toBe(1);
    });

    it('wraps handler and records metrics on 5xx error', async () => {
      app.get('/test', instrumentIndexer(async (req, res, next) => {
        next(new Error('internal server error'));
      }));

      // Add error middleware to handle the thrown error
      app.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(500);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await counterValue(metrics.indexerRequestsTotal, { status_class: '5xx' })).toBe(1);
      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'internal' })).toBe(1);
    });

    it('records request duration with reasonable precision', async () => {
      app.get('/test', instrumentIndexer(async (req, res) => {
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 10));
        res.json({ success: true });
      }));

      await request(app).get('/test');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const metric = await metrics.indexerRequestDurationSeconds.get();
      const values = metric.values || [];
      const hasValue = values.some((v) => v.value > 0 && v.value < 1);
      expect(hasValue).toBe(true);
    });

    it('handles both authorization and validation 4xx errors correctly', async () => {
      const app1 = express();
      app1.get('/test', instrumentIndexer(async (req, res) => {
        res.status(401).json({ error: 'unauthorized' });
      }));

      await request(app1).get('/test');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'authorization' })).toBe(1);

      metrics.indexerRequestErrorsTotal.reset();

      const app2 = express();
      app2.get('/test', instrumentIndexer(async (req, res) => {
        res.status(400).json({ error: 'bad request' });
      }));

      await request(app2).get('/test');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await counterValue(metrics.indexerRequestErrorsTotal, { cause: 'validation' })).toBe(1);
    });
  });
});
