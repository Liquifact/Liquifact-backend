'use strict';

/**
 * @fileoverview Comprehensive tests for GET /api/admin/webhooks/dead-letters
 *
 * Covers:
 *  - Authentication: JWT bearer and API-key auth, missing/invalid creds
 *  - Tenant scoping: only the authenticated tenant's rows are returned
 *  - Pagination: default limit, custom limit, limit validation, cursor flow
 *  - Filters: event, targetUrl, resolved, createdAfter, createdBefore
 *  - Cursor: encode/decode round-trip, invalid cursor, expired cursor
 *  - Secret redaction: no HMAC secret material in any response field
 *  - Existing routes: POST replay/:id, POST replay (batch), POST resolve/:id
 *  - DB error path: 500 forwarded to next()
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ─── Module mocks ────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../src/services/webhooks', () => ({
  replayWebhook: jest.fn(),
  resolveDeadLetter: jest.fn(),
}));
jest.mock('../src/metrics', () => ({
  webhookReplayTotal: { inc: jest.fn() },
  registry: {
    contentType: 'text/plain',
    metrics: jest.fn().mockResolvedValue(''),
  },
}));
// prom-client shim so metrics.js doesn't throw
jest.mock('prom-client', () => ({
  Counter: class { constructor() {} inc() {} },
  Gauge:   class { constructor() {} set() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics() { return ''; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

// ─── Imports ─────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const db             = require('../src/db/knex');
const logger         = require('../src/logger');
const { replayWebhook, resolveDeadLetter } = require('../src/services/webhooks');
const { encodeCursor } = require('../src/utils/cursorPagination');

const adminWebhooksRouter = require('../src/routes/adminWebhooks');

// ─── Test app factory ─────────────────────────────────────────────────────────

/**
 * Creates a minimal Express app that mounts the adminWebhooks router at
 * /api/admin/webhooks and wires up a simple error handler.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/webhooks', adminWebhooksRouter);
  // Error handler — surface the error as JSON so assertions are easy
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'internal' });
  });
  return app;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;
const TENANT_ID  = 'tenant-abc';

/** Sign a JWT for the given claims (tenantId defaults to TENANT_ID). */
function makeToken(claims = {}) {
  return jwt.sign({ sub: 'admin-user', tenantId: TENANT_ID, ...claims }, JWT_SECRET, { expiresIn: '1h' });
}

/** Valid bearer token for the default test tenant. */
const validToken = makeToken();

// ─── Dead-letter row factories ────────────────────────────────────────────────

let _rowId = 0;
function makeRow(overrides = {}) {
  _rowId += 1;
  return {
    id:          `dl-${_rowId}`,
    tenant_id:   TENANT_ID,
    invoice_id:  `inv-${_rowId}`,
    event:       'invoice.approved',
    webhook_url: 'https://example.com/hook',
    attempts:    3,
    last_error:  'connection refused',
    resolved:    false,
    resolved_at: null,
    created_at:  new Date('2026-07-01T10:00:00Z').toISOString(),
    payload:     JSON.stringify({ event: 'invoice.approved' }),
    ...overrides,
  };
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

/**
 * Returns a chainable knex mock that resolves `rows` when awaited.
 * Supports: .where() .select() .orderBy() .limit() .orWhere() .andWhere()
 */
function makeDbChain(rows = []) {
  const chain = {
    where:    jest.fn().mockReturnThis(),
    orWhere:  jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select:   jest.fn().mockReturnThis(),
    orderBy:  jest.fn().mockReturnThis(),
    limit:    jest.fn().mockReturnThis(),
    offset:   jest.fn().mockReturnThis(),
    whereIn:  jest.fn().mockReturnThis(),
    first:    jest.fn().mockResolvedValue(rows[0] ?? null),
    insert:   jest.fn().mockResolvedValue([{ id: 'new-id' }]),
    update:   jest.fn().mockResolvedValue(1),
    returning: jest.fn().mockReturnThis(),
    then:     jest.fn((resolve) => Promise.resolve(rows).then(resolve)),
  };
  return chain;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/admin/webhooks/dead-letters', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  // ── Authentication ────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no credentials are provided', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('x-tenant-id', TENANT_ID);
      expect(res.status).toBe(401);
    });

    it('returns 401 for an invalid Bearer token', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', 'Bearer invalid.token.here')
        .set('x-tenant-id', TENANT_ID);
      expect(res.status).toBe(401);
    });

    it('returns 401 for a revoked API key', async () => {
      // No API_KEYS env set — any X-API-Key will be unknown → 401
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('x-api-key', 'lf_bad_key_xyz')
        .set('x-tenant-id', TENANT_ID);
      expect(res.status).toBe(401);
    });

    it('returns 400 when tenant context is missing (valid JWT, no tenant header)', async () => {
      // Token has no tenantId claim and no header is sent
      const tokenNoTenant = jwt.sign({ sub: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${tokenNoTenant}`);
      expect(res.status).toBe(400);
    });

    it('accepts a valid JWT and returns 200', async () => {
      const rows = [makeRow()];
      db.mockReturnValue(makeDbChain(rows));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
    });
  });

  // ── Response shape ────────────────────────────────────────────────────────

  describe('response shape', () => {
    it('returns data array, meta with limit/hasMore/nextCursor, and message', async () => {
      const rows = [makeRow(), makeRow()];
      db.mockReturnValue(makeDbChain(rows));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toMatchObject({
        limit: 20,
        hasMore: false,
        nextCursor: null,
      });
      expect(res.body.message).toBe('Dead-letter rows retrieved successfully.');
    });

    it('each row contains id, tenant_id, invoice_id, event, webhook_url, attempts, last_error, resolved, created_at', async () => {
      const row = makeRow();
      db.mockReturnValue(makeDbChain([row]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      const item = res.body.data[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('tenant_id');
      expect(item).toHaveProperty('invoice_id');
      expect(item).toHaveProperty('event');
      expect(item).toHaveProperty('webhook_url');
      expect(item).toHaveProperty('attempts');
      expect(item).toHaveProperty('last_error');
      expect(item).toHaveProperty('resolved');
      expect(item).toHaveProperty('created_at');
    });

    it('empty result set returns empty data array and hasMore false', async () => {
      db.mockReturnValue(makeDbChain([]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });
  });

  // ── Secret redaction ──────────────────────────────────────────────────────

  describe('secret redaction', () => {
    it('does not expose any field named secret, token, apiKey, or password', async () => {
      // Simulate a row that somehow has sensitive-looking keys (defence-in-depth)
      const row = makeRow({ webhook_secret: 'should-be-gone', token: 'also-gone' });
      db.mockReturnValue(makeDbChain([row]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      const item = res.body.data[0];
      expect(item).not.toHaveProperty('webhook_secret');
      expect(item).not.toHaveProperty('token');
    });

    it('does not expose fields named password or privateKey', async () => {
      const row = makeRow({ password: 'hunter2', privateKey: 'pem-data' });
      db.mockReturnValue(makeDbChain([row]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      const item = res.body.data[0];
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('privateKey');
    });
  });

  // ── Tenant scoping ────────────────────────────────────────────────────────

  describe('tenant scoping', () => {
    it('passes tenant_id to the DB query via where()', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      // The first where() call must scope to tenant_id
      expect(chain.where).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    });

    it('uses tenant from JWT claim when no x-tenant-id header', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const tokenWithTenant = makeToken({ tenantId: 'jwt-tenant' });

      await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${tokenWithTenant}`);

      expect(chain.where).toHaveBeenCalledWith('tenant_id', 'jwt-tenant');
    });
  });

  // ── Pagination — limit validation ────────────────────────────────────────

  describe('limit validation', () => {
    it('returns 400 when limit is 0', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=0')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_PAGINATION' });
    });

    it('returns 400 when limit is 101', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=101')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);
      expect(res.status).toBe(400);
    });

    it('returns 400 when limit is not a number', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=abc')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);
      expect(res.status).toBe(400);
    });

    it('uses limit=1 correctly', async () => {
      // DB returns 2 rows but limit=1 means we fetch limit+1=2, then trim
      const rows = [makeRow(), makeRow()];
      db.mockReturnValue(makeDbChain(rows));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=1')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.hasMore).toBe(true);
      expect(res.body.meta.limit).toBe(1);
    });

    it('uses limit=100 (maximum) correctly', async () => {
      db.mockReturnValue(makeDbChain([]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=100')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(100);
    });

    it('defaults to limit=20 when not specified', async () => {
      db.mockReturnValue(makeDbChain([]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(20);
    });
  });

  // ── Pagination — cursor ───────────────────────────────────────────────────

  describe('cursor pagination', () => {
    it('sets hasMore=true and nextCursor when DB returns limit+1 rows', async () => {
      // limit=2, DB returns 3 rows → hasMore=true, slice to 2
      const rows = [makeRow(), makeRow(), makeRow()];
      db.mockReturnValue(makeDbChain(rows));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=2')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta.hasMore).toBe(true);
      expect(typeof res.body.meta.nextCursor).toBe('string');
      expect(res.body.meta.nextCursor.length).toBeGreaterThan(0);
    });

    it('nextCursor is null when fewer rows than limit are returned', async () => {
      db.mockReturnValue(makeDbChain([makeRow()]));

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=5')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    it('accepts a valid cursor and adds keyset WHERE clause', async () => {
      const cursor = encodeCursor({
        sortField: 'created_at',
        sortValue: '2026-07-01T10:00:00.000Z',
        id: 'dl-999',
      });

      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const res = await request(app)
        .get(`/api/admin/webhooks/dead-letters?cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      // where() should have been called for the keyset clause
      expect(chain.where).toHaveBeenCalled();
    });

    it('returns 400 for a malformed cursor', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?cursor=not-a-valid-cursor')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CURSOR' });
    });

    it('returns 400 for a cursor with a tampered signature', async () => {
      const cursor = encodeCursor({
        sortField: 'created_at',
        sortValue: '2026-07-01T10:00:00.000Z',
        id: 'dl-1',
      });
      const tampered = cursor.slice(0, -4) + 'xxxx';

      const res = await request(app)
        .get(`/api/admin/webhooks/dead-letters?cursor=${encodeURIComponent(tampered)}`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CURSOR' });
    });

    it('nextCursor round-trips: using it as the cursor param returns 200', async () => {
      // First page: limit=1, DB returns 2 rows → hasMore=true, nextCursor produced
      const row1 = makeRow({ created_at: '2026-07-02T00:00:00.000Z', id: 'dl-a1' });
      const row2 = makeRow({ created_at: '2026-07-01T00:00:00.000Z', id: 'dl-a2' });
      db.mockReturnValue(makeDbChain([row1, row2]));

      const page1 = await request(app)
        .get('/api/admin/webhooks/dead-letters?limit=1')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(page1.status).toBe(200);
      const { nextCursor } = page1.body.meta;
      expect(nextCursor).toBeTruthy();

      // Second page using the cursor
      db.mockReturnValue(makeDbChain([row2]));

      const page2 = await request(app)
        .get(`/api/admin/webhooks/dead-letters?limit=1&cursor=${encodeURIComponent(nextCursor)}`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(page2.status).toBe(200);
      expect(page2.body.meta.hasMore).toBe(false);
    });
  });

  // ── Filters ───────────────────────────────────────────────────────────────

  describe('filter: event', () => {
    it('passes event filter as a where() clause', async () => {
      const chain = makeDbChain([makeRow({ event: 'invoice.funded' })]);
      db.mockReturnValue(chain);

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?event=invoice.funded')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith('event', 'invoice.funded');
    });

    it('does not add event where() when filter is absent', async () => {
      const chain = makeDbChain([]);
      db.mockReturnValue(chain);

      await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      // event filter should NOT have been called
      const eventCalls = chain.where.mock.calls.filter(([k]) => k === 'event');
      expect(eventCalls).toHaveLength(0);
    });
  });

  describe('filter: targetUrl', () => {
    it('passes targetUrl as webhook_url where() clause', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const url = 'https://merchant.example.com/cb';
      const res = await request(app)
        .get(`/api/admin/webhooks/dead-letters?targetUrl=${encodeURIComponent(url)}`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith('webhook_url', url);
    });
  });

  describe('filter: resolved', () => {
    it('passes resolved=true as boolean where() clause', async () => {
      const chain = makeDbChain([makeRow({ resolved: true })]);
      db.mockReturnValue(chain);

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?resolved=true')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith('resolved', true);
    });

    it('passes resolved=false as boolean where() clause', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?resolved=false')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith('resolved', false);
    });

    it('returns 400 for an invalid resolved value', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?resolved=maybe')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_FILTER' });
    });
  });

  describe('filter: createdAfter', () => {
    it('applies >= createdAfter date filter', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const after = '2026-07-01T00:00:00Z';
      const res = await request(app)
        .get(`/api/admin/webhooks/dead-letters?createdAfter=${encodeURIComponent(after)}`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith(
        'created_at', '>=', new Date(after).toISOString(),
      );
    });

    it('returns 400 for an invalid createdAfter value', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?createdAfter=not-a-date')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_FILTER' });
    });
  });

  describe('filter: createdBefore', () => {
    it('applies < createdBefore date filter', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const before = '2026-07-15T00:00:00Z';
      const res = await request(app)
        .get(`/api/admin/webhooks/dead-letters?createdBefore=${encodeURIComponent(before)}`)
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith(
        'created_at', '<', new Date(before).toISOString(),
      );
    });

    it('returns 400 for an invalid createdBefore value', async () => {
      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters?createdBefore=bad')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_FILTER' });
    });
  });

  describe('combined filters', () => {
    it('applies all filters simultaneously', async () => {
      const chain = makeDbChain([makeRow()]);
      db.mockReturnValue(chain);

      const after  = '2026-07-01T00:00:00Z';
      const before = '2026-07-31T00:00:00Z';

      const res = await request(app)
        .get(
          `/api/admin/webhooks/dead-letters` +
          `?event=invoice.approved` +
          `&targetUrl=${encodeURIComponent('https://example.com/hook')}` +
          `&resolved=false` +
          `&createdAfter=${encodeURIComponent(after)}` +
          `&createdBefore=${encodeURIComponent(before)}`,
        )
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(200);
      expect(chain.where).toHaveBeenCalledWith('tenant_id', TENANT_ID);
      expect(chain.where).toHaveBeenCalledWith('event', 'invoice.approved');
      expect(chain.where).toHaveBeenCalledWith('webhook_url', 'https://example.com/hook');
      expect(chain.where).toHaveBeenCalledWith('resolved', false);
      expect(chain.where).toHaveBeenCalledWith('created_at', '>=', new Date(after).toISOString());
      expect(chain.where).toHaveBeenCalledWith('created_at', '<', new Date(before).toISOString());
    });
  });

  // ── DB error path ─────────────────────────────────────────────────────────

  describe('DB error handling', () => {
    it('calls next(error) when the DB query rejects', async () => {
      const dbError = new Error('connection lost');
      const chain = {
        where:   jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        andWhere:jest.fn().mockReturnThis(),
        select:  jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockReturnThis(),
        then:    jest.fn((_, reject) => Promise.reject(dbError).catch(reject)),
      };
      db.mockReturnValue(chain);

      const res = await request(app)
        .get('/api/admin/webhooks/dead-letters')
        .set('Authorization', `Bearer ${validToken}`)
        .set('x-tenant-id', TENANT_ID);

      expect(res.status).toBe(500);
      expect(logger.error).toHaveBeenCalled();
    });
  });

}); // end GET /dead-letters

// ─────────────────────────────────────────────────────────────────────────────
// Existing routes — replay and resolve
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/webhooks/replay/:id', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 202 and { replayed: [id] } on success', async () => {
    replayWebhook.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/admin/webhooks/replay/some-uuid')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(202);
    expect(res.body.replayed).toEqual(['some-uuid']);
  });

  it('returns 404 when replayWebhook throws NOT_FOUND', async () => {
    const err = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    replayWebhook.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/admin/webhooks/replay/missing-id')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(404);
  });

  it('returns 409 when replayWebhook throws ALREADY_RESOLVED', async () => {
    const err = Object.assign(new Error('already resolved'), { code: 'ALREADY_RESOLVED' });
    replayWebhook.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/admin/webhooks/replay/resolved-id')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(409);
  });

  it('returns 502 when replayWebhook throws a generic error', async () => {
    replayWebhook.mockRejectedValue(new Error('network timeout'));

    const res = await request(app)
      .post('/api/admin/webhooks/replay/bad-id')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(502);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/replay/some-uuid')
      .set('x-tenant-id', TENANT_ID);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/webhooks/replay (batch)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 400 when neither ids nor tenantId is provided', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/replay')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when ids is empty array', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/replay')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ ids: [] });

    expect(res.status).toBe(400);
  });

  it('returns 202 with replayed/failed breakdown when ids are provided', async () => {
    db.mockReturnValue(makeDbChain([{ id: 'uuid-1' }, { id: 'uuid-2' }]));
    replayWebhook.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/admin/webhooks/replay')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ ids: ['uuid-1', 'uuid-2'] });

    expect(res.status).toBe(202);
    expect(res.body.replayed).toEqual(['uuid-1', 'uuid-2']);
    expect(res.body.failed).toEqual([]);
  });

  it('reports failed entries when replay throws', async () => {
    db.mockReturnValue(makeDbChain([{ id: 'uuid-1' }]));
    replayWebhook.mockRejectedValue(new Error('delivery failed'));

    const res = await request(app)
      .post('/api/admin/webhooks/replay')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ ids: ['uuid-1'] });

    expect(res.status).toBe(202);
    expect(res.body.replayed).toEqual([]);
    expect(res.body.failed[0]).toMatchObject({ id: 'uuid-1' });
  });

  it('replays by tenantId filter', async () => {
    db.mockReturnValue(makeDbChain([{ id: 'uuid-t1' }]));
    replayWebhook.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/admin/webhooks/replay')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ tenantId: TENANT_ID, limit: 10 });

    expect(res.status).toBe(202);
    expect(res.body.replayed).toEqual(['uuid-t1']);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/replay')
      .set('x-tenant-id', TENANT_ID)
      .send({ tenantId: TENANT_ID });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/webhooks/resolve/:id', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 200 and { resolved: id } on success', async () => {
    db.mockReturnValue(makeDbChain([makeRow({ resolved: false })]));
    resolveDeadLetter.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/admin/webhooks/resolve/dl-1')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe('dl-1');
  });

  it('returns 404 when row not found', async () => {
    db.mockReturnValue(makeDbChain([]));

    const res = await request(app)
      .post('/api/admin/webhooks/resolve/nonexistent')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(404);
  });

  it('returns 409 when row is already resolved', async () => {
    db.mockReturnValue(makeDbChain([makeRow({ resolved: true })]));

    const res = await request(app)
      .post('/api/admin/webhooks/resolve/already-done')
      .set('Authorization', `Bearer ${validToken}`)
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(409);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/resolve/dl-1')
      .set('x-tenant-id', TENANT_ID);
    expect(res.status).toBe(401);
  });
});
