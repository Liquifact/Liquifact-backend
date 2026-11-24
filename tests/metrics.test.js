'use strict';

const http = require('http');
const app = require('../src/app');

let server;
let baseUrl;

async function req(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text response
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text,
    body,
  };
}

beforeAll((done) => {
  server = http.createServer(app).listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  if (server) {
    server.close(done);
  } else {
    done();
  }
});
const {
  registry,
  Counter,
  Gauge,
  Histogram,
  Registry,
  httpRequestsTotal,
  webhookDeliveriesTotal,
  indexerIngestedTotal,
  indexerLastLedger,
  idempotencyReplaysTotal,
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
} = require('../src/metrics/registry');
const { deliverToWebhook } = require('../src/webhooks/deliver');
const { runOnce } = require('../src/indexer/escrow-indexer');
const idempotency = require('../src/middleware/idempotency');

describe('Prometheus metrics registry & exposition format', () => {
  it('renders Counter, Gauge, and Histogram in valid Prometheus text format', () => {
    const r = new Registry();
    const c = r.register(new Counter({ name: 'test_requests_total', help: 'Test counter', labelNames: ['route'] }));
    const g = r.register(new Gauge({ name: 'test_gauge', help: 'Test gauge' }));
    const h = r.register(
      new Histogram({
        name: 'test_duration_seconds',
        help: 'Test histogram',
        labelNames: ['method'],
        buckets: [0.1, 0.5, 1],
      }),
    );

    c.inc({ route: '/api/test' }, 2);
    g.set(42);
    h.observe({ method: 'GET' }, 0.25);
    h.observe({ method: 'GET' }, 0.75);

    const output = r.render();
    expect(output).toContain('# HELP test_requests_total Test counter');
    expect(output).toContain('# TYPE test_requests_total counter');
    expect(output).toContain('test_requests_total{route="/api/test"} 2');

    expect(output).toContain('# HELP test_gauge Test gauge');
    expect(output).toContain('# TYPE test_gauge gauge');
    expect(output).toContain('test_gauge 42');

    expect(output).toContain('# HELP test_duration_seconds Test histogram');
    expect(output).toContain('# TYPE test_duration_seconds histogram');
    expect(output).toContain('test_duration_seconds_bucket{le="0.1",method="GET"} 0');
    expect(output).toContain('test_duration_seconds_bucket{le="0.5",method="GET"} 1');
    expect(output).toContain('test_duration_seconds_bucket{le="1",method="GET"} 2');
    expect(output).toContain('test_duration_seconds_bucket{le="+Inf",method="GET"} 2');
    expect(output).toContain('test_duration_seconds_sum{method="GET"} 1');
    expect(output).toContain('test_duration_seconds_count{method="GET"} 2');
  });

  it('escapes special characters in label values', () => {
    const r = new Registry();
    const c = r.register(new Counter({ name: 'escape_test_total', help: 'Escape test', labelNames: ['msg'] }));
    c.inc({ msg: 'line1\n"quoted"\\slash' });
    const output = r.render();
    expect(output).toContain('escape_test_total{msg="line1\\n\\"quoted\\"\\\\slash"} 1');
  });
});

describe('GET /metrics authentication & OpenAPI exclusion', () => {
  const originalMetricsToken = process.env.METRICS_TOKEN;
  const originalAdminToken = process.env.ADMIN_API_TOKEN;

  beforeEach(() => {
    registry.reset();
    delete process.env.METRICS_TOKEN;
    delete process.env.ADMIN_API_TOKEN;
  });

  afterAll(() => {
    if (originalMetricsToken !== undefined) {
      process.env.METRICS_TOKEN = originalMetricsToken;
    } else {
      delete process.env.METRICS_TOKEN;
    }
    if (originalAdminToken !== undefined) {
      process.env.ADMIN_API_TOKEN = originalAdminToken;
    } else {
      delete process.env.ADMIN_API_TOKEN;
    }
  });

  it('returns 503 when neither METRICS_TOKEN nor ADMIN_API_TOKEN is configured', async () => {
    const res = await req('/metrics');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('METRICS_TOKEN_NOT_CONFIGURED');
  });

  it('returns 401 when Authorization header is missing or invalid', async () => {
    process.env.METRICS_TOKEN = 'secret-metrics-token';

    const missing = await req('/metrics');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const wrong = await req('/metrics', { Authorization: 'Bearer wrong-token' });
    expect(wrong.status).toBe(401);
  });

  it('returns 200 with Prometheus text exposition when METRICS_TOKEN matches', async () => {
    process.env.METRICS_TOKEN = 'secret-metrics-token';

    const res = await req('/metrics', { Authorization: 'Bearer secret-metrics-token' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toContain('# TYPE webhook_deliveries_total counter');
    expect(res.text).toContain('# TYPE indexer_ingested_total counter');
    expect(res.text).toContain('# TYPE indexer_last_ledger gauge');
    expect(res.text).toContain('# TYPE body_size_limit_rejections_total counter');
    expect(res.text).toContain('# TYPE escrow_indexer_cycle_failures_total counter');
    expect(res.text).toContain('# TYPE escrow_indexer_last_cursor_advance_timestamp_seconds gauge');
  });

  it('falls back to ADMIN_API_TOKEN when METRICS_TOKEN is not set', async () => {
    process.env.ADMIN_API_TOKEN = 'secret-admin-token';

    const res = await req('/metrics', { Authorization: 'Bearer secret-admin-token' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('# TYPE http_requests_total counter');
  });

  it('is absent from OpenAPI public paths', async () => {
    const res = await req('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths).not.toHaveProperty('/metrics');
  });
});

describe('HTTP middleware label cardinality', () => {
  beforeEach(() => {
    registry.reset();
    process.env.METRICS_TOKEN = 'test-metrics-token';
  });

  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it('records route patterns instead of raw paths to bound cardinality', async () => {
    const r1 = await req('/api/invoices/nonexistent-001');
    await req('/api/invoices/nonexistent-002');
    await req('/api/invoices/nonexistent-003');
    await req('/nonexistent/random-path-123');
    await req('/nonexistent/random-path-456');

    const res = await req('/metrics', { Authorization: 'Bearer test-metrics-token' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('route="/api/invoices/:id"');
    expect(res.text).not.toContain('nonexistent-001');
    expect(res.text).not.toContain('nonexistent-002');
    expect(res.text).not.toContain('nonexistent-003');
    expect(res.text).toContain('route="unmatched"');
    expect(res.text).not.toContain('random-path-123');
    expect(httpRequestsTotal.get({ method: 'GET', route: '/api/invoices/:id', status: String(r1.status) })).toBe(3);
    expect(httpRequestsTotal.get({ method: 'GET', route: 'unmatched', status: '404' })).toBe(2);
  });
});

describe('Webhook delivery metrics', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    registry.reset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('increments webhook_deliveries_total{status="delivered"} on 2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });

    const wh = {
      id: 'wh_test_1',
      url: 'https://example.com/hook',
      pinnedUrl: 'https://example.com/hook',
      host: 'example.com',
      secret: 'test-secret-base64url',
    };

    await deliverToWebhook(wh, 'invoice.created', { id: 'inv-1' });
    expect(webhookDeliveriesTotal.get({ status: 'delivered' })).toBe(1);
    expect(webhookDeliveriesTotal.get({ status: 'failed' })).toBe(0);
  });
});

describe('Indexer metrics', () => {
  beforeEach(() => {
    registry.reset();
  });

  function makeMockStore() {
    let cursor = null;
    return {
      getCursor: () => cursor,
      setCursor: (c) => { cursor = c; },
      append: (evts) => evts.length,
    };
  }

  it('updates indexer_ingested_total, indexer_last_ledger, and escrow_indexer_* metrics on runOnce', async () => {
    const store = makeMockStore();
    const fakeServer = {
      getEvents: jest.fn().mockResolvedValue({
        latestLedger: 123456,
        oldestLedger: 100000,
        cursor: 'cursor-1',
        events: [
          // Malformed event to exercise skipped counter
          { id: 'bad-evt', topic: [], value: null },
        ],
      }),
    };

    await runOnce({
      server: fakeServer,
      store,
      contractId: 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P',
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    expect(indexerLastLedger.get()).toBe(123456);
    expect(escrowIndexerLastCursorAdvanceTimestampSeconds.get()).toBeGreaterThan(0);
    expect(indexerIngestedTotal.get()).toBe(1);
    expect(escrowIndexerEventsProcessedTotal.get()).toBe(1);
  });

  it('increments escrow_indexer_cycle_failures_total when RPC getEvents throws', async () => {
    const store = makeMockStore();
    const failingServer = {
      getEvents: jest.fn().mockRejectedValue(new Error('RPC unavailable')),
    };

    await expect(
      runOnce({
        server: failingServer,
        store,
        contractId: 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P',
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }),
    ).rejects.toThrow('RPC unavailable');

    expect(escrowIndexerCycleFailuresTotal.get()).toBe(1);
  });
});

describe('Idempotency replay metrics', () => {
  beforeEach(() => {
    registry.reset();
    idempotency.resetStore();
  });

  it('increments idempotency_replays_total on cached response replay', () => {
    const req = {
      method: 'POST',
      baseUrl: '/api/invoices',
      path: '/',
      ip: '127.0.0.1',
      body: { amount: 100 },
      get: (header) => (header.toLowerCase() === 'idempotency-key' ? 'idem-key-12345678' : undefined),
    };

    const headers1 = {};
    const res1 = {
      statusCode: 201,
      set: (k, v) => { headers1[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { return body; },
    };

    idempotency(req, res1, () => {
      res1.status(201).json({ ok: true });
    });
    expect(idempotencyReplaysTotal.get()).toBe(0);

    const headers2 = {};
    let replayedBody = null;
    const res2 = {
      statusCode: 200,
      set: (k, v) => { headers2[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { replayedBody = body; return body; },
    };

    idempotency(req, res2, () => {
      throw new Error('next() should not be called on replay');
    });

    expect(headers2['Idempotent-Replayed']).toBe('true');
    expect(replayedBody).toEqual({ ok: true });
    expect(idempotencyReplaysTotal.get()).toBe(1);
  });
});
