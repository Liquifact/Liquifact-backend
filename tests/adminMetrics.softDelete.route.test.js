'use strict';

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

jest.mock('../src/services/metricsSoftDelete', () => {
  const actual = jest.requireActual('../src/services/metricsSoftDelete');
  return {
    ...actual,
    softDeleteMetricRecord: jest.fn(),
    restoreMetricRecord: jest.fn(),
    getMetricRecordDeletionState: jest.fn(),
    purgeExpiredSoftDeletes: jest.fn(),
  };
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const service = require('../src/services/metricsSoftDelete');
const adminMetricsRouter = require('../src/routes/adminMetrics');

const JWT_SECRET = process.env.JWT_SECRET;

function makeToken(overrides = {}) {
  return jwt.sign(
    { sub: 'admin-user', tenantId: 'tenant-test', role: 'admin', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h', issuer: 'liquifact', audience: 'liquifact-api' }
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/metrics', adminMetricsRouter);
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
  id: 'rec-001',
  metricName: 'test_metric',
  metricType: 'gauge',
  metricValue: 42,
  labels: {},
  recordedAt: '2026-07-01T00:00:00.000Z',
  deleted: true,
  deletedAt: '2026-07-25T12:00:00.000Z',
  deletedBy: 'admin-user',
  deleteReason: 'cleanup',
  restoredAt: null,
  restoredBy: null,
  purgeAfter: '2026-08-24T12:00:00.000Z',
  restorable: true,
  retentionDays: 30,
};

const LIVE_STATE = {
  ...DELETED_STATE,
  deleted: false,
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  purgeAfter: null,
  restorable: false,
};

describe('adminMetrics soft-delete routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DELETE /records/:id', () => {
    it('returns 200 and the deletion state on success', async () => {
      service.softDeleteMetricRecord.mockResolvedValue(DELETED_STATE);

      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-001')
        .set(auth())
        .send({ reason: 'cleanup' });

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(res.body.id).toBe('rec-001');
      expect(service.softDeleteMetricRecord).toHaveBeenCalledWith(
        'rec-001',
        expect.objectContaining({ actor: 'admin-user', reason: 'cleanup' })
      );
    });

    it('returns 200 with null reason when omitted', async () => {
      service.softDeleteMetricRecord.mockResolvedValue(DELETED_STATE);

      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-001')
        .set(auth());

      expect(res.status).toBe(200);
      expect(service.softDeleteMetricRecord).toHaveBeenCalledWith(
        'rec-001',
        expect.objectContaining({ reason: null })
      );
    });

    it('returns 400 when reason is too long', async () => {
      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-001')
        .set(auth())
        .send({ reason: 'x'.repeat(501) });

      expect(res.status).toBe(400);
      expect(service.softDeleteMetricRecord).not.toHaveBeenCalled();
    });

    it('returns 400 when reason is not a string', async () => {
      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-001')
        .set(auth())
        .send({ reason: 42 });

      expect(res.status).toBe(400);
      expect(service.softDeleteMetricRecord).not.toHaveBeenCalled();
    });

    it('returns 401 without auth header', async () => {
      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-001');

      expect(res.status).toBe(401);
    });

    it('maps NOT_FOUND to 404', async () => {
      const err = new Error('No metric record found for id');
      err.code = 'METRIC_RECORD_NOT_FOUND';
      err.status = 404;
      service.softDeleteMetricRecord.mockRejectedValue(err);

      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-404')
        .set(auth());

      expect(res.status).toBe(404);
    });

    it('maps ALREADY_DELETED to 409', async () => {
      const err = new Error('already deleted');
      err.code = 'METRIC_RECORD_ALREADY_DELETED';
      err.status = 409;
      service.softDeleteMetricRecord.mockRejectedValue(err);

      const res = await request(app)
        .delete('/api/admin/metrics/records/rec-001')
        .set(auth());

      expect(res.status).toBe(409);
    });
  });

  describe('POST /records/:id/restore', () => {
    it('returns 200 on successful restore', async () => {
      service.restoreMetricRecord.mockResolvedValue(LIVE_STATE);

      const res = await request(app)
        .post('/api/admin/metrics/records/rec-001/restore')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(false);
      expect(service.restoreMetricRecord).toHaveBeenCalledWith(
        'rec-001',
        expect.objectContaining({ actor: 'admin-user' })
      );
    });

    it('returns 401 without auth header', async () => {
      const res = await request(app)
        .post('/api/admin/metrics/records/rec-001/restore');

      expect(res.status).toBe(401);
    });

    it('maps NOT_DELETED to 409', async () => {
      const err = new Error('not deleted');
      err.code = 'METRIC_RECORD_NOT_DELETED';
      err.status = 409;
      service.restoreMetricRecord.mockRejectedValue(err);

      const res = await request(app)
        .post('/api/admin/metrics/records/rec-001/restore')
        .set(auth());

      expect(res.status).toBe(409);
    });

    it('maps RETENTION_EXPIRED to 410', async () => {
      const err = new Error('retention expired');
      err.code = 'METRIC_RECORD_RETENTION_EXPIRED';
      err.status = 410;
      service.restoreMetricRecord.mockRejectedValue(err);

      const res = await request(app)
        .post('/api/admin/metrics/records/rec-001/restore')
        .set(auth());

      expect(res.status).toBe(410);
    });
  });

  describe('GET /records/:id/deletion-state', () => {
    it('returns 200 with deletion state', async () => {
      service.getMetricRecordDeletionState.mockResolvedValue(LIVE_STATE);

      const res = await request(app)
        .get('/api/admin/metrics/records/rec-001/deletion-state')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('rec-001');
      expect(res.body.deleted).toBe(false);
    });

    it('maps NOT_FOUND to 404', async () => {
      const err = new Error('not found');
      err.code = 'METRIC_RECORD_NOT_FOUND';
      err.status = 404;
      service.getMetricRecordDeletionState.mockRejectedValue(err);

      const res = await request(app)
        .get('/api/admin/metrics/records/rec-404/deletion-state')
        .set(auth());

      expect(res.status).toBe(404);
    });
  });

  describe('POST /records/purge', () => {
    it('returns 200 with purge summary', async () => {
      service.purgeExpiredSoftDeletes.mockResolvedValue({
        purged: 5,
        batches: 1,
        cutoff: '2026-06-25T12:00:00.000Z',
        retentionDays: 30,
        maxBatchesReached: false,
        ids: ['rec-001', 'rec-002'],
      });

      const res = await request(app)
        .post('/api/admin/metrics/records/purge')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.purged).toBe(5);
      expect(res.body.batches).toBe(1);
      expect(res.body.ids).toBeUndefined();
    });

    it('returns 401 without auth header', async () => {
      const res = await request(app)
        .post('/api/admin/metrics/records/purge');

      expect(res.status).toBe(401);
    });
  });
});
