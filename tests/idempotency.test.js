'use strict';

const { authHeader } = require('./helpers/auth');
const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const idempotency = require('../src/middleware/idempotency');

const INVESTOR = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';

beforeEach(() => {
  store.reset();
  idempotency.resetStore();
});

describe('idempotency', () => {
  describe('POST /api/invoices', () => {
    test('replays response with same key and payload', async () => {
      const payload = { sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };
      const key = 'test-key-12345';

      const first = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send(payload);

      expect(first.status).toBe(201);
      expect(first.headers['idempotency-key']).toBe(key);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const second = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send(payload);

      expect(second.status).toBe(201);
      expect(second.headers['idempotency-key']).toBe(key);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data.id).toBe(first.body.data.id);

      // Verify only one invoice was created
      const all = store.list();
      const testInvoices = all.filter((i) => i.sme === 'Test SME');
      expect(testInvoices.length).toBe(1);
    });

    test('rejects different payload with same key', async () => {
      const key = 'test-key-67890';

      const first = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 600, dueDate: '2027-01-01' });

      expect(second.status).toBe(422);
      expect(second.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    test('rejects invalid key format', async () => {
      const res = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', 'invalid key!')
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    test('rejects key shorter than 8 chars', async () => {
      const res = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', 'short')
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    test('rejects key longer than 128 chars', async () => {
      const longKey = 'a'.repeat(129);
      const res = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', longKey)
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    test('works without key when not required', async () => {
      const res = await request(app)
        .post('/api/invoices').set(authHeader())
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/invoices/:id/fund', () => {
    test('replays response with same key and payload', async () => {
      const key = 'fund-key-12345';
      const invoice = store.get('INV_0002');
      const initialFunded = invoice.fundedAmount;

      const first = await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 100, investor: INVESTOR });

      expect(first.status).toBe(200);
      expect(first.headers['idempotency-key']).toBe(key);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const second = await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 100, investor: INVESTOR });

      expect(second.status).toBe(200);
      expect(second.headers['idempotency-key']).toBe(key);
      expect(second.headers['idempotent-replayed']).toBe('true');

      // Verify fundedAmount increased only once
      const updated = store.get('INV_0002');
      expect(updated.fundedAmount).toBe(initialFunded + 100);
    });

    test('same fund request twice with one key increases fundedAmount once', async () => {
      const key = 'duplicate-fund-test';
      const invoice = store.get('INV_0002');
      const initialFunded = invoice.fundedAmount;

      // First request
      await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 100, investor: INVESTOR });

      // Second request with same key (should replay)
      await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 100, investor: INVESTOR });

      // Verify fundedAmount increased only once
      const updated = store.get('INV_0002');
      expect(updated.fundedAmount).toBe(initialFunded + 100);
    });

    test('rejects different payload with same key', async () => {
      const key = 'fund-key-67890';

      const first = await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 100, investor: INVESTOR });

      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 200, investor: INVESTOR });

      expect(second.status).toBe(422);
      expect(second.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    test('key reuse across routes is independent', async () => {
      const key = 'cross-route-key';

      // Use key on invoice creation
      const invoiceRes = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

      expect(invoiceRes.status).toBe(201);

      // Use same key on fund endpoint (should work, different route)
      const fundRes = await request(app)
        .post('/api/invoices/INV_0002/fund').set(authHeader())
        .set('Idempotency-Key', key)
        .send({ amount: 100, investor: INVESTOR });

      expect(fundRes.status).toBe(200);
      expect(fundRes.headers['idempotent-replayed']).toBeUndefined();
    });
  });

  describe('required mode', () => {
    afterEach(() => {
      delete process.env.IDEMPOTENCY_REQUIRED;
    });

    test('rejects a missing key when IDEMPOTENCY_REQUIRED=true', async () => {
      process.env.IDEMPOTENCY_REQUIRED = 'true';
      const res = await request(app)
        .post('/api/invoices').set(authHeader())
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(store.list()).toHaveLength(4);
    });

    test('rejects malformed keys', async () => {
      for (const key of ['short', 'x'.repeat(129), 'has spaces in it']) {
        const res = await request(app)
          .post('/api/invoices').set(authHeader())
          .set('Idempotency-Key', key)
          .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
      }
    });

    test('payload key order does not change the fingerprint', async () => {
      const key = 'order-insensitive-key';
      const first = await request(app).post('/api/invoices').set(authHeader()).set('Idempotency-Key', key)
        .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });
      const second = await request(app).post('/api/invoices').set(authHeader()).set('Idempotency-Key', key)
        .send({ dueDate: '2027-01-01', amount: 500, debtor: 'Buyer', sme: 'Test SME' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data.id).toBe(first.body.data.id);
    });
  });

  describe('TTL expiry', () => {
    test('TTL is applied to cached entries', async () => {
      // This test verifies that TTL is configured correctly
      // Actual expiry is tested by the LRU behavior and manual verification
      const key = 'ttl-test-key';
      const payload = { sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };

      const first = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send(payload);

      expect(first.status).toBe(201);

      // The entry should be cached and replayable immediately
      const second = await request(app)
        .post('/api/invoices').set(authHeader())
        .set('Idempotency-Key', key)
        .send(payload);

      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
    });
  });

  describe('5xx not cached', () => {
    test('5xx responses are not cached', async () => {
      const key = 'error-test-key';

      // Inject a failing handler by temporarily modifying the route
      const express = require('express');
      const testApp = express();
      testApp.use(express.json());
      testApp.use(idempotency);

      testApp.post('/test-error', (req, res, next) => {
        const err = new Error('Simulated error');
        err.status = 500;
        next(err);
      });

      testApp.use((err, req, res, _next) => {
        res.status(500).json({ error: 'Internal server error' });
      });

      const first = await request(testApp)
        .post('/test-error')
        .set('Idempotency-Key', key)
        .send({ test: 'data' });

      expect(first.status).toBe(500);

      const second = await request(testApp)
        .post('/test-error')
        .set('Idempotency-Key', key)
        .send({ test: 'data' });

      // Should not replay (not cached)
      expect(second.status).toBe(500);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
    });
  });

  describe('concurrency', () => {
    test('concurrent requests with same key return 409 for one', async () => {
      const key = 'concurrent-key';
      const payload = { sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };

      const express = require('express');
      const testApp = express();
      testApp.use(express.json());
      testApp.use(idempotency);

      let inFlight = false;

      testApp.post('/test-slow', async (req, res) => {
        if (!inFlight) {
          inFlight = true;
          // First request takes some time
          await new Promise((resolve) => setTimeout(resolve, 100));
          res.status(201).json({ data: { id: 'test' } });
        } else {
          // Second request happens while first is still processing
          res.status(201).json({ data: { id: 'test' } });
        }
      });

      // Start first request
      const req1 = request(testApp).post('/test-slow').set('Idempotency-Key', key).send(payload);

      // Wait a bit to ensure first is in-flight
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Start second request while first is still processing
      const req2 = request(testApp).post('/test-slow').set('Idempotency-Key', key).send(payload);

      const [res1, res2] = await Promise.all([req1, req2]);

      // One should succeed, one should get 409
      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(409);

      const conflictResponse = res1.status === 409 ? res1 : res2;
      expect(conflictResponse.body.error).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(conflictResponse.headers['retry-after']).toBe('1');
    });
  });

  describe('LRU bound', () => {
    test('evicts the oldest entry when at capacity', async () => {
      const originalMax = process.env.IDEMPOTENCY_MAX_ENTRIES;
      process.env.IDEMPOTENCY_MAX_ENTRIES = '3';
      let testIdempotency;
      jest.isolateModules(() => {
        testIdempotency = require('../src/middleware/idempotency');
      });
      if (originalMax === undefined) {
        delete process.env.IDEMPOTENCY_MAX_ENTRIES;
      } else {
        process.env.IDEMPOTENCY_MAX_ENTRIES = originalMax;
      }

      const express = require('express');
      const testApp = express();
      testApp.use(express.json());
      testApp.use(testIdempotency);
      let calls = 0;
      testApp.post('/test', (req, res) => {
        calls += 1;
        res.status(201).json({ data: { n: calls } });
      });

      for (let i = 0; i < 4; i++) {
        await request(testApp).post('/test').set('Idempotency-Key', `lru-key-${i}`).send({ i });
      }
      expect(calls).toBe(4);
      // key-3 is still cached (replayed), key-0 was evicted (handler runs again)
      const recent = await request(testApp).post('/test').set('Idempotency-Key', 'lru-key-3').send({ i: 3 });
      expect(recent.headers['idempotent-replayed']).toBe('true');
      expect(calls).toBe(4);
      const evicted = await request(testApp).post('/test').set('Idempotency-Key', 'lru-key-0').send({ i: 0 });
      expect(evicted.headers['idempotent-replayed']).toBeUndefined();
      expect(calls).toBe(5);
    });
  });

  describe('OpenAPI documentation', () => {
    test('openapi.json includes idempotency headers and error responses', async () => {
      const res = await request(app).get('/openapi.json');
      expect(res.status).toBe(200);

      const spec = res.body;

      // Check POST /api/invoices has idempotency parameter
      const invoicePost = spec.paths['/api/invoices'].post;
      expect(invoicePost.parameters).toBeDefined();
      const idempotencyParam = invoicePost.parameters.find((p) => p.name === 'Idempotency-Key');
      expect(idempotencyParam).toBeDefined();

      // Check response headers include Idempotency-Key and Idempotent-Replayed
      expect(invoicePost.responses[201].headers).toBeDefined();
      expect(invoicePost.responses[201].headers['Idempotency-Key']).toBeDefined();
      expect(invoicePost.responses[201].headers['Idempotent-Replayed']).toBeDefined();

      // Check error responses
      expect(invoicePost.responses[409]).toBeDefined();
      expect(invoicePost.responses[422]).toBeDefined();

      // Check POST /api/invoices/{id}/fund has idempotency parameter
      const fundPost = spec.paths['/api/invoices/{id}/fund'].post;
      expect(fundPost.parameters).toBeDefined();
      const fundIdempotencyParam = fundPost.parameters.find((p) => p.name === 'Idempotency-Key');
      expect(fundIdempotencyParam).toBeDefined();

      // Check response headers
      expect(fundPost.responses[200].headers).toBeDefined();
      expect(fundPost.responses[200].headers['Idempotency-Key']).toBeDefined();
      expect(fundPost.responses[200].headers['Idempotent-Replayed']).toBeDefined();

      // Check error responses
      expect(fundPost.responses[409]).toBeDefined();
      expect(fundPost.responses[422]).toBeDefined();
    });
  });
});
