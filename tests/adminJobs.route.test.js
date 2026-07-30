'use strict';

/**
 * @fileoverview Route-level tests for GET /api/admin/jobs
 *
 * Covers:
 *  - Authentication: JWT bearer and API-key, missing/invalid creds → 401/403
 *  - Input validation: limit, sortBy, order, status (invalid values → 400)
 *  - Pagination: first page, hasMore, nextCursor, second page traversal
 *  - Cursor: tampered cursor → 400 with INVALID_CURSOR code
 *  - Filters: status, type query params forwarded to listJobs
 *  - Response shape: data array, meta fields, message string
 *  - DB error path: unhandled error forwarded to next() → 500
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  warn:  jest.fn(),
  error: jest.fn(),
  info:  jest.fn(),
}));
// Prevent prom-client from registering real metrics during tests
jest.mock('prom-client', () => ({
  Counter:  class { constructor() {} inc() {} },
  Gauge:    class { constructor() {} set() {} },
  Registry: class {
    constructor() { this.contentType = 'text/plain'; }
    metrics()     { return Promise.resolve(''); }
    registerMetric() {}
    getMetricsAsJSON() { return []; }
  },
  collectDefaultMetrics: () => {},
}), { virtual: true });

// ── Imports ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const adminJobsRouter = require('../src/routes/adminJobs');
const {
  encodeJobCursor,
  LIST_JOBS_DEFAULT_LIMIT,
  LIST_JOBS_MAX_LIMIT,
} = require('../src/workers/jobPersistence');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;

function makeToken(overrides = {}) {
  return jwt.sign(
    { sub: 'admin-user', tenantId: 'tenant-test', role: 'admin', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h', issuer: 'liquifact', audience: 'liquifact-api' },
  );
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Builds a minimal Express app that mounts the admin jobs router and exposes
 * a simple error handler so test assertions can inspect the status/body on 500.
 *
 * Accepts an optional `db` mock that will be injected via `req._dbClient` so
 * tests can control what listJobs() returns without hitting a real database.
 */
function buildApp(dbMock) {
  const app = express();
  app.use(express.json());

  // Inject the db mock on every request so createJobPersistence picks it up.
  if (dbMock) {
    app.use((req, _res, next) => {
      req._dbClient = dbMock;
      next();
    });
  }

  app.use('/api/admin/jobs', adminJobsRouter);

  // Minimal error handler — surfaces error details for test assertions.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'internal' });
  });
  return app;
}

// ── Fake DB factory ───────────────────────────────────────────────────────────
// Mirrors the in-memory builder in the unit test file — returns a Knex-like
// chainable object whose .then() resolves to a slice of seedRows.

function makeDb(seedRows = []) {
  const rows = seedRows.map((r, i) => ({
    id:           r.id           ?? `job-${String(i).padStart(4, '0')}`,
    type:         r.type         ?? 'test_job',
    status:       r.status       ?? 'pending',
    priority:     r.priority     ?? 0,
    delay_ms:     r.delay_ms     ?? 0,
    created_at:   r.created_at   ?? (1_000_000 + i * 1000),
    started_at:   r.started_at   ?? null,
    completed_at: r.completed_at ?? null,
    attempts:     r.attempts     ?? 0,
    last_error:   r.last_error   ?? null,
    acked_at:     r.acked_at     ?? null,
  }));

  function buildQuery() {
    const state = { _wheres: [], _orders: [], _limit: null };

    const q = {
      select()         { return q; },
      where(colOrFn, val) {
        if (typeof colOrFn === 'function') {
          const sub = buildSubWhere();
          colOrFn.call(sub, sub);
          state._wheres.push({ type: 'group', conditions: sub._conds });
        } else {
          state._wheres.push({ type: 'eq', col: colOrFn, val });
        }
        return q;
      },
      whereIn(col, vals) { state._wheres.push({ type: 'in', col, vals }); return q; },
      whereNull(col)     { state._wheres.push({ type: 'null', col });      return q; },
      orderBy(col, dir)  { state._orders.push({ col, dir: (dir || 'asc').toLowerCase() }); return q; },
      limit(n)           { state._limit = n; return q; },
      then(resolve, reject) {
        return Promise.resolve(applyQuery(rows, state)).then(resolve, reject);
      },
    };
    return q;
  }

  function buildSubWhere() {
    const sub = { _conds: [] };
    sub.where = (col, op, val) => {
      if (val === undefined) { sub._conds.push({ type: 'eq', col, val: op }); }
      else                   { sub._conds.push({ type: 'op', col, op, val }); }
      return sub;
    };
    sub.orWhere = (fn) => {
      const inner = buildSubWhere();
      fn.call(inner, inner);
      sub._conds.push({ type: 'or_group', conds: inner._conds });
      return sub;
    };
    return sub;
  }

  function applyQuery(src, state) {
    let result = src.slice();
    for (const w of state._wheres) { result = result.filter((row) => evalWhere(row, w)); }
    if (state._orders.length > 0) {
      result.sort((a, b) => {
        for (const { col, dir } of state._orders) {
          const av = a[col] ?? ''; const bv = b[col] ?? '';
          if (av < bv) { return dir === 'asc' ? -1 :  1; }
          if (av > bv) { return dir === 'asc' ?  1 : -1; }
        }
        return 0;
      });
    }
    if (state._limit !== null) { result = result.slice(0, state._limit); }
    return result;
  }

  function evalWhere(row, w) {
    if (w.type === 'eq')  { return row[w.col] === w.val; }
    if (w.type === 'in')  { return w.vals.includes(row[w.col]); }
    if (w.type === 'null'){ return row[w.col] == null; }
    if (w.type === 'group') {
      return evalConds(row, w.conditions);
    }
    return true;
  }

  function evalConds(row, conds) {
    let ok = true;
    for (const c of conds) {
      if (c.type === 'eq') { ok = ok && row[c.col] === c.val; }
      if (c.type === 'op') {
        const rv = row[c.col];
        if (c.op === '>') { ok = ok && rv >  c.val; }
        if (c.op === '<') { ok = ok && rv <  c.val; }
        if (c.op === '=') { ok = ok && rv === c.val; }
      }
      if (c.type === 'or_group') {
        const orOk = c.conds.some((sc) => {
          if (sc.type === 'eq') { return row[sc.col] === sc.val; }
          if (sc.type === 'op') {
            const rv = row[sc.col];
            if (sc.op === '>') { return rv >  sc.val; }
            if (sc.op === '<') { return rv <  sc.val; }
            if (sc.op === '=') { return rv === sc.val; }
          }
          return false;
        });
        ok = ok && orOk;
      }
    }
    return ok;
  }

  const db = jest.fn(() => buildQuery());
  db._rows = rows;
  return db;
}

// ── Authentication tests ──────────────────────────────────────────────────────

describe('GET /api/admin/jobs — authentication', () => {
  const app = buildApp(makeDb([]));

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/admin/jobs');
    if(res.status !== 401) console.log('BODY:', res.body); expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed Bearer token', async () => {
    const res = await request(app)
      .get('/api/admin/jobs')
      .set('Authorization', 'Bearer not.a.real.token');
    if(res.status !== 401) console.log('BODY:', res.body); expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const expired = jwt.sign(
      { sub: 'u', tenantId: 't' },
      JWT_SECRET,
      { expiresIn: -1, issuer: 'liquifact', audience: 'liquifact-api' },
    );
    const res = await request(app)
      .get('/api/admin/jobs')
      .set(...Object.entries(authHeader(expired))[0]);
    if(res.status !== 401) console.log('BODY:', res.body); expect(res.status).toBe(401);
  });

  it('returns 200 for a valid JWT bearer token', async () => {
    const res = await request(app)
      .get('/api/admin/jobs')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
  });

  it('returns 401 for a wrong API key', async () => {
    const res = await request(app)
      .get('/api/admin/jobs')
      .set('x-api-key', 'lf_not_a_real_key_xyz');
    if(res.status !== 401) console.log('BODY:', res.body); expect(res.status).toBe(401);
  });
});

// ── Input validation tests ────────────────────────────────────────────────────

describe('GET /api/admin/jobs — input validation', () => {
  const token = makeToken();
  const app   = buildApp(makeDb([]));

  it('rejects limit=0 with 400', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?limit=0')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.error).toMatch(/INVALID_PAGINATION/i);
  });

  it('rejects limit=-1 with 400', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?limit=-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it(`rejects limit > ${LIST_JOBS_MAX_LIMIT} with 400`, async () => {
    const res = await request(app)
      .get(`/api/admin/jobs?limit=${LIST_JOBS_MAX_LIMIT + 1}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('rejects limit=abc (non-numeric) with 400', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?limit=abc')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('rejects unknown sortBy value with 400', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?sortBy=unknown_column')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.error).toMatch(/INVALID_PAGINATION/i);
  });

  it('rejects invalid order value with 400', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?order=sideways')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('rejects invalid status value with 400', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?status=not_a_status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('accepts valid limit within bounds', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?limit=10')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('accepts all valid sortBy values', async () => {
    const fields = ['created_at', 'status', 'type', 'attempts'];
    for (const f of fields) {
      const res = await request(app)
        .get(`/api/admin/jobs?sortBy=${f}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  });

  it('accepts order=asc and order=desc', async () => {
    for (const o of ['asc', 'desc']) {
      const res = await request(app)
        .get(`/api/admin/jobs?order=${o}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  });

  it('accepts valid status values', async () => {
    const statuses = ['pending', 'processing', 'completed', 'failed', 'retrying'];
    for (const s of statuses) {
      const res = await request(app)
        .get(`/api/admin/jobs?status=${s}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  });
});

// ── Response shape tests ──────────────────────────────────────────────────────

describe('GET /api/admin/jobs — response shape', () => {
  const token = makeToken();

  it('returns data array, meta object, and message string', async () => {
    const db  = makeDb([{ id: 'job-0001', created_at: 1_000_000 }]);
    const app = buildApp(db);

    const res = await request(app)
      .get('/api/admin/jobs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.meta).toBe('object');
    expect(typeof res.body.message).toBe('string');
  });

  it('meta contains limit, hasMore, nextCursor', async () => {
    const db  = makeDb([]);
    const app = buildApp(db);

    const res = await request(app)
      .get('/api/admin/jobs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.meta).toMatchObject({
      limit:      expect.any(Number),
      hasMore:    expect.any(Boolean),
      nextCursor: null,
    });
  });

  it('uses LIST_JOBS_DEFAULT_LIMIT when limit is omitted', async () => {
    const db  = makeDb([]);
    const app = buildApp(db);

    const res = await request(app)
      .get('/api/admin/jobs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.meta.limit).toBe(LIST_JOBS_DEFAULT_LIMIT);
  });

  it('returned job rows do not contain payload field', async () => {
    const db  = makeDb([{ id: 'job-x', payload: '{"secret":"val"}' }]);
    const app = buildApp(db);

    const res = await request(app)
      .get('/api/admin/jobs?limit=5')
      .set('Authorization', `Bearer ${token}`);

    for (const row of res.body.data) {
      expect(row).not.toHaveProperty('payload');
    }
  });
});

// ── Pagination behaviour tests ────────────────────────────────────────────────

describe('GET /api/admin/jobs — pagination', () => {
  const token = makeToken();

  function makeRows(count) {
    return Array.from({ length: count }, (_, i) => ({
      id:         `job-${String(i).padStart(4, '0')}`,
      created_at: 1_000_000 + i * 1000,
    }));
  }

  it('hasMore=false and nextCursor=null when rows < limit', async () => {
    const app = buildApp(makeDb(makeRows(3)));
    const res = await request(app)
      .get('/api/admin/jobs?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it('hasMore=false and nextCursor=null when rows === limit (exact boundary)', async () => {
    const app = buildApp(makeDb(makeRows(10)));
    const res = await request(app)
      .get('/api/admin/jobs?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it('hasMore=true and nextCursor is a string when rows > limit', async () => {
    const app = buildApp(makeDb(makeRows(11)));
    const res = await request(app)
      .get('/api/admin/jobs?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.meta.hasMore).toBe(true);
    expect(typeof res.body.meta.nextCursor).toBe('string');
  });

  it('second page uses nextCursor from first page and has no overlap', async () => {
    const db = makeDb(makeRows(25));

    const app = buildApp(db);
    const res1 = await request(app)
      .get('/api/admin/jobs?limit=10&order=desc')
      .set('Authorization', `Bearer ${token}`);
    expect(res1.status).toBe(200);
    expect(res1.body.meta.hasMore).toBe(true);

    const cursor = res1.body.meta.nextCursor;
    const res2 = await request(app)
      .get(`/api/admin/jobs?limit=10&order=desc&cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res2.status).toBe(200);

    const ids1 = new Set(res1.body.data.map((r) => r.id));
    const ids2 = new Set(res2.body.data.map((r) => r.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    expect(overlap).toHaveLength(0);
  });

  it('three pages cover all 25 rows without duplication', async () => {
    const db  = makeDb(makeRows(25));
    const app = buildApp(db);

    const p1 = await request(app)
      .get('/api/admin/jobs?limit=10&order=asc')
      .set('Authorization', `Bearer ${token}`);
    const p2 = await request(app)
      .get(`/api/admin/jobs?limit=10&order=asc&cursor=${encodeURIComponent(p1.body.meta.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`);
    const p3 = await request(app)
      .get(`/api/admin/jobs?limit=10&order=asc&cursor=${encodeURIComponent(p2.body.meta.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(p3.body.meta.hasMore).toBe(false);
    const allIds = [
      ...p1.body.data.map((r) => r.id),
      ...p2.body.data.map((r) => r.id),
      ...p3.body.data.map((r) => r.id),
    ];
    expect(new Set(allIds).size).toBe(25);
  });
});

// ── Invalid cursor tests ──────────────────────────────────────────────────────

describe('GET /api/admin/jobs — invalid cursor', () => {
  const token = makeToken();
  const app   = buildApp(makeDb([]));

  it('returns 400 with INVALID_CURSOR code for a tampered cursor', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?cursor=totally.invalid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.error).toMatch(/INVALID_CURSOR/i);
  });

  it('returns 400 for a cursor with no dot separator', async () => {
    const res = await request(app)
      .get('/api/admin/jobs?cursor=nodothere')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when cursor order mismatches the requested order', async () => {
    // Build a valid asc cursor
    const validCursor = encodeJobCursor({
      sortField: 'created_at',
      sortValue: 1_000_000,
      id:        'job-0001',
      order:     'asc',
    });

    // Use with order=desc — mismatched
    const res = await request(app)
      .get(`/api/admin/jobs?order=desc&cursor=${encodeURIComponent(validCursor)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.error).toMatch(/INVALID_CURSOR/i);
  });
});

// ── Filter forwarding tests ───────────────────────────────────────────────────

describe('GET /api/admin/jobs — filters', () => {
  const token = makeToken();

  const ROWS = [
    { id: 'job-p1', status: 'pending',   type: 'send_email', created_at: 1000 },
    { id: 'job-p2', status: 'pending',   type: 'audit',      created_at: 2000 },
    { id: 'job-c1', status: 'completed', type: 'send_email', created_at: 3000 },
  ];

  it('status filter returns only matching rows', async () => {
    const app = buildApp(makeDb(ROWS));
    const res = await request(app)
      .get('/api/admin/jobs?status=pending')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r) => r.status === 'pending')).toBe(true);
  });

  it('type filter returns only matching rows', async () => {
    const app = buildApp(makeDb(ROWS));
    const res = await request(app)
      .get('/api/admin/jobs?type=audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('job-p2');
  });

  it('combined status + type filter returns only matching rows', async () => {
    const app = buildApp(makeDb(ROWS));
    const res = await request(app)
      .get('/api/admin/jobs?status=pending&type=send_email')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('job-p1');
  });
});

// ── DB error path ─────────────────────────────────────────────────────────────

describe('GET /api/admin/jobs — DB error path', () => {
  const token = makeToken();

  it('forwards unhandled DB errors to next() → 500', async () => {
    // DB mock that throws on any table call
    const brokenDb = jest.fn(() => {
      throw new Error('DB connection lost');
    });

    const app = buildApp(brokenDb);
    const res = await request(app)
      .get('/api/admin/jobs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
  });
});
