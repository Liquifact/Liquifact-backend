'use strict';

/**
 * Integration tests for idempotency-key support on invoice-state write
 * endpoints (issue #740).
 *
 * These tests verify that the optional idempotency middleware correctly
 * stores and replays responses for the 4 write endpoints:
 *   - POST /api/invoices/:id/transition
 *   - POST /api/invoices/:id/approve
 *   - POST /api/invoices/:id/link-escrow
 *   - POST /api/invoices/:id/reject
 *
 * The tests run against an in-memory SQLite database via Knex, mirroring the
 * pattern used in tests/idempotency.test.js.
 *
 * Coverage:
 *   1. First write with key                → creates row, returns response
 *   2. Exact replay (same key + same body) → returns cached response
 *   3. Key reuse with different body       → 409 Conflict (RFC 7807)
 *   4. No key (header absent)              → normal operation, no idempotency
 *   5. Multiple distinct keys              → independent storage
 *   6. All 4 write endpoints               → each is covered
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mock override: real Knex with in-memory SQLite for the idempotency table
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

// The existing idempotency middleware imports IDEMPOTENCY_KEY_PATTERN from
// escrowSubmit, which transitively imports metrics.js where a pre-existing
// `recordMetricsEndpointOutcome` export references an undefined variable.
// Mock escrowSubmit to provide just the pattern and break the dependency.
jest.mock('../src/services/escrowSubmit', () => ({
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9._:-]{8,128}$/,
}));

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const db = require('../src/db/knex');

// ── Invoice state module (not mocked in setup for idempotency-specific tests) ──
// We set up the routes with their real middleware, but mock the invoice service
// and the rate limiter to keep tests focused on idempotency behavior.
jest.mock('../src/services/invoiceService', () => ({
  resolveInvoiceForTenant: jest.fn(),
  getInvoiceById: jest.fn(),
  updateInvoice: jest.fn(),
  transitionInvoice: jest.fn(),
}));

jest.mock('../src/middleware/rateLimit', () => ({
  invoiceStateLimiter: (req, res, next) => next(),
}));

jest.mock('../src/middleware/kycGating', () => ({
  requireKycForFunding: (req, res, next) => next(),
  auditKycAccess: (req, res, next) => next(),
}));

const invoiceService = require('../src/services/invoiceService');
const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique valid idempotency key.
 */
function validKey() {
  return 'ik_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Seed the in-memory invoice store with a minimal invoice fixture.
 */
const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

const INVOICES = {
  'inv-pending': {
    invoice_id: 'inv-pending',
    tenant_id: TENANT_A,
    status: 'pending',
    amount: 1000,
    customer: 'TestCorp',
  },
  'inv-approved': {
    invoice_id: 'inv-approved',
    tenant_id: TENANT_A,
    status: 'approved',
    amount: 2000,
    customer: 'TestCorp',
  },
  'inv-linked': {
    invoice_id: 'inv-linked',
    tenant_id: TENANT_A,
    status: 'linked_escrow',
    amount: 3000,
    customer: 'TestCorp',
  },
  'inv-other-tenant': {
    invoice_id: 'inv-other-tenant',
    tenant_id: TENANT_B,
    status: 'pending',
    amount: 4000,
    customer: 'OtherCorp',
  },
};

/**
 * Simulate a successful transition result.
 */
function makeTransitionResult(invoiceId, previousState, newState) {
  return {
    previousState,
    newState,
    transitionedAt: new Date().toISOString(),
    transitionedBy: 'test-user-123',
    auditLog: { id: 'audit-' + Date.now() },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let app;

beforeAll(async () => {
  // Create the idempotency_keys table in the in-memory SQLite DB
  await db.schema.createTable('idempotency_keys', (t) => {
    t.increments('id').primary();
    t.string('idempotency_key', 128).notNullable().unique();
    t.string('request_fingerprint', 64).notNullable();
    t.integer('response_status').nullable();
    t.text('response_body').nullable();
    t.timestamp('created_at').defaultTo(db.fn.now());
    t.timestamp('updated_at').defaultTo(db.fn.now());
    t.timestamp('expires_at').notNullable();
  });
});

beforeEach(async () => {
  // Clean state between tests
  await db('idempotency_keys').del();
  jest.clearAllMocks();

  // Build a fresh Express app for each test
  app = express();
  app.use(express.json());

  // Simulate auth + tenant extraction
  app.use((req, _res, next) => {
    req.user = { id: 'test-user-123', sub: 'test-user-123' };
    req.tenantId = TENANT_A;
    next();
  });

  // Mount the invoice-state routes
  app.use('/api/invoices', invoiceStateRoutes);

  // Global error handler
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message, stack: err.stack });
  });
});

afterAll(async () => {
  await db.destroy();
});

// ---------------------------------------------------------------------------
// Helper to set up transition mock
// ---------------------------------------------------------------------------
function mockTransition(previousState, newState) {
  invoiceService.transitionInvoice.mockResolvedValue(
    makeTransitionResult('inv-pending', previousState, newState),
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Invoice State Idempotency — POST /:id/transition', () => {
  beforeEach(() => {
    invoiceService.resolveInvoiceForTenant.mockImplementation(async (id, tenantId) => {
      const inv = INVOICES[id];
      return inv && inv.tenant_id === tenantId ? inv : null;
    });
    mockTransition('pending', 'approved');
  });

  it('executes transition normally when no Idempotency-Key header is sent', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .send({ targetState: 'approved', reason: 'No idempotency' });

    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe('approved');
  });

  it('executes transition on first call with an Idempotency-Key', async () => {
    const key = validKey();
    const res = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ targetState: 'approved', reason: 'First call' });

    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe('approved');
  });

  it('replays the cached response on exact duplicate (same key + same body)', async () => {
    const key = validKey();
    const body = { targetState: 'approved', reason: 'Duplicate test' };

    // First call
    const res1 = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(200);

    // Second call — should replay, NOT invoke handler again
    const res2 = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res2.status).toBe(200);
    expect(res2.body.data.currentState).toBe('approved');
    expect(res2.body.data.invoiceId).toBe('inv-pending');

    // Handler should only have been invoked once
    expect(invoiceService.transitionInvoice).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when same key is reused with a different request body', async () => {
    const key = validKey();

    // First call with body A
    const res1 = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ targetState: 'approved', reason: 'Body A' });

    expect(res1.status).toBe(200);

    // Second call with body B — conflict
    const res2 = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ targetState: 'rejected', reason: 'Body B' });

    expect(res2.status).toBe(409);
    expect(res2.body.title).toBe('Conflict');
    expect(res2.body.detail).toMatch(/different request body/i);
  });

  it('treats two different keys independently', async () => {
    const key1 = validKey();
    const key2 = validKey();
    const body = { targetState: 'approved', reason: 'Independent keys' };

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/invoices/inv-pending/transition')
        .set('x-tenant-id', TENANT_A)
        .set('Idempotency-Key', key1)
        .send(body),
      request(app)
        .post('/api/invoices/inv-pending/transition')
        .set('x-tenant-id', TENANT_A)
        .set('Idempotency-Key', key2)
        .send(body),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Handler should have been called twice (two distinct keys)
    expect(invoiceService.transitionInvoice).toHaveBeenCalledTimes(2);
  });
});

describe('Invoice State Idempotency — POST /:id/approve', () => {
  beforeEach(() => {
    invoiceService.resolveInvoiceForTenant.mockImplementation(async (id, tenantId) => {
      const inv = INVOICES[id];
      return inv && inv.tenant_id === tenantId ? inv : null;
    });
    mockTransition('pending', 'approved');
  });

  it('works without an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-pending/approve')
      .set('x-tenant-id', TENANT_A)
      .send({ reason: 'Approve without key' });

    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe('approved');
  });

  it('replays cached response on duplicate approve call', async () => {
    const key = validKey();
    const body = { reason: 'Approve with key' };

    const res1 = await request(app)
      .post('/api/invoices/inv-pending/approve')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/invoices/inv-pending/approve')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res2.status).toBe(200);
    expect(invoiceService.transitionInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('Invoice State Idempotency — POST /:id/link-escrow', () => {
  beforeEach(() => {
    invoiceService.resolveInvoiceForTenant.mockImplementation(async (id, tenantId) => {
      const inv = INVOICES[id];
      return inv && inv.tenant_id === tenantId ? inv : null;
    });
    // For link-escrow, transitionInvoice returns the new state
    mockTransition('approved', 'linked_escrow');
  });

  it('works without an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-approved/link-escrow')
      .set('x-tenant-id', TENANT_A)
      .send({ escrowId: 'esc-001', reason: 'Link without key' });

    expect(res.status).toBe(200);
  });

  it('replays cached response on duplicate link-escrow call', async () => {
    const key = validKey();
    const body = { escrowId: 'esc-002', reason: 'Link with key' };

    const res1 = await request(app)
      .post('/api/invoices/inv-approved/link-escrow')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/invoices/inv-approved/link-escrow')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res2.status).toBe(200);
    expect(invoiceService.transitionInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('Invoice State Idempotency — POST /:id/reject', () => {
  beforeEach(() => {
    invoiceService.resolveInvoiceForTenant.mockImplementation(async (id, tenantId) => {
      const inv = INVOICES[id];
      return inv && inv.tenant_id === tenantId ? inv : null;
    });
    mockTransition('pending', 'rejected');
  });

  it('works without an Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/invoices/inv-pending/reject')
      .set('x-tenant-id', TENANT_A)
      .send({ reason: 'Reject without key' });

    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe('rejected');
  });

  it('replays cached response on duplicate reject call', async () => {
    const key = validKey();
    const body = { reason: 'Reject with key' };

    const res1 = await request(app)
      .post('/api/invoices/inv-pending/reject')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/invoices/inv-pending/reject')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send(body);

    expect(res2.status).toBe(200);
    expect(invoiceService.transitionInvoice).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when same key is used with a different rejection reason', async () => {
    const key = validKey();

    const res1 = await request(app)
      .post('/api/invoices/inv-pending/reject')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ reason: 'First reason' });

    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/invoices/inv-pending/reject')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ reason: 'Different reason' });

    expect(res2.status).toBe(409);
    expect(res2.body.title).toBe('Conflict');
  });
});

describe('Invoice State Idempotency — cross-endpoint key isolation', () => {
  beforeEach(() => {
    invoiceService.resolveInvoiceForTenant.mockImplementation(async (id, tenantId) => {
      const inv = INVOICES[id];
      return inv && inv.tenant_id === tenantId ? inv : null;
    });
  });

  it('a key used on transition cannot be reused on approve with different body', async () => {
    invoiceService.transitionInvoice
      .mockResolvedValueOnce(makeTransitionResult('inv-pending', 'pending', 'approved'))
      .mockResolvedValueOnce(makeTransitionResult('inv-pending', 'pending', 'approved'));

    const key = validKey();

    // Use key on /transition
    const res1 = await request(app)
      .post('/api/invoices/inv-pending/transition')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ targetState: 'approved', reason: 'Via transition' });

    expect(res1.status).toBe(200);

    // Reuse same key on /approve with different body -> 409
    const res2 = await request(app)
      .post('/api/invoices/inv-pending/approve')
      .set('x-tenant-id', TENANT_A)
      .set('Idempotency-Key', key)
      .send({ reason: 'Via approve' });

    expect(res2.status).toBe(409);
  });
});
