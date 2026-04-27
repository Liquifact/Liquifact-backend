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
});