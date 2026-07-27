'use strict';

/**
 * @fileoverview Route-level tests for the admin invoice-state soft-delete
 * surface (issue #866). The service layer is exercised directly in
 * `tests/invoiceState.softDelete.test.js`; this file focuses on HTTP wiring
 * (adminStack auth, error → status mapping, request/response shape).
 *
 * Mirrors `tests/adminEscrow.softDelete.route.test.js` so the test surface is
 * consistent across admin soft-delete endpoints.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  createRequestLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

// The service layer is mocked so the routes' validation and error mapping
// are isolated from the database. The error code constants are kept so the
// tests can refer to the canonical `code` strings.
jest.mock('../src/services/invoiceStateSoftDelete', () => {
  const actual = jest.requireActual('../src/services/invoiceStateSoftDelete');
  return {
    ...actual,
    softDeleteInvoiceState: jest.fn(),
    restoreInvoiceState: jest.fn(),
    getInvoiceStateDeletionState: jest.fn(),
    purgeExpiredInvoiceStateSoftDeletes: jest.fn(),
  };
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const service = require('../src/services/invoiceStateSoftDelete');
const adminInvoiceStateRouter = require('../src/routes/adminInvoiceState');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Signs an admin JWT accepted by the admin middleware stack.
 *
 * @param {object} [overrides={}] - Claim overrides.
 * @returns {string} Signed token.
 */
function makeToken(overrides = {}) {
  return jwt.sign(
    { sub: 'admin-user', tenantId: 'tenant-test', role: 'admin', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h', issuer: 'liquifact', audience: 'liquifact-api' }
  );
}

/**
 * Mounts the admin invoice-state router with a status-preserving error
 * handler so service errors are surfaced as their declared HTTP status
 * (the global handler in `src/app.js` is not in scope for this isolated app).
 *
 * @returns {import('express').Express} Test app.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/invoices', adminInvoiceStateRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      title: err.title,
      detail: err.detail || err.message,
    });
  });
  return app;
}

const app = buildApp();
const auth = () => ({ Authorization: `Bearer ${makeToken()}` });

const DELETED_STATE = {
  invoiceId: 'inv_001',
  deleted: true,
  deletedAt: '2026-08-01T12:00:00.000Z',
  deletedBy: 'admin-user',
  deleteReason: 'duplicate',
  restoredAt: null,
  restoredBy: null,
  purgeAfter: '2026-08-31T12:00:00.000Z',
  restorable: true,
  retentionDays: 30,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authentication', () => {
  test('rejects unauthenticated soft-delete requests', async () => {
    const res = await request(app).delete('/api/admin/invoices/inv_001');
    expect(res.status).toBe(401);
    expect(service.softDeleteInvoiceState).not.toHaveBeenCalled();
  });

  test('rejects unauthenticated restore requests', async () => {
    const res = await request(app).post('/api/admin/invoices/inv_001/restore');
    expect(res.status).toBe(401);
    expect(service.restoreInvoiceState).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/invoices/:invoiceId', () => {
  test('soft-deletes and returns the retention envelope', async () => {
    service.softDeleteInvoiceState.mockResolvedValue(DELETED_STATE);

    const res = await request(app)
      .delete('/api/admin/invoices/inv_001')
      .set(auth())
      .send({ reason: 'duplicate' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DELETED_STATE);
    expect(service.softDeleteInvoiceState).toHaveBeenCalledWith('inv_001', {
      actor: 'admin-user',
      reason: 'duplicate',
    });
  });

  test('accepts a request with no body and records a null reason', async () => {
    service.softDeleteInvoiceState.mockResolvedValue({ ...DELETED_STATE, deleteReason: null });

    const res = await request(app).delete('/api/admin/invoices/inv_001').set(auth());

    expect(res.status).toBe(200);
    expect(service.softDeleteInvoiceState).toHaveBeenCalledWith('inv_001', {
      actor: 'admin-user',
      reason: null,
    });
  });

  test('rejects a non-string reason', async () => {
    const res = await request(app)
      .delete('/api/admin/invoices/inv_001')
      .set(auth())
      .send({ reason: { nested: true } });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/reason must be a string/);
    expect(service.softDeleteInvoiceState).not.toHaveBeenCalled();
  });

  test('rejects an over-long reason', async () => {
    const res = await request(app)
      .delete('/api/admin/invoices/inv_001')
      .set(auth())
      .send({ reason: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/at most 500 characters/);
  });

  test('maps NOT_FOUND to 404', async () => {
    service.softDeleteInvoiceState.mockRejectedValue(
      Object.assign(new Error('missing'), {
        code: service.SOFT_DELETE_ERRORS.NOT_FOUND,
        status: 404,
      })
    );

    const res = await request(app).delete('/api/admin/invoices/inv_404').set(auth());
    expect(res.status).toBe(404);
    expect(res.body.title).toBe('Not Found');
  });

  test('maps ALREADY_DELETED to 409', async () => {
    service.softDeleteInvoiceState.mockRejectedValue(
      Object.assign(new Error('already deleted'), {
        code: service.SOFT_DELETE_ERRORS.ALREADY_DELETED,
        status: 409,
      })
    );

    const res = await request(app).delete('/api/admin/invoices/inv_001').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.title).toBe('Conflict');
  });

  test('maps INVALID_INVOICE_ID to 400', async () => {
    service.softDeleteInvoiceState.mockRejectedValue(
      Object.assign(new Error('bad id'), {
        code: service.SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
        status: 400,
      })
    );

    const res = await request(app).delete('/api/admin/invoices/bad%20id%21').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Validation Error');
  });

  test('passes unknown errors through as 500', async () => {
    service.softDeleteInvoiceState.mockRejectedValue(new Error('db exploded'));

    const res = await request(app).delete('/api/admin/invoices/inv_001').set(auth());
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/invoices/:invoiceId/restore', () => {
  test('restores within the window', async () => {
    const restored = { ...DELETED_STATE, deleted: false, deletedAt: null, restorable: false };
    service.restoreInvoiceState.mockResolvedValue(restored);

    const res = await request(app)
      .post('/api/admin/invoices/inv_001/restore')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(service.restoreInvoiceState).toHaveBeenCalledWith('inv_001', { actor: 'admin-user' });
  });

  test('maps RETENTION_EXPIRED to 410 Gone', async () => {
    service.restoreInvoiceState.mockRejectedValue(
      Object.assign(new Error('window expired'), {
        code: service.SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
        status: 410,
      })
    );

    const res = await request(app)
      .post('/api/admin/invoices/inv_001/restore')
      .set(auth());

    expect(res.status).toBe(410);
    expect(res.body.title).toBe('Retention Window Expired');
  });

  test('maps NOT_DELETED to 409', async () => {
    service.restoreInvoiceState.mockRejectedValue(
      Object.assign(new Error('not deleted'), {
        code: service.SOFT_DELETE_ERRORS.NOT_DELETED,
        status: 409,
      })
    );

    const res = await request(app)
      .post('/api/admin/invoices/inv_001/restore')
      .set(auth());

    expect(res.status).toBe(409);
  });

  test('falls back to a null actor when the token carries no subject claim', async () => {
    service.restoreInvoiceState.mockResolvedValue(DELETED_STATE);
    const token = jwt.sign(
      { tenantId: 'tenant-test', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1h', issuer: 'liquifact', audience: 'liquifact-api' }
    );

    await request(app)
      .post('/api/admin/invoices/inv_001/restore')
      .set({ Authorization: `Bearer ${token}` });

    expect(service.restoreInvoiceState).toHaveBeenCalledWith('inv_001', { actor: null });
  });
});

describe('GET /api/admin/invoices/:invoiceId/deletion-state', () => {
  test('returns the soft-delete state', async () => {
    service.getInvoiceStateDeletionState.mockResolvedValue(DELETED_STATE);

    const res = await request(app)
      .get('/api/admin/invoices/inv_001/deletion-state')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DELETED_STATE);
  });

  test('maps NOT_FOUND to 404', async () => {
    service.getInvoiceStateDeletionState.mockRejectedValue(
      Object.assign(new Error('missing'), {
        code: service.SOFT_DELETE_ERRORS.NOT_FOUND,
        status: 404,
      })
    );

    const res = await request(app)
      .get('/api/admin/invoices/inv_404/deletion-state')
      .set(auth());

    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/invoices/purge', () => {
  test('returns purge counts without the per-invoice list', async () => {
    service.purgeExpiredInvoiceStateSoftDeletes.mockResolvedValue({
      purged: 3,
      batches: 1,
      cutoff: '2026-07-01T00:00:00.000Z',
      retentionDays: 30,
      maxBatchesReached: false,
      invoiceIds: ['a', 'b', 'c'],
    });

    const res = await request(app).post('/api/admin/invoices/purge').set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      purged: 3,
      batches: 1,
      cutoff: '2026-07-01T00:00:00.000Z',
      retentionDays: 30,
      maxBatchesReached: false,
    });
    // `invoiceIds` stays in the service return value (logs) but is stripped
    // from the HTTP response to keep payloads bounded.
    expect(res.body.invoiceIds).toBeUndefined();
  });

  test('forwards purge failures to the error handler', async () => {
    service.purgeExpiredInvoiceStateSoftDeletes.mockRejectedValue(new Error('db down'));

    const res = await request(app).post('/api/admin/invoices/purge').set(auth());
    expect(res.status).toBe(500);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/api/admin/invoices/purge');
    expect(res.status).toBe(401);
    expect(service.purgeExpiredInvoiceStateSoftDeletes).not.toHaveBeenCalled();
  });
});
