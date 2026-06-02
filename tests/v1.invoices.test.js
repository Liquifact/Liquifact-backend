/**
 * Integration tests for the v1 invoice routes.
 *
 * These tests exercise the full request → middleware → service → DB round-trip
 * using an **in-memory SQLite database** via Knex (the `test` knexfile profile).
 * The global jest setup mocks `src/db/knex` with a mock object; we must bypass
 * that for these integration tests by importing the real Knex instance directly
 * from the knexfile.
 *
 * Coverage targets:
 *   - Invoice creation (201) with Zod-validated body
 *   - Listing active invoices (200, no soft-deleted rows)
 *   - Listing with `?includeDeleted=true`
 *   - Persistence across multiple handler invocations (no in-memory reset)
 *   - Tenant isolation — Tenant A cannot see Tenant B's invoices
 *   - Validation errors → 422 RFC 7807 Problem Details
 *   - Missing tenant context → 400
 *
 * @jest-environment node
 */

'use strict';

// ---------------------------------------------------------------------------
// Override the global db mock set up in tests/mocks/setup.js so that these
// integration tests talk to a real in-memory SQLite database.
// ---------------------------------------------------------------------------
jest.mock('../src/db/knex', () => {
  const knex = require('knex');
  const config = require('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const express = require('express');

// Import the real db (now pointing to in-memory SQLite) to run migrations
// and clean up between tests.
const db = require('../src/db/knex');

// Import service + route modules AFTER the mock override is in place.
const v1Router = require('../src/routes/v1/index');
const { errorHandler } = require('../src/middleware/errorHandler');
const { problemJsonHandler } = require('../src/middleware/problemJson');

// ---------------------------------------------------------------------------
// App factory — mirrors how the real app mounts v1 routes
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app for testing the v1 router in isolation.
 * Attaches both the legacy `errorHandler` and the RFC 7807 `problemJsonHandler`
 * so validation errors land as proper problem+json responses.
 *
 * @returns {import('express').Express}
 */
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', v1Router);

  // RFC 7807 handler must come first so AppError instances render correctly
  app.use(problemJsonHandler);
  // Fallback generic handler
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

let app;

beforeAll(async () => {
  // Run the Knex JS migration that creates the invoices table in :memory: SQLite
  await db.migrate.latest({ directory: './migrations' });
  app = buildTestApp();
});

beforeEach(async () => {
  // Wipe all invoices before every test to keep tests independent
  await db('invoices').del();
});

afterAll(async () => {
  await db.destroy();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * POSTs a valid invoice for the given tenant and returns the supertest response.
 *
 * @param {string} tenantId
 * @param {object} [overrides]
 */
function postInvoice(tenantId, overrides = {}) {
  const body = {
    amount: 500,
    customer: 'Acme Corp',
    ...overrides,
  };
  return request(app)
    .post('/v1/invoices')
    .set('x-tenant-id', tenantId)
    .send(body);
}

/**
 * GETs the invoice list for a tenant, optionally including deleted records.
 *
 * @param {string} tenantId
 * @param {object} [query]  e.g. { includeDeleted: 'true' }
 */
function getInvoices(tenantId, query = {}) {
  return request(app)
    .get('/v1/invoices')
    .set('x-tenant-id', tenantId)
    .query(query);
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('POST /v1/invoices — creation', () => {
  it('creates an invoice and returns 201 with the persisted record', async () => {
    const res = await postInvoice(TENANT_A, { amount: 1250.50, customer: 'Global Traders Ltd' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Invoice created successfully.');

    const data = res.body.data;
    expect(data).toBeDefined();
    expect(Number(data.amount)).toBeCloseTo(1250.50, 1);
    expect(data.customer).toBe('Global Traders Ltd');
    expect(data.status).toBe('pending');
    expect(data.tenant_id).toBe(TENANT_A);
    expect(data.invoice_id).toMatch(/^inv_\d+_\d+$/);
    expect(data.deleted_at).toBeNull();
  });

  it('accepts `buyer` as the customer field alias', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: 200, buyer: 'Buyer Name Ltd' });

    expect(res.status).toBe(201);
    expect(res.body.data.customer).toBe('Buyer Name Ltd');
  });

  it('accepts optional fields: currency, dueDate, description', async () => {
    const res = await postInvoice(TENANT_A, {
      amount: 800,
      customer: 'CurrencyTest',
      currency: 'EUR',
      dueDate: '2027-03-31',
      description: 'Q1 invoice',
    });

    expect(res.status).toBe(201);
  });

  it('returns 422 RFC 7807 when amount is missing', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ customer: 'Test Corp' });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/validation-error/);
    expect(res.body.title).toBe('Validation Error');
    expect(res.body.status).toBe(422);
  });

  it('returns 422 when amount is zero', async () => {
    const res = await postInvoice(TENANT_A, { amount: 0 });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('returns 422 when amount is negative', async () => {
    const res = await postInvoice(TENANT_A, { amount: -100 });
    expect(res.status).toBe(422);
  });

  it('returns 422 when amount is a string', async () => {
    const res = await postInvoice(TENANT_A, { amount: '500' });
    expect(res.status).toBe(422);
  });

  it('returns 422 when customer is missing (no buyer either)', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: 100 });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('returns 422 when body is completely empty', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({});

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('returns 400 when x-tenant-id header is missing', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .send({ amount: 100, customer: 'NoTenant' });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('GET /v1/invoices — listing', () => {
  it('returns empty array when no invoices exist for tenant', async () => {
    const res = await getInvoices(TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.message).toBe('Showing active invoices.');
  });

  it('returns all active invoices for the tenant', async () => {
    // Insert two invoices
    await postInvoice(TENANT_A, { amount: 100, customer: 'Alpha One' });
    await postInvoice(TENANT_A, { amount: 200, customer: 'Alpha Two' });

    const res = await getInvoices(TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('does NOT include soft-deleted invoices by default', async () => {
    const created = await postInvoice(TENANT_A, { amount: 100, customer: 'SoftDel Corp' });
    const invoiceId = created.body.data.invoice_id;

    // Soft-delete it directly in the DB
    await db('invoices').where({ invoice_id: invoiceId }).update({ deleted_at: new Date().toISOString() });

    const res = await getInvoices(TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.message).toBe('Showing active invoices.');
  });

  it('includes soft-deleted invoices when includeDeleted=true', async () => {
    const created = await postInvoice(TENANT_A, { amount: 100, customer: 'SoftDel Corp' });
    const invoiceId = created.body.data.invoice_id;

    // Soft-delete it
    await db('invoices').where({ invoice_id: invoiceId }).update({ deleted_at: new Date().toISOString() });

    const res = await getInvoices(TENANT_A, { includeDeleted: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].invoice_id).toBe(invoiceId);
    expect(res.body.data[0].deleted_at).not.toBeNull();
    expect(res.body.message).toBe('Showing all invoices (including deleted).');
  });

  it('returns 400 when x-tenant-id header is missing', async () => {
    const res = await request(app).get('/v1/invoices');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('Persistence across handler invocations', () => {
  it('invoices survive across multiple GET calls without reset', async () => {
    await postInvoice(TENANT_A, { amount: 300, customer: 'Persistent Co' });

    // First read
    const res1 = await getInvoices(TENANT_A);
    expect(res1.body.data).toHaveLength(1);

    // Second read — same data, no in-memory re-initialisation
    const res2 = await getInvoices(TENANT_A);
    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0].customer).toBe('Persistent Co');
  });

  it('sequential creates accumulate correctly', async () => {
    await postInvoice(TENANT_A, { amount: 10, customer: 'First' });
    await postInvoice(TENANT_A, { amount: 20, customer: 'Second' });
    await postInvoice(TENANT_A, { amount: 30, customer: 'Third' });

    const res = await getInvoices(TENANT_A);
    expect(res.body.data).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

describe('Tenant isolation', () => {
  it('Tenant A cannot see Tenant B invoices', async () => {
    await postInvoice(TENANT_A, { amount: 100, customer: 'Alpha Customer' });
    await postInvoice(TENANT_B, { amount: 200, customer: 'Beta Customer' });

    const resA = await getInvoices(TENANT_A);
    const resB = await getInvoices(TENANT_B);

    expect(resA.body.data).toHaveLength(1);
    expect(resA.body.data[0].customer).toBe('Alpha Customer');

    expect(resB.body.data).toHaveLength(1);
    expect(resB.body.data[0].customer).toBe('Beta Customer');
  });

  it('Tenant B cannot see Tenant A soft-deleted invoices via includeDeleted', async () => {
    const created = await postInvoice(TENANT_A, { amount: 500, customer: 'Private Corp' });
    const invoiceId = created.body.data.invoice_id;
    await db('invoices').where({ invoice_id: invoiceId }).update({ deleted_at: new Date().toISOString() });

    const res = await getInvoices(TENANT_B, { includeDeleted: 'true' });
    expect(res.body.data).toHaveLength(0);
  });

  it('each tenant only accumulates their own records', async () => {
    // Create 3 for A and 2 for B
    for (let i = 0; i < 3; i++) {
      await postInvoice(TENANT_A, { amount: 100 * (i + 1), customer: `A-Customer-${i}` });
    }
    for (let i = 0; i < 2; i++) {
      await postInvoice(TENANT_B, { amount: 50 * (i + 1), customer: `B-Customer-${i}` });
    }

    const resA = await getInvoices(TENANT_A);
    const resB = await getInvoices(TENANT_B);

    expect(resA.body.data).toHaveLength(3);
    expect(resB.body.data).toHaveLength(2);

    // Every A record must belong to TENANT_A
    resA.body.data.forEach((inv) => expect(inv.tenant_id).toBe(TENANT_A));
    // Every B record must belong to TENANT_B
    resB.body.data.forEach((inv) => expect(inv.tenant_id).toBe(TENANT_B));
  });

  it('tenant_id is stored correctly on the created row', async () => {
    const res = await postInvoice(TENANT_A);
    expect(res.body.data.tenant_id).toBe(TENANT_A);
  });

  it('POST by Tenant A does not inflate Tenant B list', async () => {
    await postInvoice(TENANT_A, { amount: 999, customer: 'Invisible to B' });

    const resB = await getInvoices(TENANT_B);
    expect(resB.body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('invoiceService unit-level (direct calls)', () => {
  const { listInvoices, createInvoice, getInvoiceById, deleteInvoice } = require('../src/services/invoiceService');

  it('createInvoice throws TypeError when tenantId is missing', async () => {
    await expect(createInvoice({ amount: 100, customer: 'Test' }, '')).rejects.toThrow(TypeError);
    await expect(createInvoice({ amount: 100, customer: 'Test' }, null)).rejects.toThrow(TypeError);
  });

  it('listInvoices throws TypeError when tenantId is missing', async () => {
    await expect(listInvoices('')).rejects.toThrow(TypeError);
    await expect(listInvoices(null)).rejects.toThrow(TypeError);
  });

  it('getInvoiceById throws TypeError when id is not a string', async () => {
    await expect(getInvoiceById(123, TENANT_A)).rejects.toThrow(TypeError);
    await expect(getInvoiceById(null, TENANT_A)).rejects.toThrow(TypeError);
  });

  it('getInvoiceById returns null for non-existent invoice', async () => {
    const result = await getInvoiceById('inv_does_not_exist', TENANT_A);
    expect(result).toBeNull();
  });

  it('getInvoiceById returns null for invoice belonging to another tenant', async () => {
    const created = await createInvoice({ amount: 400, customer: 'Isolated' }, TENANT_A);
    const invoiceId = created.invoice_id;

    const result = await getInvoiceById(invoiceId, TENANT_B);
    expect(result).toBeNull();
  });

  it('listInvoices respects includeDeleted=false (default)', async () => {
    const created = await createInvoice({ amount: 100, customer: 'ToDelete' }, TENANT_A);
    await db('invoices').where({ invoice_id: created.invoice_id }).update({ deleted_at: new Date().toISOString() });

    const active = await listInvoices(TENANT_A, { includeDeleted: false });
    expect(active.find((i) => i.invoice_id === created.invoice_id)).toBeUndefined();
  });

  it('listInvoices includes soft-deleted rows when includeDeleted=true', async () => {
    const created = await createInvoice({ amount: 100, customer: 'WillDelete' }, TENANT_A);
    await db('invoices').where({ invoice_id: created.invoice_id }).update({ deleted_at: new Date().toISOString() });

    const all = await listInvoices(TENANT_A, { includeDeleted: true });
    expect(all.find((i) => i.invoice_id === created.invoice_id)).toBeDefined();
  });

  it('deleteInvoice soft-deletes by setting deleted_at', async () => {
    const created = await createInvoice({ amount: 750, customer: 'DeleteMe Corp' }, TENANT_A);
    const invoiceId = created.invoice_id;

    await deleteInvoice(invoiceId, TENANT_A);

    const row = await db('invoices').where({ invoice_id: invoiceId }).first();
    expect(row.deleted_at).not.toBeNull();
  });

  it('deleteInvoice throws when id is missing', async () => {
    await expect(deleteInvoice('', TENANT_A)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------

describe('RFC 7807 error response format', () => {
  it('validation error has correct content-type header', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: -5 });

    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('validation error body contains required RFC 7807 fields', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: -5 });

    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe(422);
    expect(res.body.type).toMatch(/^https?:\/\//);
  });

  it('missing tenant returns 400 with error payload', async () => {
    const res = await request(app)
      .get('/v1/invoices');

    expect(res.status).toBe(400);
    // Tenant middleware returns a plain JSON error (not RFC 7807), consistent
    // with the existing middleware contract
    expect(res.body).toHaveProperty('error');
  });
});
