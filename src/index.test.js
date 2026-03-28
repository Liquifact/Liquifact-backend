const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, resetStore, startServer } = require('./index');

const getToken = () => jwt.sign({ id: Math.random().toString() }, process.env.JWT_SECRET || 'test-secret');

describe('LiquiFact API', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('Health & Info', () => {
    it('GET /health - returns 200 and status ok', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('GET /api - returns 200 and API info', async () => {
      const response = await request(app).get('/api');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'LiquiFact API');
    });
  });

  describe('Invoices Lifecycle', () => {
    it('POST /api/invoices - creates a new invoice', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${getToken()}`)
        .send({ amount: 1000, customer: 'Test Corp' });

      expect(response.status).toBe(201);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.amount).toBe(1000);
      expect(response.body.data.customer).toBe('Test Corp');
      expect(response.body.data.deletedAt).toBeNull();
    });

    it('POST /api/invoices - fails if missing fields', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${getToken()}`)
        .send({ amount: 1000 });
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('GET /api/invoices - lists active invoices', async () => {
      await request(app).post('/api/invoices').set('Authorization', `Bearer ${getToken()}`).send({ amount: 1000, customer: 'A' });
      await request(app).post('/api/invoices').set('Authorization', `Bearer ${getToken()}`).send({ amount: 2000, customer: 'B' });

      const response = await request(app).get('/api/invoices');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });

    it('DELETE /api/invoices/:id - soft deletes an invoice', async () => {
      const t1 = getToken();
      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${t1}`)
        .send({ amount: 500, customer: 'Delete Me' });
      const id = postRes.body.data.id;

      const delRes = await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${t1}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.deletedAt).not.toBeNull();

      // Verify it's hidden from default list
      const listRes = await request(app).get('/api/invoices');
      expect(listRes.body.data).toHaveLength(0);

      // Verify it's visible with includeDeleted=true
      const listAllRes = await request(app).get('/api/invoices?includeDeleted=true');
      expect(listAllRes.body.data).toHaveLength(1);
    });

    it('DELETE /api/invoices/:id - fails for non-existent or already deleted', async () => {
      const t1 = getToken();
      const res404 = await request(app).delete('/api/invoices/nonexistent').set('Authorization', `Bearer ${t1}`);
      expect(res404.status).toBe(404);

      const postRes = await request(app).post('/api/invoices').set('Authorization', `Bearer ${t1}`).send({ amount: 100, customer: 'X' });
      const id = postRes.body.data.id;
      await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${t1}`);

      const res400 = await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${t1}`);
      expect(res400.status).toBe(400);
      expect(res400.body.error).toBe('Invoice is already deleted');
    });

    it('PATCH /api/invoices/:id/restore - restores a deleted invoice', async () => {
      const t1 = getToken();
      const postRes = await request(app).post('/api/invoices').set('Authorization', `Bearer ${t1}`).send({ amount: 100, customer: 'X' });
      const id = postRes.body.data.id;
      await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${t1}`);

      const restoreRes = await request(app).patch(`/api/invoices/${id}/restore`).set('Authorization', `Bearer ${t1}`);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.deletedAt).toBeNull();

      const listRes = await request(app).get('/api/invoices');
      expect(listRes.body.data).toHaveLength(1);
    });

    it('PATCH /api/invoices/:id/restore - fails for non-existent or not deleted', async () => {
      const t1 = getToken();
      const res404 = await request(app).patch('/api/invoices/nonexistent/restore').set('Authorization', `Bearer ${t1}`);
      expect(res404.status).toBe(404);

      const postRes = await request(app).post('/api/invoices').set('Authorization', `Bearer ${t1}`).send({ amount: 100, customer: 'X' });
      const id = postRes.body.data.id;

      const res400 = await request(app).patch(`/api/invoices/${id}/restore`).set('Authorization', `Bearer ${t1}`);
      expect(res400.status).toBe(400);
      expect(res400.body.error).toBe('Invoice is not deleted');
    });
  });

  describe('Error Handling', () => {
    it('unknown route - returns 404', async () => {
      const response = await request(app).get('/unknown');
      expect(response.status).toBe(404);
    });

    it('error handler - returns 500 on unexpected error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
      const response = await request(app).get('/error-test-trigger');
      expect(response.status).toBe(500);
      consoleSpy.mockRestore();
    });
  });

  describe('Escrow', () => {
    it('GET /api/escrow/:invoiceId - returns placeholder escrow state', async () => {
      const response = await request(app).get('/api/escrow/123');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('invoiceId', '123');
    });
  });

  describe('Server', () => {
    it('startServer - starts the server and returns it', () => {
      const mockServer = { close: jest.fn() };
      const listenSpy = jest.spyOn(app, 'listen').mockImplementation((port, cb) => {
        if (cb) { cb(); }
        return mockServer;
      });

      const server = startServer();
      expect(listenSpy).toHaveBeenCalled();
      expect(server).toBe(mockServer);

      listenSpy.mockRestore();
    });
  });
});
