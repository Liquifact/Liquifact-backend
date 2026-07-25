'use strict';

/**
 * @fileoverview Route-level tests for the escrow-read soft-delete admin API
 * (issue #31).
 *
 * Covers:
 *  - authentication (JWT bearer vs. unauthenticated)
 *  - request validation (`reason` type/length)
 *  - actor attribution written to the service layer
 *  - service error → RFC 7807 status mapping (400/404/409/410)
 *  - the manual purge endpoint's response shape
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

// The service layer is exercised directly in tests/escrow.softDelete.test.js;
// here it is mocked so the routes' validation and error mapping are isolated.
jest.mock('../src/services/escrowReadSoftDelete', () => {
  const actual = jest.requireActual('../src/services/escrowReadSoftDelete');
  return {
    ...actual,
    softDeleteEscrowRead: jest.fn(),
    restoreEscrowRead: jest.fn(),
    getEscrowReadDeletionState: jest.fn(),
    purgeExpiredSoftDeletes: jest.fn(),
  };
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const service = require('../src/services/escrowReadSoftDelete');
const adminEscrowRouter = require('../src/routes/adminEscrow');

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
 * Mounts the admin escrow router with a status-preserving error handler.
 *
 * @returns {import('express').Express} Test app.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/escrow', adminEscrowRouter);
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
  deletedAt: '2026-07-25T12:00:00.000Z',
  deletedBy: 'admin-user',
  deleteReason: 'duplicate projection',
  restoredAt: null,
  restoredBy: null,
  purgeAfter: '2026-08-24T12:00:00.000Z',
  restorable: true,
  retentionDays: 30,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authentication', () => {
  test('rejects unauthenticated soft-delete requests', async () => {
    const res = await request(app).delete('/api/admin/escrow/reads/inv_001');
    expect(res.status).toBe(401);
    expect(service.softDeleteEscrowRead).not.toHaveBeenCalled();
  });

  test('rejects unauthenticated restore requests', async () => {
    const res = await request(app).post('/api/admin/escrow/reads/inv_001/restore');
    expect(res.status).toBe(401);
    expect(service.restoreEscrowRead).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/escrow/reads/:invoiceId', () => {
  test('soft-deletes and returns the retention envelope', async () => {
    service.softDeleteEscrowRead.mockResolvedValue(DELETED_STATE);

    const res = await request(app)
      .delete('/api/admin/escrow/reads/inv_001')
      .set(auth())
      .send({ reason: 'duplicate projection' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DELETED_STATE);
    expect(service.softDeleteEscrowRead).toHaveBeenCalledWith('inv_001', {
      actor: 'admin-user',
      reason: 'duplicate projection',
    });
  });

  test('accepts a request with no body and records a null reason', async () => {
    service.softDeleteEscrowRead.mockResolvedValue({ ...DELETED_STATE, deleteReason: null });

    const res = await request(app).delete('/api/admin/escrow/reads/inv_001').set(auth());

    expect(res.status).toBe(200);
    expect(service.softDeleteEscrowRead).toHaveBeenCalledWith('inv_001', {
      actor: 'admin-user',
      reason: null,
    });
  });

  test('rejects a non-string reason', async () => {
    const res = await request(app)
      .delete('/api/admin/escrow/reads/inv_001')
      .set(auth())
      .send({ reason: { nested: true } });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/reason must be a string/);
    expect(service.softDeleteEscrowRead).not.toHaveBeenCalled();
  });

  test('rejects an over-long reason', async () => {
    const res = await request(app)
      .delete('/api/admin/escrow/reads/inv_001')
      .set(auth())
      .send({ reason: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/at most 500 characters/);
  });

  test('maps NOT_FOUND to 404', async () => {
    service.softDeleteEscrowRead.mockRejectedValue(
      Object.assign(new Error('missing'), {
        code: service.SOFT_DELETE_ERRORS.NOT_FOUND,
        status: 404,
      })
    );

    const res = await request(app).delete('/api/admin/escrow/reads/inv_404').set(auth());
    expect(res.status).toBe(404);
    expect(res.body.title).toBe('Not Found');
  });

  test('maps ALREADY_DELETED to 409', async () => {
    service.softDeleteEscrowRead.mockRejectedValue(
      Object.assign(new Error('already deleted'), {
        code: service.SOFT_DELETE_ERRORS.ALREADY_DELETED,
        status: 409,
      })
    );

    const res = await request(app).delete('/api/admin/escrow/reads/inv_001').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.title).toBe('Conflict');
  });

  test('maps INVALID_INVOICE_ID to 400', async () => {
    service.softDeleteEscrowRead.mockRejectedValue(
      Object.assign(new Error('bad id'), {
        code: service.SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
        status: 400,
      })
    );

    const res = await request(app).delete('/api/admin/escrow/reads/bad').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Validation Error');
  });

  test('passes unknown errors through as 500', async () => {
    service.softDeleteEscrowRead.mockRejectedValue(new Error('db exploded'));

    const res = await request(app).delete('/api/admin/escrow/reads/inv_001').set(auth());
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/escrow/reads/:invoiceId/restore', () => {
  test('restores within the window', async () => {
    const restored = { ...DELETED_STATE, deleted: false, deletedAt: null, restorable: false };
    service.restoreEscrowRead.mockResolvedValue(restored);

    const res = await request(app)
      .post('/api/admin/escrow/reads/inv_001/restore')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(service.restoreEscrowRead).toHaveBeenCalledWith('inv_001', { actor: 'admin-user' });
  });

  test('maps RETENTION_EXPIRED to 410 Gone', async () => {
    service.restoreEscrowRead.mockRejectedValue(
      Object.assign(new Error('window expired'), {
        code: service.SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
        status: 410,
      })
    );

    const res = await request(app)
      .post('/api/admin/escrow/reads/inv_001/restore')
      .set(auth());

    expect(res.status).toBe(410);
    expect(res.body.title).toBe('Retention Window Expired');
  });

  test('maps NOT_DELETED to 409', async () => {
    service.restoreEscrowRead.mockRejectedValue(
      Object.assign(new Error('not deleted'), {
        code: service.SOFT_DELETE_ERRORS.NOT_DELETED,
        status: 409,
      })
    );

    const res = await request(app)
      .post('/api/admin/escrow/reads/inv_001/restore')
      .set(auth());

    expect(res.status).toBe(409);
  });

  test('falls back to a null actor when the token carries no subject claim', async () => {
    service.restoreEscrowRead.mockResolvedValue(DELETED_STATE);
    const token = jwt.sign(
      { tenantId: 'tenant-test', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1h', issuer: 'liquifact', audience: 'liquifact-api' }
    );

    await request(app)
      .post('/api/admin/escrow/reads/inv_001/restore')
      .set({ Authorization: `Bearer ${token}` });

    expect(service.restoreEscrowRead).toHaveBeenCalledWith('inv_001', { actor: null });
  });
});

describe('GET /api/admin/escrow/reads/:invoiceId/deletion-state', () => {
  test('returns the soft-delete state', async () => {
    service.getEscrowReadDeletionState.mockResolvedValue(DELETED_STATE);

    const res = await request(app)
      .get('/api/admin/escrow/reads/inv_001/deletion-state')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DELETED_STATE);
  });

  test('maps NOT_FOUND to 404', async () => {
    service.getEscrowReadDeletionState.mockRejectedValue(
      Object.assign(new Error('missing'), {
        code: service.SOFT_DELETE_ERRORS.NOT_FOUND,
        status: 404,
      })
    );

    const res = await request(app)
      .get('/api/admin/escrow/reads/inv_404/deletion-state')
      .set(auth());

    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/escrow/reads/purge', () => {
  test('returns purge counts without the per-invoice list', async () => {
    service.purgeExpiredSoftDeletes.mockResolvedValue({
      purged: 3,
      batches: 1,
      cutoff: '2026-06-25T12:00:00.000Z',
      retentionDays: 30,
      maxBatchesReached: false,
      invoiceIds: ['a', 'b', 'c'],
    });

    const res = await request(app).post('/api/admin/escrow/reads/purge').set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      purged: 3,
      batches: 1,
      cutoff: '2026-06-25T12:00:00.000Z',
      retentionDays: 30,
      maxBatchesReached: false,
    });
    expect(res.body.invoiceIds).toBeUndefined();
  });

  test('forwards purge failures to the error handler', async () => {
    service.purgeExpiredSoftDeletes.mockRejectedValue(new Error('db down'));

    const res = await request(app).post('/api/admin/escrow/reads/purge').set(auth());
    expect(res.status).toBe(500);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/api/admin/escrow/reads/purge');
    expect(res.status).toBe(401);
    expect(service.purgeExpiredSoftDeletes).not.toHaveBeenCalled();
  });
});
