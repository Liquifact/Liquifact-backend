'use strict';

process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createStandardizedApp } = require('../src/app');

// ── DB Mocking ────────────────────────────────────────────────────────────

jest.mock('../src/db/knex', () => {
  let tableData = [];
  let shouldFail = false;

  const fakeDb = jest.fn((table) => {
    let _tenantId = null;
    let _limit = 20;
    let _offset = 0;
    
    const builder = {
      where(opts) {
        if (opts && opts.tenant_id) _tenantId = opts.tenant_id;
        return builder;
      },
      count() {
        if (shouldFail) return Promise.reject(new Error('DB Error'));
        return Promise.resolve([{ count: tableData.filter(r => !_tenantId || r.tenant_id === _tenantId).length }]);
      },
      select() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit(l) {
        _limit = l;
        return builder;
      },
      offset(o) {
        _offset = o;
        return builder;
      },
      then(resolve, reject) {
        if (shouldFail) {
          // Reject asynchronously to match Knex behaviour
          return Promise.reject(new Error('DB Error')).then(resolve, reject);
        }
        const filtered = tableData.filter(r => !_tenantId || r.tenant_id === _tenantId);
        const sorted = filtered.sort((a, b) => new Date(b.reconciled_at) - new Date(a.reconciled_at));
        const paginated = sorted.slice(_offset, _offset + _limit);
        
        const results = paginated.map(r => ({
          id: r.id,
          total: r.total,
          matches: r.matches,
          mismatches: r.mismatches,
          errors: r.errors,
          reconciled_at: r.reconciled_at,
          created_at: r.created_at
        }));
        
        return Promise.resolve(results).then(resolve, reject);
      }
    };
    return builder;
  });
  
  fakeDb.__setData = (data) => { tableData = data; };
  fakeDb.__setFail = (fail) => { shouldFail = fail; };
  return fakeDb;
}, { virtual: true });

const db = require('../src/db/knex');

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
function makeToken(tenantId) {
  return jwt.sign({ sub: 'admin-user', tenantId }, TEST_SECRET, { expiresIn: '1h' });
}

describe('GET /api/admin/reconciliation/runs', () => {
  let app;

  beforeAll(() => {
    app = createStandardizedApp();
  });
  
  afterEach(() => {
    db.__setData([]);
    db.__setFail(false);
  });

  const generateData = (tenantId, count) => {
    return Array.from({ length: count }, (_, i) => ({
      id: `run_${tenantId}_${i}`,
      tenant_id: tenantId,
      total: 10,
      matches: 9,
      mismatches: 1,
      errors: 0,
      results: JSON.stringify([{ invoiceId: 'inv_1', status: 'mismatch', contractAddress: 'C123', xdr: 'AAAA', ledgerKey: 'L999' }]),
      reconciled_at: new Date(Date.now() - i * 1000).toISOString(),
      created_at: new Date(Date.now() - i * 1000).toISOString(),
    }));
  };

  it('asserts unauthenticated callers get 401', async () => {
    const res = await request(app).get('/api/admin/reconciliation/runs');
    expect(res.status).toBe(401);
  });

  it('asserts rows from another tenant never appear', async () => {
    db.__setData([
      ...generateData('tenantA', 5),
      ...generateData('tenantB', 5)
    ]);

    const res = await request(app)
      .get('/api/admin/reconciliation/runs')
      .set('Authorization', `Bearer ${makeToken('tenantA')}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    res.body.data.forEach(run => {
      expect(run.id).toMatch(/^run_tenantA_/);
    });
    expect(res.body.meta.total).toBe(5);
  });

  it('asserts no contract address, XDR blob, or ledger key appears in success payloads', async () => {
    db.__setData(generateData('tenantA', 1));

    const res = await request(app)
      .get('/api/admin/reconciliation/runs')
      .set('Authorization', `Bearer ${makeToken('tenantA')}`);

    expect(res.status).toBe(200);
    const jsonStr = JSON.stringify(res.body);
    expect(jsonStr).not.toMatch(/contractAddress|C123|xdr|AAAA|ledgerKey|L999/i);
    expect(res.body.data[0]).not.toHaveProperty('results');
  });
  
  describe('pagination bounds clamping', () => {
    beforeEach(() => {
      db.__setData(generateData('tenantA', 150));
    });

    const getToken = () => `Bearer ${makeToken('tenantA')}`;

    it('asserts limit clamping at 0 (invalid)', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=0')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
      expect(JSON.stringify(res.body)).not.toMatch(/contractAddress|C123|xdr|AAAA|ledgerKey|L999/i);
    });

    it('asserts limit clamping at 1', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=1')
        .set('Authorization', getToken());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.limit).toBe(1);
    });

    it('asserts limit clamping at 100', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=100')
        .set('Authorization', getToken());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(100);
      expect(res.body.meta.limit).toBe(100);
    });

    it('asserts limit clamping at 101 (invalid)', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=101')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('asserts limit clamping at negative inputs', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=-5')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('asserts limit clamping at non-numeric inputs', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=abc')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('asserts page parameter invalid values are rejected (0)', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?page=0')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('asserts page parameter invalid values are rejected (negative)', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?page=-1')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('asserts page parameter invalid values are rejected (non-numeric)', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?page=xyz')
        .set('Authorization', getToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('returns empty array when page exceeds total pages', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=100&page=3')
        .set('Authorization', getToken());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.page).toBe(3);
    });
  });

  describe('DB failure', () => {
    it('returns 500 when DB fails and does not leak raw values', async () => {
       db.__setFail(true);
       
       const res = await request(app)
        .get('/api/admin/reconciliation/runs')
        .set('Authorization', `Bearer ${makeToken('tenantA')}`);
        
       expect(res.status).toBe(500);
       expect(JSON.stringify(res.body)).not.toMatch(/contractAddress|C123|xdr|AAAA|ledgerKey|L999/i);
    });
  });
});
