'use strict';

/**
 * LiquiFact API — integration and security header tests.
 *
 * Covers:
 *  - Functional correctness of all routes (health, invoices lifecycle, escrow, error handling)
 *  - Security header presence and policy values on every endpoint (Helmet hardening)
 *
 * Run with: npm run test:coverage
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, resetStore, startServer } = require('./index');

describe('LiquiFact API', () => {
  const secret = process.env.JWT_SECRET || 'test-secret';
  const authHeader = () => {
    const token = jwt.sign({ id: `index_test_user_${Date.now()}_${Math.random()}` }, secret, {
      expiresIn: '1h',
    });
    return `Bearer ${token}`;
  };

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
        .set('Authorization', authHeader())
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
        .set('Authorization', authHeader())
        .send({ amount: 1000 });
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('GET /api/invoices - lists active invoices', async () => {
      await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 1000, customer: 'A' });
      await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 2000, customer: 'B' });

      const response = await request(app).get('/api/invoices');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });

    it('DELETE /api/invoices/:id - soft deletes an invoice', async () => {
      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 500, customer: 'Delete Me' });
      const id = postRes.body.data.id;

      const delRes = await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${validToken}`);
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
      const res404 = await request(app).delete('/api/invoices/nonexistent').set('Authorization', `Bearer ${validToken}`);
      expect(res404.status).toBe(404);

      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 100, customer: 'X' });
      const id = postRes.body.data.id;
      await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${validToken}`);

      const res400 = await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${validToken}`);
      expect(res400.status).toBe(400);
      expect(res400.body.error).toBe('Invoice is already deleted');
    });

    it('PATCH /api/invoices/:id/restore - restores a deleted invoice', async () => {
      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 100, customer: 'X' });
      const id = postRes.body.data.id;
      await request(app).delete(`/api/invoices/${id}`).set('Authorization', `Bearer ${validToken}`);

      const restoreRes = await request(app).patch(`/api/invoices/${id}/restore`).set('Authorization', `Bearer ${validToken}`);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.deletedAt).toBeNull();

      const listRes = await request(app).get('/api/invoices');
      expect(listRes.body.data).toHaveLength(1);
    });

    it('PATCH /api/invoices/:id/restore - fails for non-existent or not deleted', async () => {
      const res404 = await request(app).patch('/api/invoices/nonexistent/restore').set('Authorization', `Bearer ${validToken}`);
      expect(res404.status).toBe(404);

      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 100, customer: 'X' });
      const id = postRes.body.data.id;

      const res400 = await request(app).patch(`/api/invoices/${id}/restore`).set('Authorization', `Bearer ${validToken}`);
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
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const response = await request(app).get('/error-test-trigger');
      expect(response.status).toBe(500);
      consoleSpy.mockRestore();
    });
  });

  describe('Escrow', () => {
    it('GET /api/escrow/:invoiceId - returns placeholder escrow state', async () => {
      const response = await request(app).get('/api/escrow/123').set('Authorization', `Bearer ${validToken}`);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('invoiceId', '123');
    });

    it('POST /api/escrow - sanitizes user-supplied fields', async () => {
      const response = await request(app)
        .post('/api/escrow')
        .set('Authorization', authHeader())
        .send({ invoiceId: '  abc-123 \n', fundedAmount: 10 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('invoiceId', 'abc-123');
    });
  });

  describe('Sanitization', () => {
    it('POST /api/invoices - normalizes customer input before persistence', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', authHeader())
        .send({ amount: 1000, customer: '  ACME \n Holdings \u0000 ' });

      expect(response.status).toBe(201);
      expect(response.body.data.customer).toBe('ACME Holdings');
    });

    it('POST /api/invoices - rejects missing token before processing payload', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ amount: 1000, customer: '  ACME \n Holdings \u0000 ' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Authentication token is required');
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

// ---------------------------------------------------------------------------
// Security header tests — Helmet hardening on every endpoint
// ---------------------------------------------------------------------------

describe('Security headers — all endpoints', () => {
  const endpoints = [
    { method: 'get', path: '/health' },
    { method: 'get', path: '/api' },
    { method: 'get', path: '/api/invoices' },
    { method: 'post', path: '/api/invoices' },
    { method: 'get', path: '/api/escrow/test-invoice-id' },
    { method: 'get', path: '/nonexistent-route' },
  ];

  for (const { method, path } of endpoints) {
    it(`${method.toUpperCase()} ${path} has all required security headers`, async () => {
      const res = await req(method, path);
      expectSecureHeaders(res);
    });
  }
});

describe('Content-Security-Policy directives', () => {
  it('includes strict script-src', async () => {
    const res = await req('get', '/health');
    expect(res.headers['content-security-policy']).toContain('script-src \'self\'');
  });

  it('includes strict style-src', async () => {
    const res = await req('get', '/health');
    expect(res.headers['content-security-policy']).toContain('style-src \'self\'');
  });

  it('allows data: URIs for images', async () => {
    const res = await req('get', '/health');
    expect(res.headers['content-security-policy']).toContain('img-src \'self\' data:');
  });

  it('blocks object sources', async () => {
    const res = await req('get', '/api');
    expect(res.headers['content-security-policy']).toContain('object-src \'none\'');
  });

  it('blocks frame sources', async () => {
    const res = await req('get', '/api');
    expect(res.headers['content-security-policy']).toContain('frame-src \'none\'');
  });

  it('restricts form-action to self', async () => {
    const res = await req('get', '/api');
    expect(res.headers['content-security-policy']).toContain('form-action \'self\'');
  });

  it('restricts base-uri to self', async () => {
    const res = await req('get', '/api');
    expect(res.headers['content-security-policy']).toContain('base-uri \'self\'');
  });
});

describe('HSTS header', () => {
  it('max-age is set to 1 year (31536000 seconds)', async () => {
    const res = await req('get', '/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });

  it('includeSubDomains is set', async () => {
    const res = await req('get', '/health');
    expect(res.headers['strict-transport-security']).toContain('includeSubDomains');
  });

  it('preload directive is set', async () => {
    const res = await req('get', '/health');
    expect(res.headers['strict-transport-security']).toContain('preload');
  });
});

describe('X-Powered-By suppression', () => {
  it('is absent on /health', async () => {
    const res = await req('get', '/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('is absent on /api', async () => {
    const res = await req('get', '/api');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('is absent on 404 responses', async () => {
    const res = await req('get', '/totally-unknown');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Cross-origin isolation headers', () => {
  it('COOP is same-origin', async () => {
    const res = await req('get', '/health');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('CORP is same-origin', async () => {
    const res = await req('get', '/health');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('COEP requires CORP', async () => {
    const res = await req('get', '/health');
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
  });
});
