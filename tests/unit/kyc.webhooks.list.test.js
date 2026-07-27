'use strict';

/**
 * @fileoverview Unit tests for GET /api/kyc/webhooks (cursor-paginated listing endpoint).
 */

const express = require('express');
const request = require('supertest');
const db = require('../../src/db/knex');
const kycRoutes = require('../../src/routes/kyc');
const { encodeCursor } = require('../../src/utils/cursorPagination');
const { KYC_WEBHOOK_ERROR_CODES, KYC_WEBHOOK_PAGINATION } = require('../../src/constants/kycWebhooks');

jest.mock('../../src/services/kycService', () => ({
  getKycProviderConfig: jest.fn().mockReturnValue({ apiSecret: 'test-secret' }),
  normalizeProviderStatus: jest.fn().mockImplementation((status) => status),
  KYC_STATUSES: { UNKNOWN: 'unknown' },
}));

jest.mock('../../src/db/knex', () => {
  const mKnex = jest.fn();
  return mKnex;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/kyc', kycRoutes);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe('GET /api/kyc/webhooks — cursor pagination listing', () => {
  let mockChain;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChain = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      then: jest.fn(),
    };
    db.mockReturnValue(mockChain);
  });

  it('rejects invalid limit parameter with 400 INVALID_PAGINATION', async () => {
    const res = await request(buildApp()).get('/api/kyc/webhooks?limit=invalid');
    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error?.code).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION);
  });

  it('rejects limit greater than MAX_LIMIT with 400 INVALID_PAGINATION', async () => {
    const res = await request(buildApp()).get(`/api/kyc/webhooks?limit=${KYC_WEBHOOK_PAGINATION.MAX_LIMIT + 1}`);
    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error?.code).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION);
  });

  it('rejects invalid cursor with 400 INVALID_CURSOR', async () => {
    const res = await request(buildApp()).get('/api/kyc/webhooks?cursor=bad-cursor-string');
    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error?.code).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR);
  });

  it('returns records with default limit when valid request is made', async () => {
    const mockRows = [
      { smeId: 'sme-1', status: 'verified', recordId: 'rec-1', verifiedAt: '2026-07-26T00:00:00.000Z', updatedAt: new Date() },
    ];
    mockChain.then.mockImplementation((resolve) => resolve(mockRows));

    const res = await request(buildApp()).get('/api/kyc/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it('filters by status when status query parameter is provided', async () => {
    mockChain.then.mockImplementation((resolve) => resolve([]));

    const res = await request(buildApp()).get('/api/kyc/webhooks?status=verified');
    expect(res.status).toBe(200);
    expect(mockChain.where).toHaveBeenCalledWith('status', 'verified');
  });

  it('handles cursor pagination and returns nextCursor when rows > limit', async () => {
    const validCursor = encodeCursor({
      sortField: 'updated_at',
      sortValue: '2026-07-26T12:00:00.000Z',
      id: 'sme-10',
    });

    const mockRows = Array.from({ length: 3 }, (_, i) => ({
      smeId: `sme-${i + 1}`,
      status: 'verified',
      recordId: `rec-${i + 1}`,
      verifiedAt: '2026-07-26T00:00:00.000Z',
      updatedAt: new Date('2026-07-26T10:00:00.000Z'),
    }));
    mockChain.then.mockImplementation((resolve) => resolve(mockRows));

    const res = await request(buildApp()).get(`/api/kyc/webhooks?limit=2&cursor=${encodeURIComponent(validCursor)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.meta.hasMore).toBe(true);
    expect(res.body.meta.nextCursor).toBeDefined();
  });

  it('forwards database error to error handler middleware', async () => {
    mockChain.then.mockImplementation((resolve, reject) => reject(new Error('Database query failure')));

    const res = await request(buildApp()).get('/api/kyc/webhooks');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Database query failure');
  });
});
