'use strict';

const request = require('supertest');
const express = require('express');
const { corsObservability } = require('../../src/middleware/corsObservability');
const metrics = require('../../src/metrics');

describe('corsObservability middleware', () => {
  let app;

  beforeEach(() => {
    metrics.resetMetricsForTests();
    app = express();
    app.use(corsObservability);
    app.get('/test', (req, res) => res.status(200).json({ ok: true }));
    app.get('/error', (req, res) => res.status(500).json({ error: 'fail' }));
  });

  it('records metrics for successful requests', async () => {
    await request(app).get('/test').expect(200);
    const metricStr = await metrics.registry.metrics();
    expect(metricStr).toContain('cors_requests_total{status="200",outcome="success",status_class="2xx"} 1');
  });

  it('records error metrics for server errors', async () => {
    await request(app).get('/error').expect(500);
    const metricStr = await metrics.registry.metrics();
    expect(metricStr).toContain('cors_request_errors_total{cause="server_error",status_class="5xx"} 1');
  });
});
