const request = require('supertest');
const app = require('../app');
const { mockInvoices } = require('../services/invoiceService');

describe('API Gateway', () => {
  it('GET /health should return 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api should return 200 and info', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('LiquiFact API');
  });

  it('GET /api/escrow/:invoiceId should return 200 and placeholder info', async () => {
    const res = await request(app).get('/api/escrow/inv_123');
    expect(res.status).toBe(200);
    expect(res.body.data.invoiceId).toBe('inv_123');
  });

  it('should return 404 for unknown routes', async () => {
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});

describe('GET /api/invoices/:id', () => {
  const userId = 'user_1';
  const otherUserId = 'user_2';

  it('should return 200 and the invoice when found and authorized', async () => {
    const existingInvoice = mockInvoices.find(inv => inv.ownerId === userId);
    const invoiceId = existingInvoice.id;

    const res = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('x-user-id', userId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(existingInvoice);
    expect(res.body.message).toBe('Invoice retrieved successfully');
  });

  it('should return 401 when x-user-id is missing', async () => {
    const invoiceId = 'inv_1';

    const res = await request(app)
        .get(`/api/invoices/${invoiceId}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should return 404 when invoice does not exist', async () => {
    const invoiceId = 'non_existent_id';

    const res = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('x-user-id', userId);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not Found');
    expect(res.body.message).toContain(invoiceId);
  });

  it('should return 403 when user is not the owner of the invoice', async () => {
    // Invoice 3 belongs to user_2
    const invoiceId = 'inv_3';

    const res = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set('x-user-id', userId);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(res.body.message).toBe('You do not have access to this invoice.');
  });

  it('should return 400 when invoice ID is empty or whitespace', async () => {
    const res = await request(app)
      .get('/api/invoices/%20') // Encoded space
      .set('x-user-id', userId);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
  });

  it('should handle internal errors gracefully', async () => {
    // Manually trigger an error by mock in the test if needed,
    // or just rely on passing unknown data to the service.
    // Let's pass something that would normally cause an error in a real DB
    // In our mock service, it's pretty robust, but let's test invalid ID type
    // Express params are always strings, so it's hard to trigger "type" error from here
    // but maybe we can mock the service itself for this test case.
    const invoiceService = require('../services/invoiceService');
    const spy = jest.spyOn(invoiceService, 'getInvoiceById').mockImplementation(() => {
        throw new Error('Database down');
    });

    const res = await request(app)
        .get('/api/invoices/any')
        .set('x-user-id', userId);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');

    spy.mockRestore();
  });
});

describe('Invoice Service', () => {
  const { getInvoiceById } = require('../services/invoiceService');

  it('should throw "Invalid invoice ID" if id is not a string', () => {
    expect(() => getInvoiceById(123, 'user_1')).toThrow('Invalid invoice ID');
    expect(() => getInvoiceById(null, 'user_1')).toThrow('Invalid invoice ID');
  });
});
