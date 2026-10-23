'use strict';

/**
 * Integration tests for the webhook delivery system.
 *
 * Uses a real HTTP server on localhost as the receiver so no mocking of fetch
 * is needed for delivery, and tests verify the full HMAC signature chain.
 */

const http = require('http');
const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const webhookStore = require('../src/webhooks/store');
const { verifySignature } = require('../src/webhooks/signature');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'test-admin-token-webhook-integration';

/** Sets ADMIN_API_TOKEN for the duration of a test suite. */
function withAdminToken(token = ADMIN_TOKEN) {
  let original;
  beforeAll(() => {
    original = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = token;
  });
  afterAll(() => {
    process.env.ADMIN_API_TOKEN = original;
  });
}

/**
 * Starts a minimal HTTP server that collects incoming POST requests.
 * Returns { server, port, received: [] }.
 */
function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({
        headers: { ...req.headers },
        body,
      });
      res.writeHead(200).end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, received });
    });
  });
}

function stopReceiver(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** Waits for received.length >= n within timeoutMs. */
async function waitFor(received, n, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (received.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webhook delivery', () => {
  withAdminToken();

  let receiver;

  beforeEach(async () => {
    store.reset();
    webhookStore.reset();
    receiver = await startReceiver();
  });

  afterEach(async () => {
    await stopReceiver(receiver.server);
  });

  test('invoice.created is delivered when an invoice is created', async () => {
    // Register webhook for localhost receiver (http allowed in test env)
    const regRes = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ url: `http://127.0.0.1:${receiver.port}/hook`, events: ['invoice.created'] });

    expect(regRes.status).toBe(201);
    const { secret } = regRes.body.data;

    // Create invoice — triggers invoice.created
    const createRes = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer Corp', amount: 1000, dueDate: '2027-06-01' });
    expect(createRes.status).toBe(201);

    await waitFor(receiver.received, 1);
    expect(receiver.received.length).toBeGreaterThanOrEqual(1);

    const call = receiver.received[0];
    const parsed = JSON.parse(call.body);
    expect(parsed.type).toBe('invoice.created');
    expect(parsed.data.invoice.sme).toBe('Test SME');

    // Verify signature
    const sigHeader = call.headers['liquifact-signature'];
    const { ok } = verifySignature(secret, sigHeader, call.body);
    expect(ok).toBe(true);
  });

  test('funding to completion delivers invoice.funding_received then invoice.funded', async () => {
    const regRes = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        url: `http://127.0.0.1:${receiver.port}/hook`,
        events: ['invoice.funding_received', 'invoice.funded'],
      });
    expect(regRes.status).toBe(201);
    const { secret } = regRes.body.data;

    // Fund INV_0001 (amount=100) to completion in one shot
    const fundRes = await request(app)
      .post('/api/invoices/INV_0001/fund')
      .send({ amount: 100, investor: 'GBVBHCYGDUIUKPEYDCBAS47E55NQHGUHGNRVUIZJPI34IH2436XZFZNV' });
    expect(fundRes.status).toBe(200);
    expect(fundRes.body.data.status).toBe('funded');

    // Should receive funding_received and funded
    await waitFor(receiver.received, 2);
    expect(receiver.received.length).toBeGreaterThanOrEqual(2);

    const types = receiver.received.map((r) => JSON.parse(r.body).type);
    expect(types).toContain('invoice.funding_received');
    expect(types).toContain('invoice.funded');

    // Both signatures verify
    for (const call of receiver.received) {
      const sigHeader = call.headers['liquifact-signature'];
      const { ok } = verifySignature(secret, sigHeader, call.body);
      expect(ok).toBe(true);
    }
  });

  test('webhook receiver being down does NOT change POST /api/invoices status', async () => {
    // Register webhook pointing at a port that is not listening
    await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ url: `http://127.0.0.1:1/hook`, events: ['invoice.created'] });

    // Create should still succeed
    const res = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Resilient SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });

    expect(res.status).toBe(201);
  });

  test('partial funding only delivers funding_received, not invoice.funded', async () => {
    const regRes = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        url: `http://127.0.0.1:${receiver.port}/hook`,
        events: ['invoice.funding_received', 'invoice.funded'],
      });
    expect(regRes.status).toBe(201);

    // INV_0002 needs 25000; fund only 1000 (partial)
    const fundRes = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 1000, investor: 'GBVBHCYGDUIUKPEYDCBAS47E55NQHGUHGNRVUIZJPI34IH2436XZFZNV' });
    expect(fundRes.status).toBe(200);
    expect(fundRes.body.data.status).toBe('open');

    await waitFor(receiver.received, 1);
    // Should get exactly one event: funding_received
    const types = receiver.received.map((r) => JSON.parse(r.body).type);
    expect(types).toContain('invoice.funding_received');
    expect(types).not.toContain('invoice.funded');
  });
});

// ---------------------------------------------------------------------------
// Admin route tests
// ---------------------------------------------------------------------------

describe('admin webhook routes', () => {
  beforeEach(() => {
    store.reset();
    webhookStore.reset();
  });

  test('returns 503 when ADMIN_API_TOKEN is not set', async () => {
    const original = process.env.ADMIN_API_TOKEN;
    delete process.env.ADMIN_API_TOKEN;
    const res = await request(app)
      .get('/api/webhooks')
      .set('Authorization', 'Bearer something');
    expect(res.status).toBe(503);
    process.env.ADMIN_API_TOKEN = original;
  });

  test('returns 401 for wrong token', async () => {
    process.env.ADMIN_API_TOKEN = 'correct-token';
    const res = await request(app)
      .get('/api/webhooks')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    delete process.env.ADMIN_API_TOKEN;
  });

  test('POST /api/webhooks creates subscription and returns secret once', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    const res = await request(app)
      .post('/api/webhooks')
      .set('Authorization', 'Bearer tok')
      .send({ url: 'http://localhost:9999/hook', events: ['invoice.created'] });
    expect(res.status).toBe(201);
    const { id, secret, url, events } = res.body.data;
    expect(id).toMatch(/^wh_/);
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(10);
    expect(url).toBe('http://localhost:9999/hook');
    expect(events).toEqual(['invoice.created']);

    // Secret is not in GET response
    const getRes = await request(app)
      .get('/api/webhooks')
      .set('Authorization', 'Bearer tok');
    expect(getRes.status).toBe(200);
    expect(getRes.body.data[0].secret).toBeUndefined();

    delete process.env.ADMIN_API_TOKEN;
  });

  test('GET /api/webhooks lists subscriptions', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    await request(app)
      .post('/api/webhooks')
      .set('Authorization', 'Bearer tok')
      .send({ url: 'http://localhost:9999/hook', events: ['invoice.created'] });
    const res = await request(app)
      .get('/api/webhooks')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    delete process.env.ADMIN_API_TOKEN;
  });

  test('DELETE /api/webhooks/:id removes subscription', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    const create = await request(app)
      .post('/api/webhooks')
      .set('Authorization', 'Bearer tok')
      .send({ url: 'http://localhost:9999/hook', events: ['invoice.created'] });
    const { id } = create.body.data;

    const del = await request(app)
      .delete(`/api/webhooks/${id}`)
      .set('Authorization', 'Bearer tok');
    expect(del.status).toBe(204);

    const list = await request(app)
      .get('/api/webhooks')
      .set('Authorization', 'Bearer tok');
    expect(list.body.data.length).toBe(0);
    delete process.env.ADMIN_API_TOKEN;
  });

  test('DELETE /api/webhooks/:id → 404 for unknown id', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    const res = await request(app)
      .delete('/api/webhooks/wh_nonexistent')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
    delete process.env.ADMIN_API_TOKEN;
  });

  test('POST /api/webhooks rejects unknown event type', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    const res = await request(app)
      .post('/api/webhooks')
      .set('Authorization', 'Bearer tok')
      .send({ url: 'http://localhost:9999/hook', events: ['invoice.deleted'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown event/i);
    delete process.env.ADMIN_API_TOKEN;
  });

  test('POST /api/webhooks rejects https:// pointing to 127.0.0.1', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app)
        .post('/api/webhooks')
        .set('Authorization', 'Bearer tok')
        .send({ url: 'https://127.0.0.1/hook', events: ['invoice.created'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SSRF/);
    } finally {
      delete process.env.ADMIN_API_TOKEN;
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  test('GET /api/webhooks/:id/deliveries returns empty log initially', async () => {
    process.env.ADMIN_API_TOKEN = 'tok';
    const create = await request(app)
      .post('/api/webhooks')
      .set('Authorization', 'Bearer tok')
      .send({ url: 'http://localhost:9999/hook', events: ['invoice.created'] });
    const { id } = create.body.data;

    const res = await request(app)
      .get(`/api/webhooks/${id}/deliveries`)
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    delete process.env.ADMIN_API_TOKEN;
  });
});
