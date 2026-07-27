'use strict';

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../src/metrics', () => {
  const records = [];
  const counts = [];
  const registry = {
    resetMetrics: () => {
      records.length = 0;
      counts.length = 0;
    },
    metrics: async () => {
      const lines = ['# HELP liquifact_invoice_state_requests_total Total invoice-state requests'];
      for (const entry of counts) {
        lines.push(
          `liquifact_invoice_state_requests_total{route="${entry.labels.route}",method="${entry.labels.method}",status_class="${entry.labels.status_class}",error_cause="${entry.labels.error_cause}"} ${entry.value}`
        );
      }
      for (const entry of records) {
        lines.push(
          `liquifact_invoice_state_request_duration_ms_bucket{route="${entry.labels.route}",method="${entry.labels.method}",status_class="${entry.labels.status_class}",error_cause="${entry.labels.error_cause}",le="500"} ${entry.value}`
        );
      }
      return lines.join('\n');
    },
  };

  return {
    registry,
    invoiceStateRequestDurationMs: {
      observe: (labels, value) => {
        records.push({ labels, value });
      },
    },
    invoiceStateRequestCount: {
      inc: (labels) => {
        const found = counts.find((entry) => JSON.stringify(entry.labels) === JSON.stringify(labels));
        if (found) {
          found.value += 1;
          return;
        }
        counts.push({ labels, value: 1 });
      },
    },
    configReadCacheHits: { inc() {} },
    configReadCacheMisses: { inc() {} },
  };
});

const express = require('express');
const request = require('supertest');
const { registry } = require('../src/metrics');
const logger = require('../src/logger');
const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const { clearAuditLogs } = require('../src/services/auditLog');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'test-user-123' };
    next();
  });
  app.use('/api/invoices', invoiceStateRoutes);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || 'Internal error' });
    next(err);
  });
  return app;
}

describe('invoice state observability', () => {
  beforeEach(() => {
    clearAuditLogs();
    registry.resetMetrics();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
    mockInvoices.clear();
    mockInvoices.set('inv-001', { id: 'inv-001', status: 'pending', amount: 1000, customer: 'Acme Corp' });
    mockInvoices.set('inv-002', { id: 'inv-002', status: 'approved', amount: 2000, customer: 'TechCo' });
    mockInvoices.set('inv-003', { id: 'inv-003', status: 'linked_escrow', amount: 5000, customer: 'GlobalInc' });
  });

  test('records success metrics and structured logs', async () => {
    const app = createApp();
    const response = await request(app).get('/api/invoices/inv-001/state');

    expect(response.status).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'invoice-state:get',
        method: 'GET',
        statusCode: 200,
        errorCause: 'none',
      }),
      'Invoice-state request completed'
    );

    const metrics = await registry.metrics();
    expect(metrics).toContain('liquifact_invoice_state_requests_total');
    expect(metrics).toContain('status_class="2xx"');
    expect(metrics).toContain('error_cause="none"');
  });

  test('records client-error labels and logs', async () => {
    const app = createApp();
    const response = await request(app).post('/api/invoices/inv-001/transition').send({});

    expect(response.status).toBe(400);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'invoice-state:transition',
        method: 'POST',
        statusCode: 400,
        errorCause: 'client_error',
      }),
      'Invoice-state request completed'
    );

    const metrics = await registry.metrics();
    expect(metrics).toContain('status_class="4xx"');
    expect(metrics).toContain('error_cause="client_error"');
  });

  test('records server-error labels and logs', async () => {
    const app = createApp();
    const { mockInvoices } = require('../src/routes/invoiceStateRoutes');
    const originalGet = mockInvoices.get;
    mockInvoices.get = () => {
      throw new Error('Unexpected failure');
    };

    const response = await request(app).post('/api/invoices/inv-001/approve').send({ reason: 'Test' });

    expect(response.status).toBe(500);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'invoice-state:approve',
        method: 'POST',
        statusCode: 500,
        errorCause: 'server_error',
      }),
      'Invoice-state request completed'
    );

    const metrics = await registry.metrics();
    expect(metrics).toContain('status_class="5xx"');
    expect(metrics).toContain('error_cause="server_error"');

    mockInvoices.get = originalGet;
  });
});
