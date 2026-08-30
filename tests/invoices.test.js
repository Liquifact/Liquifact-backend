const request = require('supertest');
const { createApp } = require('../src/index');
const db = require('../src/db/knex');

describe('Invoice API', () => {
  let app;
  let tenantId = 'test-tenant';

  beforeAll(async () => {
    // Run migrations
    await db.migrate.latest();
  });

  beforeEach(async () => {
    // Clean up database
    await db('invoices').del();
    app = createApp();
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe('GET /api/invoices', () => {
    it('should return empty list when no invoices', async () => {
      const response = await request(app)
        .get('/api/invoices')
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    it('should return invoices with status filter', async () => {
      // Insert test data
      await db('invoices').insert([
        { invoice_id: 'inv1', amount: 100, customer: 'Alice', status: 'pending', tenant_id: tenantId },
        { invoice_id: 'inv2', amount: 200, customer: 'Bob', status: 'approved', tenant_id: tenantId },
      ]);

      const response = await request(app)
        .get('/api/invoices?status=pending')
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe('pending');
    });
  });

  describe('POST /api/invoices', () => {
    it('should create a new invoice', async () => {
      const invoiceData = { amount: 150, customer: 'Charlie' };

      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId)
        .send(invoiceData);

      expect(response.status).toBe(201);
      expect(response.body.data.amount).toBe(150);
      expect(response.body.data.customer).toBe('Charlie');
      expect(response.body.data.status).toBe('pending');
      expect(response.body.data.tenant_id).toBe(tenantId);
    });

    it('should return 400 for missing amount', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId)
        .send({ customer: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Amount and customer are required');
    });
  });

  describe('GET /api/invoices/:id', () => {
    it('should return a single invoice', async () => {
      const [inserted] = await db('invoices').insert({
        invoice_id: 'inv-test',
        amount: 300,
        customer: 'Test Customer',
        status: 'pending',
        tenant_id: tenantId,
      }).returning('*');

      const response = await request(app)
        .get(`/api/invoices/${inserted.invoice_id}`)
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId);

      expect(response.status).toBe(200);
      expect(response.body.data.invoice_id).toBe('inv-test');
    });

    it('should return 404 for non-existent invoice', async () => {
      const response = await request(app)
        .get('/api/invoices/non-existent')
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId);

      expect(response.status).toBe(404);
    });
  });

  describe('Tenant Isolation (Service Level)', () => {
    const invoiceService = require('../src/services/invoiceService');
    const tenantA = 'tenant-A';
    const tenantB = 'tenant-B';
    let invA;
    let invB;

    beforeEach(async () => {
      invA = await invoiceService.createInvoice({ amount: 100, customer: 'A' }, tenantA);
      invB = await invoiceService.createInvoice({ amount: 200, customer: 'B' }, tenantB);
    });

    it('listInvoices returns only invoices for the requested tenant', async () => {
      const listA = await invoiceService.listInvoices(tenantA);
      expect(listA).toHaveLength(1);
      expect(listA[0].invoice_id).toBe(invA.invoice_id);

      const listB = await invoiceService.listInvoices(tenantB);
      expect(listB).toHaveLength(1);
      expect(listB[0].invoice_id).toBe(invB.invoice_id);
    });

    it('getInvoiceById returns null/no-op across tenant boundaries', async () => {
      const res = await invoiceService.getInvoiceById(invA.invoice_id, tenantB);
      expect(res).toBeFalsy();
    });

    it('updateInvoice returns null/no-op across tenant boundaries', async () => {
      const res = await invoiceService.updateInvoice(invA.invoice_id, { status: 'approved' }, tenantB);
      expect(res).toBeFalsy();

      // Verify not updated
      const fresh = await invoiceService.getInvoiceById(invA.invoice_id, tenantA);
      expect(fresh.status).not.toBe('approved');
    });

    it('deleteInvoice returns null/no-op across tenant boundaries', async () => {
      const res = await invoiceService.deleteInvoice(invA.invoice_id, tenantB);
      expect(res).toBeFalsy();

      // Verify not deleted
      const fresh = await invoiceService.getInvoiceById(invA.invoice_id, tenantA);
      expect(fresh).not.toBeNull();
    });
  });

  describe('Tenant Resolution Paths (API)', () => {
    it('missing tenant context yields 400', async () => {
      const response = await request(app)
        .get('/api/invoices')
        .set('Authorization', 'Bearer test-token');
      // No x-tenant-id set
      expect(response.status).toBe(400);
    });

    it('resolves tenant from header', async () => {
      const response = await request(app)
        .get('/api/invoices')
        .set('Authorization', 'Bearer test-token')
        .set('x-tenant-id', tenantId);
      expect(response.status).toBe(200);
    });
  });
});
