'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { validateInvoice } = require('../src/routes/invoices');
const { parseIsoDate } = require('../src/lib/dates');

beforeEach(() => store.reset());

// ---------------------------------------------------------------------------
// Fixed clock used for unit tests: 2026-10-20T00:00:00Z = 1761523200000 ms
// ---------------------------------------------------------------------------
const FIXED_NOW_MS = Date.UTC(2026, 9, 20); // Oct 20 2026 00:00:00 UTC

describe('system', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET / lists endpoints and contract', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.length).toBeGreaterThan(5);
    expect(res.body.contract.id).toMatch(/^C[A-Z0-9]{55}$/);
  });

  test('GET /docs and /openapi.json', async () => {
    const docs = await request(app).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui');
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/api/invoices');
  });

  test('unknown route is a JSON 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });

  // Asserts that every new/changed schema element introduced by #1531 is
  // present in the served OpenAPI document.
  test('openapi.json contains maturity field, dueBefore/dueAfter params, and ValidationErrorBody', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);

    const spec = res.body;
    const invoiceSchema =
      spec.paths['/api/invoices'].post.responses['201'].content['application/json'].schema;
    // Invoice object (nested under data property)
    const invoiceDef = invoiceSchema.properties.data;
    expect(invoiceDef.properties.maturity).toBeDefined();
    expect(invoiceDef.properties.maturity.type).toBe('integer');

    // dueBefore and dueAfter query params on GET /api/invoices
    const getParams = spec.paths['/api/invoices'].get.parameters;
    const paramNames = getParams.map((p) => p.name);
    expect(paramNames).toContain('dueBefore');
    expect(paramNames).toContain('dueAfter');

    // POST /api/invoices 400 response uses ValidationErrorBody (has details array)
    const post400 =
      spec.paths['/api/invoices'].post.responses['400'].content['application/json'].schema;
    expect(post400.properties.details).toBeDefined();
    expect(post400.properties.details.type).toBe('array');
  });
});

describe('invoices', () => {
  test('list and filter', async () => {
    const all = await request(app).get('/api/invoices');
    expect(all.body.count).toBe(4);
    const open = await request(app).get('/api/invoices?status=open');
    expect(open.body.data.every((i) => i.status === 'open')).toBe(true);
    const bad = await request(app).get('/api/invoices?status=weird');
    expect(bad.status).toBe(400);
  });

  test('get by id', async () => {
    expect((await request(app).get('/api/invoices/INV_0001')).status).toBe(200);
    expect((await request(app).get('/api/invoices/missing')).status).toBe(404);
  });

  // Updated per #1531: response now includes maturity; dueDate must be future.
  // dueDate '2028-06-01' is far enough ahead to be safe regardless of wall clock.
  test('create validates and stores', async () => {
    const bad = await request(app).post('/api/invoices').send({ sme: '' });
    expect(bad.status).toBe(400);
    const ok = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2028-06-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('open');
    // maturity must be a positive integer (new field from #1531)
    expect(Number.isInteger(ok.body.data.maturity)).toBe(true);
    expect(ok.body.data.maturity).toBeGreaterThan(0);
  });

  test('fund moves invoice to funded when target reached', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
    expect(again.status).toBe(409);
  });
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });
});

// ---------------------------------------------------------------------------
// parseIsoDate unit tests
// ---------------------------------------------------------------------------
describe('parseIsoDate', () => {
  test('rejects non-strings', () => {
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
    expect(parseIsoDate(20270101)).toBeNull();
    expect(parseIsoDate({})).toBeNull();
  });

  test('rejects non-YYYY-MM-DD formats', () => {
    expect(parseIsoDate('2027')).toBeNull();
    expect(parseIsoDate('March 7, 2027')).toBeNull();
    expect(parseIsoDate('Tue, 01 Jan 2030 00:00:00 GMT')).toBeNull();
    expect(parseIsoDate('2027-1-1')).toBeNull();
    expect(parseIsoDate('2027-01-01T00:00:00Z')).toBeNull();
    expect(parseIsoDate('2027-01-01T25:00')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });

  test('rejects impossible calendar dates (roll-over detection)', () => {
    expect(parseIsoDate('2027-02-30')).toBeNull(); // rolls to Mar 2
    expect(parseIsoDate('2027-13-01')).toBeNull(); // month 13
    expect(parseIsoDate('2027-00-01')).toBeNull(); // month 0
    expect(parseIsoDate('2027-01-00')).toBeNull(); // day 0
    expect(parseIsoDate('2027-04-31')).toBeNull(); // April has 30 days
  });

  test('accepts valid dates and returns correct unixSeconds', () => {
    const r = parseIsoDate('2027-01-17');
    expect(r).not.toBeNull();
    // maturity = 00:00:00 UTC of 2027-01-17 = 1800144000
    expect(r.unixSeconds).toBe(1800144000);
    expect(r.date.toISOString()).toBe('2027-01-17T00:00:00.000Z');
  });

  test('accepts a leap-year date', () => {
    expect(parseIsoDate('2028-02-29')).not.toBeNull(); // 2028 is a leap year
    expect(parseIsoDate('2027-02-29')).toBeNull();    // 2027 is not
  });
});

// ---------------------------------------------------------------------------
// validateInvoice unit tests (injectable clock)
// ---------------------------------------------------------------------------
describe('validateInvoice — dueDate table-driven rejection tests', () => {
  // All these must fail regardless of which day it is; we pin the clock to
  // FIXED_NOW_MS (2026-10-20T00:00:00Z) for determinism.
  const opts = { now: FIXED_NOW_MS };

  const rejectCases = [
    // Past / stale dates
    ['2020-01-01', 'a date six years in the past'],
    ['2026-10-20', 'today itself (not strictly future)'],
    // Lenient-parse forms that Date.parse() accepts but we reject
    ['2027', 'year only'],
    ['March 7, 2027', 'natural language date'],
    ['2027-1-1', 'non-zero-padded month/day'],
    ['Tue, 01 Jan 2030 00:00:00 GMT', 'RFC 2822 format'],
    ['2027-01-01T25:00', 'invalid ISO datetime'],
    // Roll-over dates
    ['2027-02-30', 'Feb 30 (rolls to Mar 2)'],
    ['2027-13-01', 'month 13'],
    // Beyond max horizon (default 1825 days ≈ 5 years; 6 years = ~2190 days)
    ['2032-10-20', 'a date exactly 6 years out'],
    // Non-string
    [42, 'numeric dueDate'],
    [null, 'null dueDate'],
  ];

  test.each(rejectCases)('rejects %s (%s)', (dueDate, _desc) => {
    const { errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate },
      opts
    );
    expect(errors).toBeDefined();
    expect(errors.some((e) => /dueDate/i.test(e))).toBe(true);
  });
});

describe('validateInvoice — accept-path boundary tests (fixed clock 2026-10-20)', () => {
  const opts = { now: FIXED_NOW_MS };

  test('tomorrow (+MIN_TENOR_DAYS=1) is accepted', () => {
    // 2026-10-21 is exactly 1 day ahead: the minimum valid date.
    const { value, errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: '2026-10-21' },
      opts
    );
    expect(errors).toBeUndefined();
    expect(value.dueDate).toBe('2026-10-21');
    expect(Number.isInteger(value.maturity)).toBe(true);
  });

  test('exactly MAX_TENOR_DAYS (1825 days from today) is accepted', () => {
    // 2026-10-20 + 1825 days = 2031-10-19
    const maxDate = new Date(FIXED_NOW_MS + 1825 * 86_400_000);
    const maxStr = maxDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const { value, errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: maxStr },
      opts
    );
    expect(errors).toBeUndefined();
    expect(value.dueDate).toBe(maxStr);
  });

  test('one day beyond MAX_TENOR_DAYS is rejected', () => {
    const overDate = new Date(FIXED_NOW_MS + 1826 * 86_400_000);
    const overStr = overDate.toISOString().slice(0, 10);
    const { errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: overStr },
      opts
    );
    expect(errors).toBeDefined();
    expect(errors.some((e) => /dueDate/i.test(e))).toBe(true);
  });

  test('today itself is rejected (not strictly future)', () => {
    const { errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: '2026-10-20' },
      opts
    );
    expect(errors).toBeDefined();
    expect(errors.some((e) => /dueDate/i.test(e))).toBe(true);
  });
});

describe('validateInvoice — maturity field assertion', () => {
  const opts = { now: FIXED_NOW_MS };

  test('maturity for 2027-01-17 equals 1800144000 (within ±1 day of on-chain seed 1800132005)', () => {
    const { value } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: '2027-01-17' },
      opts
    );
    expect(value.maturity).toBe(1800144000);
    // Verify the ±1 day tolerance against the on-chain seed value.
    expect(Math.abs(value.maturity - 1800132005)).toBeLessThanOrEqual(86400);
  });
});

// ---------------------------------------------------------------------------
// dueBefore / dueAfter filter tests (HTTP)
// ---------------------------------------------------------------------------
describe('GET /api/invoices — dueBefore / dueAfter filters', () => {
  test('dueBefore with invalid date returns 400', async () => {
    const res = await request(app).get('/api/invoices?dueBefore=notadate');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dueBefore/);
  });

  test('dueAfter with invalid date returns 400', async () => {
    const res = await request(app).get('/api/invoices?dueAfter=2027-02-30');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dueAfter/);
  });

  test('dueBefore filters correctly', async () => {
    // Seed has dates: 2027-01-17, 2026-12-30, 2026-11-28, 2026-09-30
    // dueBefore=2026-12-01 should return only dates before Dec 1 2026:
    //   2026-11-28 and 2026-09-30
    const res = await request(app).get('/api/invoices?dueBefore=2026-12-01');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    res.body.data.forEach((inv) => {
      expect(inv.dueDate < '2026-12-01').toBe(true);
    });
  });

  test('dueAfter filters correctly', async () => {
    // dueAfter=2026-12-01 should return dates strictly after Dec 1 2026:
    //   2026-12-30 and 2027-01-17
    const res = await request(app).get('/api/invoices?dueAfter=2026-12-01');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    res.body.data.forEach((inv) => {
      expect(inv.dueDate > '2026-12-01').toBe(true);
    });
  });

  test('dueBefore and dueAfter can be combined with status filter', async () => {
    // status=open AND dueAfter=2026-12-01 → INV_0001 (2027-01-17) and INV_0002 (2026-12-30)
    const res = await request(app).get('/api/invoices?status=open&dueAfter=2026-12-01');
    expect(res.status).toBe(200);
    expect(res.body.data.every((i) => i.status === 'open')).toBe(true);
    expect(res.body.data.every((i) => i.dueDate > '2026-12-01')).toBe(true);
  });

  test('dueBefore non-YYYY-MM-DD string returns 400', async () => {
    const res = await request(app).get('/api/invoices?dueBefore=2027');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Regression: dates accepted on main that must be rejected on this branch
// ---------------------------------------------------------------------------
describe('regression — dates accepted on main, rejected on this branch', () => {
  const opts = { now: FIXED_NOW_MS };

  test('2027-02-30 is rejected (was accepted via Date.parse roll-over on main)', () => {
    // On main: Number.isNaN(Date.parse('2027-02-30')) === false → accepted.
    // On this branch: round-trip check catches the roll-over → rejected.
    const { errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: '2027-02-30' },
      opts
    );
    expect(errors).toBeDefined();
    expect(errors.some((e) => /dueDate/i.test(e))).toBe(true);
  });

  test('2020-01-01 is rejected (past date was accepted on main)', () => {
    // On main: Date.parse('2020-01-01') is valid → accepted and stored.
    // On this branch: past-date guard rejects it.
    const { errors } = validateInvoice(
      { sme: 'A', debtor: 'B', amount: 100, dueDate: '2020-01-01' },
      opts
    );
    expect(errors).toBeDefined();
    expect(errors.some((e) => /dueDate/i.test(e))).toBe(true);
  });
});
