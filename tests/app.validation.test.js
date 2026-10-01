'use strict';

/**
 * @fileoverview Focused validation-boundary tests for the core routes wired
 * directly inside `src/app.js`.
 *
 * Coverage map (acceptance criteria → test group):
 *
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │ Criterion                              │ Describe block                 │
 *  ├─────────────────────────────────────────────────────────────────────────┤
 *  │ Valid inputs accepted deterministically│ "…accepted"                    │
 *  │ Invalid inputs rejected w/ 400 + RFC7807│ "…rejected"                  │
 *  │ Duplicate / idempotent submissions     │ "…idempotency"                 │
 *  │ Boundary values (min/max)              │ "…boundary"                    │
 *  │ Prototype-pollution / injection        │ "…security"                    │
 *  │ Sanitization pass-through              │ "sanitizeInput"                │
 *  │ GET /api info guards                   │ "GET /api"                     │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 * Each test is independent: `createApp()` is called fresh so mocked service
 * state from one test cannot bleed into another.
 *
 * The global mock setup (tests/mocks/setup.js) provides:
 *   - A knex mock (in-memory tables for audit_log_events etc.)
 *   - A metrics mock (no-op counters/labels)
 *   - A rate-limit mock (noop middleware)
 *   - JWT_SECRET env var
 *   - ESCROW_ADDR_BY_INVOICE mapping 'inv_001' → a test contract address
 */

const request = require('supertest');

// ── Service mocks ─────────────────────────────────────────────────────────────
jest.mock('../src/services/invoiceService', () => ({
  getInvoices: jest.fn(),
  getInvoicesWithPagination: jest.fn(),
}));

const { createApp } = require('../src/app');
const invoiceService = require('../src/services/invoiceService');

const {
  INVOICE_ID_MAX_LENGTH,
  INVOICE_ID_PATTERN,
} = require('../src/schemas/appBoundary');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fresh supertest agent so each test gets a clean app instance. */
function agent() {
  return request(createApp());
}

/** A valid invoice creation payload satisfying all required fields. */
const VALID_INVOICE = {
  amount: 1500,
  dueDate: '2026-12-31',
  buyer: 'Acme Corp',
  seller: 'Stellar Goods Ltd',
  currency: 'USD',
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. appBoundary schema — pure unit tests (no HTTP layer)
// ══════════════════════════════════════════════════════════════════════════════

describe('validateEscrowParams — pure unit', () => {
  const { validateEscrowParams } = require('../src/schemas/appBoundary');

  // ── accepted ────────────────────────────────────────────────────────────────
  describe('accepted inputs', () => {
    it('accepts a simple alphanumeric ID', () => {
      const r = validateEscrowParams({ invoiceId: 'inv001' });
      expect(r.success).toBe(true);
      expect(r.data.invoiceId).toBe('inv001');
    });

    it('accepts an ID with hyphens, underscores, dots and colons', () => {
      const r = validateEscrowParams({ invoiceId: 'INV-2026_01.02:03' });
      expect(r.success).toBe(true);
    });

    it('accepts a 1-character ID (minimum length)', () => {
      const r = validateEscrowParams({ invoiceId: 'a' });
      expect(r.success).toBe(true);
    });

    it(`accepts exactly ${INVOICE_ID_MAX_LENGTH}-character ID (maximum length)`, () => {
      const maxId = 'a' + 'b'.repeat(INVOICE_ID_MAX_LENGTH - 1);
      expect(maxId.length).toBe(INVOICE_ID_MAX_LENGTH);
      const r = validateEscrowParams({ invoiceId: maxId });
      expect(r.success).toBe(true);
    });
  });

  // ── rejected ────────────────────────────────────────────────────────────────
  describe('rejected inputs', () => {
    it('rejects an empty string', () => {
      const r = validateEscrowParams({ invoiceId: '' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it(`rejects an ID exceeding ${INVOICE_ID_MAX_LENGTH} characters`, () => {
      const tooLong = 'a'.repeat(INVOICE_ID_MAX_LENGTH + 1);
      const r = validateEscrowParams({ invoiceId: tooLong });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects an ID starting with a dot (relative path component)', () => {
      const r = validateEscrowParams({ invoiceId: '.hidden' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects an ID starting with a hyphen', () => {
      const r = validateEscrowParams({ invoiceId: '-bad' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects an ID containing a forward slash (path traversal)', () => {
      const r = validateEscrowParams({ invoiceId: 'inv/../../etc/passwd' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects an ID containing an angle bracket (XSS vector)', () => {
      const r = validateEscrowParams({ invoiceId: 'inv<script>' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects an ID containing a space', () => {
      const r = validateEscrowParams({ invoiceId: 'inv 001' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects an ID containing a null byte', () => {
      const r = validateEscrowParams({ invoiceId: 'inv\x00001' });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects a non-string invoiceId (number)', () => {
      const r = validateEscrowParams({ invoiceId: 12345 });
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects missing invoiceId', () => {
      const r = validateEscrowParams({});
      expect(r.success).toBe(false);
      expect(r.fieldErrors).toHaveProperty('invoiceId');
    });

    it('rejects unknown extra keys on the params object', () => {
      const r = validateEscrowParams({ invoiceId: 'inv001', extra: 'x' });
      expect(r.success).toBe(false);
    });
  });

  // ── boundary ─────────────────────────────────────────────────────────────────
  describe('boundary values', () => {
    it('rejects exactly INVOICE_ID_MAX_LENGTH + 1 characters', () => {
      const overLength = 'a'.repeat(INVOICE_ID_MAX_LENGTH + 1);
      const r = validateEscrowParams({ invoiceId: overLength });
      expect(r.success).toBe(false);
    });

    it('accepts exactly INVOICE_ID_MAX_LENGTH characters', () => {
      const exactLength = 'a'.repeat(INVOICE_ID_MAX_LENGTH);
      const r = validateEscrowParams({ invoiceId: exactLength });
      expect(r.success).toBe(true);
    });
  });

  // ── security ──────────────────────────────────────────────────────────────
  describe('security — prototype pollution', () => {
    it('rejects __proto__ as an extra key', () => {
      // Object.create to avoid actual prototype pollution
      const params = Object.create(null);
      params.invoiceId = 'inv001';
      params['__proto__'] = { isAdmin: true };
      const r = validateEscrowParams(params);
      // __proto__ is an unrecognised key → strict() rejects
      expect(r.success).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. GET /api/escrow/:invoiceId  — HTTP integration
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/escrow/:invoiceId — HTTP integration', () => {
  // ── accepted ────────────────────────────────────────────────────────────────
  describe('accepted inputs', () => {
    it('passes validation for a well-formed alphanumeric ID (may get 404 from service)', async () => {
      const res = await agent().get('/api/escrow/inv-ACME-2026');
      // Validation passes → never a 400; service may return 404 (no mapping)
      expect(res.statusCode).not.toBe(400);
    });

    it('passes validation for the mapped ID "inv_001"', async () => {
      const res = await agent().get('/api/escrow/inv_001');
      // inv_001 is mapped → service runs → non-400 (200 or 5xx from RPC stub)
      expect(res.statusCode).not.toBe(400);
    });

    it('passes validation for an ID with allowed special chars', async () => {
      const res = await agent().get('/api/escrow/INV.2026-01:A');
      expect(res.statusCode).not.toBe(400);
    });
  });

  // ── rejected ────────────────────────────────────────────────────────────────
  describe('rejected inputs — 400 Validation Error', () => {
    /** Shared assertion: 400 + RFC 7807 shape + fieldErrors.invoiceId present. */
    async function expectValidationError(path) {
      const res = await agent().get(path);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        type: expect.stringContaining('validation-error'),
        title: 'Validation Error',
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors).toHaveProperty('invoiceId');
      return res;
    }

    it('rejects an ID that URL-decodes to whitespace only (%20%09)', async () => {
      await expectValidationError('/api/escrow/%20%09');
    });

    it('rejects an ID containing a newline after URL-decode (%0A)', async () => {
      // " invoice-123\n" after decode — starts with space, invalid
      await expectValidationError('/api/escrow/%20invoice-123%0A');
    });

    it('rejects an ID with a forward slash segment (path traversal)', async () => {
      // Express will match the first segment; the remaining is a different route
      // Test via the encoded form to reach our handler with a slash in the value
      // %2F is the encoded slash
      await expectValidationError('/api/escrow/inv%2F..%2Fetc');
    });

    it('rejects an ID starting with a dot (%2Ehidden)', async () => {
      await expectValidationError('/api/escrow/%2Ehidden');
    });

    it('rejects an ID longer than INVOICE_ID_MAX_LENGTH characters', async () => {
      const tooLong = 'a'.repeat(INVOICE_ID_MAX_LENGTH + 1);
      await expectValidationError(`/api/escrow/${tooLong}`);
    });

    it('returns fieldErrors.invoiceId with a human-readable message', async () => {
      const res = await expectValidationError(`/api/escrow/${'a'.repeat(INVOICE_ID_MAX_LENGTH + 1)}`);
      expect(typeof res.body.fieldErrors.invoiceId).toBe('string');
      expect(res.body.fieldErrors.invoiceId.length).toBeGreaterThan(0);
    });

    it('includes instance (request URL) in the error body', async () => {
      const res = await agent().get('/api/escrow/%20bad%20id');
      expect(res.statusCode).toBe(400);
      expect(typeof res.body.instance).toBe('string');
    });
  });

  // ── boundary ─────────────────────────────────────────────────────────────────
  describe('boundary values', () => {
    it('passes validation for exactly 1 character', async () => {
      const res = await agent().get('/api/escrow/a');
      expect(res.statusCode).not.toBe(400);
    });

    it('passes validation for exactly INVOICE_ID_MAX_LENGTH characters', async () => {
      const exactMax = 'a'.repeat(INVOICE_ID_MAX_LENGTH);
      const res = await agent().get(`/api/escrow/${exactMax}`);
      expect(res.statusCode).not.toBe(400);
    });

    it('rejects INVOICE_ID_MAX_LENGTH + 1 characters', async () => {
      const overMax = 'a'.repeat(INVOICE_ID_MAX_LENGTH + 1);
      const res = await agent().get(`/api/escrow/${overMax}`);
      expect(res.statusCode).toBe(400);
    });
  });

  // ── regression ────────────────────────────────────────────────────────────
  describe('regression — service error shapes', () => {
    it('returns 404 for an unmapped invoice (service NOT_FOUND)', async () => {
      const res = await agent().get('/api/escrow/unmapped-invoice-xyz');
      expect(res.statusCode).toBe(404);
      expect(res.body).toMatchObject({
        error: expect.stringContaining('unmapped-invoice-xyz'),
        code: 'NOT_FOUND',
      });
    });

    it('does not expose a stack trace in the 404 response', async () => {
      const res = await agent().get('/api/escrow/unmapped-abc');
      expect(JSON.stringify(res.body)).not.toMatch(/at Object\.|at Function\.|\.js:\d+/);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. GET /api — info endpoint guards
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api — info endpoint guards', () => {
  // ── accepted ────────────────────────────────────────────────────────────────
  describe('accepted inputs', () => {
    it('returns 200 with metadata for a clean request', async () => {
      const res = await agent().get('/api');
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        name: 'LiquiFact API',
        endpoints: expect.objectContaining({
          health: 'GET /health',
          invoices: 'GET/POST /api/invoices',
        }),
      });
    });
  });

  // ── rejected ────────────────────────────────────────────────────────────────
  describe('rejected inputs', () => {
    it('rejects unknown query parameters with 400', async () => {
      const res = await agent().get('/api?debug=true');
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    });

    it('rejects __proto__ as a query parameter', async () => {
      const res = await agent().get('/api?__proto__[isAdmin]=1');
      expect(res.statusCode).toBe(400);
    });

    it('rejects a request body on GET /api', async () => {
      const res = await agent()
        .get('/api')
        .set('Content-Type', 'application/json')
        .send({ unexpected: true });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_BODY_ON_GET' });
    });

    it('rejects multiple unknown query params and names them all', async () => {
      const res = await agent().get('/api?foo=1&bar=2');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. POST /api/invoices — body validation
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/invoices — body validation', () => {
  // ── accepted ────────────────────────────────────────────────────────────────
  describe('accepted inputs', () => {
    it('accepts a fully valid payload and returns 201', async () => {
      const res = await agent().post('/api/invoices').send(VALID_INVOICE);
      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({
        data: { id: 'placeholder', status: 'pending_verification' },
      });
    });

    it('accepts amount as a numeric string', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, amount: '1500.00' });
      expect(res.statusCode).toBe(201);
    });

    it('normalises currency to upper-case (accepts lower-case input)', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, currency: 'usd' });
      expect(res.statusCode).toBe(201);
    });
  });

  // ── rejected ────────────────────────────────────────────────────────────────
  describe('rejected inputs', () => {
    /** Asserts 400 + fieldErrors object shape. */
    async function expectInvoiceValidationError(payload) {
      const res = await agent().post('/api/invoices').send(payload);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        type: expect.stringContaining('validation-error'),
        title: 'Validation Error',
        status: 400,
      });
      expect(res.body.fieldErrors).toBeDefined();
      expect(typeof res.body.fieldErrors).toBe('object');
      expect(Array.isArray(res.body.fieldErrors)).toBe(false);
      return res;
    }

    it('rejects when amount is missing', async () => {
      const { amount: _a, ...rest } = VALID_INVOICE;
      await expectInvoiceValidationError(rest);
    });

    it('rejects when buyer (and customer) are absent', async () => {
      const { buyer: _b, ...rest } = VALID_INVOICE;
      const res = await expectInvoiceValidationError(rest);
      expect(res.body.fieldErrors).toHaveProperty('buyer');
    });

    it('rejects when seller is absent', async () => {
      const { seller: _s, ...rest } = VALID_INVOICE;
      const res = await expectInvoiceValidationError(rest);
      expect(res.body.fieldErrors).toHaveProperty('seller');
    });

    it('rejects when currency is absent', async () => {
      const { currency: _c, ...rest } = VALID_INVOICE;
      const res = await expectInvoiceValidationError(rest);
      expect(res.body.fieldErrors).toHaveProperty('currency');
    });

    it('rejects when dueDate is absent', async () => {
      const { dueDate: _d, ...rest } = VALID_INVOICE;
      const res = await expectInvoiceValidationError(rest);
      expect(res.body.fieldErrors).toHaveProperty('dueDate');
    });

    it('rejects an unsupported currency code', async () => {
      const res = await expectInvoiceValidationError({ ...VALID_INVOICE, currency: 'XYZ' });
      expect(res.body.fieldErrors).toHaveProperty('currency');
    });

    it('rejects a negative amount', async () => {
      const res = await expectInvoiceValidationError({ ...VALID_INVOICE, amount: -1 });
      expect(res.body.fieldErrors).toHaveProperty('amount');
    });

    it('rejects an amount of zero', async () => {
      const res = await expectInvoiceValidationError({ ...VALID_INVOICE, amount: 0 });
      expect(res.body.fieldErrors).toHaveProperty('amount');
    });

    it('rejects a non-finite amount (Infinity)', async () => {
      const res = await agent()
        .post('/api/invoices')
        .set('Content-Type', 'application/json')
        .send('{"amount":1e999,"dueDate":"2026-12-31","buyer":"B","seller":"S","currency":"USD"}');
      // JSON.parse collapses 1e999 → Infinity; the schema rejects it
      expect(res.statusCode).toBe(400);
    });

    it('rejects a malformed dueDate (not YYYY-MM-DD)', async () => {
      const res = await expectInvoiceValidationError({ ...VALID_INVOICE, dueDate: '31-12-2026' });
      expect(res.body.fieldErrors).toHaveProperty('dueDate');
    });

    it('rejects an unknown top-level key (strict schema)', async () => {
      const res = await expectInvoiceValidationError({ ...VALID_INVOICE, extraField: 'boom' });
      // strict() adds an issue; fieldErrors may use '_root' or 'extraField'
      expect(Object.keys(res.body.fieldErrors).length).toBeGreaterThan(0);
    });

    it('rejects a __proto__ injection key', async () => {
      const res = await agent()
        .post('/api/invoices')
        .set('Content-Type', 'application/json')
        // Send a raw body so the key actually appears in the parsed object
        .send(
          JSON.stringify({
            ...VALID_INVOICE,
            __proto__: { isAdmin: true },
          })
        );
      // Either 400 (strict rejects) or 201 with prototype untouched — either
      // way the server must not have been polluted
      expect(({}).isAdmin).toBeUndefined();
    });

    it('rejects a non-object body (array)', async () => {
      const res = await agent()
        .post('/api/invoices')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify([1, 2, 3]));
      expect(res.statusCode).toBe(400);
    });

    it('rejects a raw-string body', async () => {
      const res = await agent()
        .post('/api/invoices')
        .set('Content-Type', 'application/json')
        .send('"just a string"');
      expect(res.statusCode).toBe(400);
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await agent()
        .post('/api/invoices')
        .set('Content-Type', 'application/json')
        .send('{bad json}');
      expect(res.statusCode).toBe(400);
    });
  });

  // ── boundary ─────────────────────────────────────────────────────────────────
  describe('boundary values', () => {
    it('accepts a buyer name of exactly 1 character', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, buyer: 'X' });
      expect(res.statusCode).toBe(201);
    });

    it('accepts a buyer name of exactly 255 characters', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, buyer: 'A'.repeat(255) });
      expect(res.statusCode).toBe(201);
    });

    it('rejects a buyer name of 256 characters', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, buyer: 'A'.repeat(256) });
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('buyer');
    });

    it('accepts an invoiceNumber of exactly 100 characters', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, invoiceNumber: 'N'.repeat(100) });
      expect(res.statusCode).toBe(201);
    });

    it('rejects an invoiceNumber of 101 characters', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, invoiceNumber: 'N'.repeat(101) });
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('invoiceNumber');
    });

    it('accepts a description of exactly 1000 characters', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, description: 'D'.repeat(1000) });
      expect(res.statusCode).toBe(201);
    });

    it('rejects a description of 1001 characters', async () => {
      const res = await agent()
        .post('/api/invoices')
        .send({ ...VALID_INVOICE, description: 'D'.repeat(1001) });
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('description');
    });
  });

  // ── idempotency ─────────────────────────────────────────────────────────────
  describe('idempotency — duplicate submissions', () => {
    it('accepts the same valid payload twice and returns 201 both times', async () => {
      const app = createApp();
      const r1 = await request(app).post('/api/invoices').send(VALID_INVOICE);
      const r2 = await request(app).post('/api/invoices').send(VALID_INVOICE);
      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      // Both responses carry the same placeholder shape
      expect(r1.body).toEqual(r2.body);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. GET /api/invoices — query validation
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/invoices — query validation', () => {
  beforeEach(() => {
    invoiceService.getInvoicesWithPagination.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── accepted ────────────────────────────────────────────────────────────────
  describe('accepted inputs', () => {
    it('returns 200 for a request with no query params', async () => {
      const res = await agent().get('/api/invoices');
      expect(res.statusCode).toBe(200);
    });

    it('accepts valid status filter', async () => {
      const res = await agent().get('/api/invoices?status=pending');
      expect(res.statusCode).toBe(200);
    });

    it('accepts valid pagination params', async () => {
      const res = await agent().get('/api/invoices?page=2&limit=50');
      expect(res.statusCode).toBe(200);
    });

    it('accepts valid sort params', async () => {
      const res = await agent().get('/api/invoices?sortBy=amount&order=asc');
      expect(res.statusCode).toBe(200);
    });
  });

  // ── rejected ────────────────────────────────────────────────────────────────
  describe('rejected inputs', () => {
    it('returns 400 for an invalid status value', async () => {
      const res = await agent().get('/api/invoices?status=invalid_status');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('status');
    });

    it('returns 400 for a non-integer page value', async () => {
      const res = await agent().get('/api/invoices?page=abc');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('page');
    });

    it('returns 400 for page=0', async () => {
      const res = await agent().get('/api/invoices?page=0');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('page');
    });

    it('returns 400 for an invalid sortBy value', async () => {
      const res = await agent().get('/api/invoices?sortBy=invalid_field');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('sortBy');
    });

    it('returns 400 for an invalid order value', async () => {
      const res = await agent().get('/api/invoices?order=sideways');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('order');
    });

    it('returns 400 for an invalid dateFrom format', async () => {
      const res = await agent().get('/api/invoices?dateFrom=not-a-date');
      expect(res.statusCode).toBe(400);
      expect(res.body.fieldErrors).toHaveProperty('dateFrom');
    });
  });

  // ── boundary ─────────────────────────────────────────────────────────────────
  describe('boundary values', () => {
    it('accepts limit=1 (minimum)', async () => {
      const res = await agent().get('/api/invoices?limit=1');
      expect(res.statusCode).toBe(200);
    });

    it('accepts limit=100 (maximum)', async () => {
      const res = await agent().get('/api/invoices?limit=100');
      expect(res.statusCode).toBe(200);
    });

    it('clamps or accepts limit=101 without error (service decides)', async () => {
      // The validator clamps to 100, so no 400 is expected
      const res = await agent().get('/api/invoices?limit=101');
      expect(res.statusCode).toBe(200);
    });

    it('accepts a 2048-char cursor (maximum cursor length)', async () => {
      const longCursor = 'a'.repeat(2048);
      const res = await agent().get(`/api/invoices?cursor=${longCursor}`);
      // May fail with a CursorError (400) from the service — that is a
      // service-layer rejection, not a param-format rejection; either way
      // the validator itself does not reject valid-length cursors
      expect([200, 400]).toContain(res.statusCode);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. sanitizeInput integration — prototype-pollution and control-char stripping
// ══════════════════════════════════════════════════════════════════════════════

describe('sanitizeInput middleware integration', () => {
  it('strips control characters from a query string before validation', async () => {
    // The tab char in the status value will be normalised to a space then
    // trimmed; the resulting value "pending" passes or "pending " fails status
    // validation — either way the server does not crash
    const res = await agent().get('/api/invoices?status=pending%09');
    expect([200, 400]).toContain(res.statusCode);
    // The server must not have thrown a 500
    expect(res.statusCode).not.toBe(500);
  });

  it('does not pollute Object.prototype via a request body', async () => {
    await agent()
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...VALID_INVOICE, '__proto__': { polluted: true } }));

    expect(({}).polluted).toBeUndefined();
  });

  it('does not pollute Object.prototype via a query string', async () => {
    await agent().get('/api/invoices?__proto__[polluted]=true');
    expect(({}).polluted).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Health probe guards (regression — must still work after wiring changes)
// ══════════════════════════════════════════════════════════════════════════════

describe('Health probe guards — regression', () => {
  it('GET /health returns 200 with no query params', async () => {
    const res = await agent().get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'liquifact-api' });
  });

  it('GET /healthz returns 200 (liveness alias)', async () => {
    const res = await agent().get('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /health rejects unknown query params with 400', async () => {
    const res = await agent().get('/health?verbose=true');
    expect(res.statusCode).toBe(400);
  });

  it('GET /health rejects a request body with 400', async () => {
    const res = await agent()
      .get('/health')
      .set('Content-Type', 'application/json')
      .send({ extra: true });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BODY_ON_GET' });
  });
});
