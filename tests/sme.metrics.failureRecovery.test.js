'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { id: 'test-user', tenantId: 'test-tenant' };
    next();
  },
}));

jest.mock('../src/middleware/tenant', () => ({
  extractTenant: (req, _res, next) => {
    req.tenantId = 'test-tenant';
    next();
  },
}));

jest.mock('../src/middleware/optionalIdempotency', () => (_req, _res, next) => next());

jest.mock('../src/services/invoiceService', () => ({
  getSmeInvoiceCounts: jest.fn(),
  getSmeInvoiceList: jest.fn(),
}));

const invoiceService = require('../src/services/invoiceService');
const smeMetricsRouter = require('../src/routes/sme/metrics');

function createApp() {
  const app = express();
  app.use('/api/sme', smeMetricsRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('SME metrics deterministic failure recovery', () => {
  const app = createApp();

  beforeEach(() => {
    invoiceService.getSmeInvoiceCounts.mockReset();
    invoiceService.getSmeInvoiceList.mockReset();
  });

  it('does not retry a failed read within the request and allows a later request to recover', async () => {
    invoiceService.getSmeInvoiceCounts
      .mockRejectedValueOnce(new Error('private database detail'))
      .mockResolvedValueOnce({ open: 2, funded: 1, settled: 3, defaulted: 0 });

    const failed = await request(app).get('/api/sme/metrics');
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('private database detail');
    expect(invoiceService.getSmeInvoiceCounts).toHaveBeenCalledTimes(1);

    const recovered = await request(app).get('/api/sme/metrics');
    expect(recovered.status).toBe(200);
    expect(recovered.body.data).toEqual({ open: 2, funded: 1, settled: 3, defaulted: 0 });
    expect(invoiceService.getSmeInvoiceCounts).toHaveBeenCalledTimes(2);
  });

  it('rejects partial or malformed service output without returning partial counts', async () => {
    invoiceService.getSmeInvoiceCounts.mockResolvedValue({
      open: 4,
      funded: 1,
      settled: 'private metric value',
      defaulted: 0,
    });

    const response = await request(app).get('/api/sme/metrics');

    expect(response.status).toBe(500);
    expect(response.body.data).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('private metric value');
    expect(invoiceService.getSmeInvoiceCounts).toHaveBeenCalledTimes(1);
  });
});
