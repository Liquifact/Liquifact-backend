'use strict';

/**
 * @fileoverview Comprehensive unit tests for src/services/kycWebhookService.js.
 */

const crypto = require('crypto');
const db = require('../../src/db/knex');
const kycService = require('../../src/services/kycService');
const kycWebhookService = require('../../src/services/kycWebhookService');
const { getAuditLogs } = require('../../src/services/auditLog');
const KycWebhookError = require('../../src/errors/KycWebhookError');
const { KYC_WEBHOOK_ERROR_CODES, KYC_WEBHOOK_PAGINATION } = require('../../src/constants/kycWebhooks');
const { encodeCursor } = require('../../src/utils/cursorPagination');

jest.mock('../../src/db/knex', () => {
  const mKnex = jest.fn();
  return mKnex;
});

jest.mock('../../src/services/kycService');
jest.mock('../../src/services/auditLog');

function createSignature(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('kycWebhookService', () => {
  const secret = 'test-provider-secret-key-12345';

  beforeEach(() => {
    jest.clearAllMocks();
    kycService.getKycProviderConfig.mockReturnValue({
      apiSecret: secret,
    });
    kycService.normalizeProviderStatus.mockImplementation((s) => {
      if (s === 'verified' || s === 'approved') return 'verified';
      if (s === 'pending') return 'pending';
      if (s === 'rejected') return 'rejected';
      return 'unknown';
    });
    kycService.KYC_STATUSES = { UNKNOWN: 'unknown', VERIFIED: 'verified', PENDING: 'pending' };
  });

  describe('processWebhookIngestion', () => {
    it('throws 503 MISSING_SECRET when provider secret is missing', async () => {
      kycService.getKycProviderConfig.mockReturnValueOnce({ apiSecret: null });

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: '{}',
          signatureHeader: 'sig',
        })
      ).rejects.toThrow(KycWebhookError);

      try {
        kycService.getKycProviderConfig.mockReturnValueOnce({ apiSecret: null });
        await kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: 'sig' });
      } catch (err) {
        expect(err.status).toBe(503);
        expect(err.code).toBe(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET);
      }
    });

    it('throws 401 MISSING_SIGNATURE when signature header is missing', async () => {
      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: '{"smeId":"sme-1","status":"verified"}',
          signatureHeader: '',
        })
      ).rejects.toMatchObject({
        status: 401,
        code: KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE,
      });
    });

    it('throws 401 INVALID_SIGNATURE when signature verification fails', async () => {
      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: '{"smeId":"sme-1","status":"verified"}',
          signatureHeader: 'invalid-signature-hash',
        })
      ).rejects.toMatchObject({
        status: 401,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE,
      });
    });

    it('throws 400 INVALID_PAYLOAD when rawBody is not valid JSON', async () => {
      const body = 'invalid-json';
      const sig = createSignature(secret, body);

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: body,
          signatureHeader: sig,
        })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD,
      });
    });

    it('throws 400 MISSING_TENANT_CONTEXT when payload has tenantId but request context does not', async () => {
      const body = JSON.stringify({ smeId: 'sme-1', status: 'verified', tenantId: 'tenant-123' });
      const sig = createSignature(secret, body);

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: body,
          signatureHeader: sig,
          requestTenantId: null,
        })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT,
      });
    });

    it('throws 400 MISSING_SME_ID when smeId is missing from payload', async () => {
      const body = JSON.stringify({ status: 'verified' });
      const sig = createSignature(secret, body);

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: body,
          signatureHeader: sig,
        })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID,
      });
    });

    it('throws 400 MISSING_STATUS when status is missing from payload', async () => {
      const body = JSON.stringify({ smeId: 'sme-1' });
      const sig = createSignature(secret, body);

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: body,
          signatureHeader: sig,
        })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS,
      });
    });

    it('throws 400 UNKNOWN_STATUS when status normalises to UNKNOWN', async () => {
      const body = JSON.stringify({ smeId: 'sme-1', status: 'weird_status' });
      const sig = createSignature(secret, body);

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: body,
          signatureHeader: sig,
        })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS,
      });
    });

    it('ingests valid webhook successfully with Buffer input and custom metadata', async () => {
      const payload = { smeId: 'sme-100', status: 'verified', recordId: 'rec-1' };
      const bodyStr = JSON.stringify(payload);
      const rawBody = Buffer.from(bodyStr, 'utf8');
      const sig = createSignature(secret, bodyStr);

      kycService.persistKycRecord.mockResolvedValueOnce({
        smeId: 'sme-100',
        status: 'verified',
        recordId: 'rec-1',
      });

      const res = await kycWebhookService.processWebhookIngestion({
        rawBody,
        signatureHeader: sig,
        actor: 'test-user',
        ipAddress: '1.2.3.4',
        userAgent: 'test-agent',
      });

      expect(res).toEqual({
        success: true,
        smeId: 'sme-100',
        status: 'verified',
      });
      expect(kycService.persistKycRecord).toHaveBeenCalledWith(
        {
          smeId: 'sme-100',
          status: 'verified',
          providerRecordId: 'rec-1',
          verifiedAt: null,
        },
        {
          actor: 'test-user',
          ipAddress: '1.2.3.4',
          userAgent: 'test-agent',
        }
      );
    });

    it('handles persistence error gracefully with 500 PERSISTENCE_ERROR', async () => {
      const payload = { smeId: 'sme-100', status: 'verified' };
      const bodyStr = JSON.stringify(payload);
      const sig = createSignature(secret, bodyStr);

      kycService.persistKycRecord.mockRejectedValueOnce(new Error('Database deadlock'));

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: bodyStr,
          signatureHeader: sig,
        })
      ).rejects.toMatchObject({
        status: 500,
        code: KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR,
        message: 'Database deadlock',
      });
    });

    it('throws validation error when pre-ingestion validation helper returns error', async () => {
      const payload = { smeId: 'sme-100', status: 'verified', tenantId: 't1' };
      const bodyStr = JSON.stringify(payload);
      const sig = createSignature(secret, bodyStr);

      // Trigger pre-ingestion failure for secret error path
      kycService.getKycProviderConfig.mockReturnValueOnce({ apiSecret: 'other-secret' });

      await expect(
        kycWebhookService.processWebhookIngestion({
          rawBody: bodyStr,
          signatureHeader: sig,
          requestTenantId: 't2',
        })
      ).rejects.toThrow(KycWebhookError);
    });
  });

  describe('getWebhookAuditLogs', () => {
    it('returns formatted audit logs with default limit and offset', async () => {
      const mockLogs = [
        { id: 1, action: 'CREATE', secretKey: 'sensitive-token' },
      ];
      getAuditLogs.mockResolvedValueOnce(mockLogs);

      const res = await kycWebhookService.getWebhookAuditLogs({});

      expect(getAuditLogs).toHaveBeenCalledWith({
        resourceType: 'kyc-webhook',
        resourceId: null,
        action: null,
        limit: KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT,
        offset: 0,
      });

      expect(res.data).toBeDefined();
      expect(res.meta).toEqual({
        limit: KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT,
        offset: 0,
        count: 1,
      });
    });

    it('applies smeId and action filters when provided', async () => {
      getAuditLogs.mockResolvedValueOnce([]);

      await kycWebhookService.getWebhookAuditLogs({
        smeId: 'sme-55',
        action: 'UPDATE',
        rawLimit: '10',
        rawOffset: '5',
      });

      expect(getAuditLogs).toHaveBeenCalledWith({
        resourceType: 'kyc-webhook',
        resourceId: 'sme-55',
        action: 'UPDATE',
        limit: 10,
        offset: 5,
      });
    });

    it('throws 400 INVALID_PAGINATION for limit < 1', async () => {
      await expect(
        kycWebhookService.getWebhookAuditLogs({ rawLimit: '0' })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION,
      });
    });

    it('throws 400 INVALID_PAGINATION for limit > MAX_LIMIT', async () => {
      await expect(
        kycWebhookService.getWebhookAuditLogs({ rawLimit: '500' })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION,
      });
    });

    it('throws 400 INVALID_PAGINATION for negative offset', async () => {
      await expect(
        kycWebhookService.getWebhookAuditLogs({ rawOffset: '-5' })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION,
      });
    });
  });

  describe('listWebhooks', () => {
    let mockChain;

    beforeEach(() => {
      mockChain = {
        select: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        then: jest.fn(),
      };
      db.mockReturnValue(mockChain);
    });

    it('returns paginated records without cursor', async () => {
      const mockRows = [
        { smeId: 'sme-1', status: 'verified', recordId: 'r1', verifiedAt: null, updatedAt: '2026-07-28T00:00:00.000Z' },
      ];
      mockChain.then.mockImplementation((resolve) => resolve(mockRows));

      const res = await kycWebhookService.listWebhooks({});

      expect(res.data).toEqual(mockRows);
      expect(res.meta).toEqual({
        limit: KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT,
        hasMore: false,
        nextCursor: null,
      });
    });

    it('throws 400 INVALID_PAGINATION for invalid rawLimit parameter', async () => {
      await expect(
        kycWebhookService.listWebhooks({ rawLimit: 'not-a-number' })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION,
      });
    });

    it('throws 400 INVALID_CURSOR for malformed cursor', async () => {
      await expect(
        kycWebhookService.listWebhooks({ cursor: 'invalid-base64-string!' })
      ).rejects.toMatchObject({
        status: 400,
        code: KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR,
      });
    });

    it('handles cursor pagination and returns nextCursor when results exceed limit', async () => {
      const validCursor = encodeCursor({
        sortField: 'updated_at',
        sortValue: '2026-07-26T12:00:00.000Z',
        id: 'sme-10',
      });

      const mockRows = [
        { smeId: 'sme-1', status: 'verified', recordId: 'r1', verifiedAt: null, updatedAt: new Date('2026-07-26T10:00:00.000Z') },
        { smeId: 'sme-2', status: 'verified', recordId: 'r2', verifiedAt: null, updatedAt: new Date('2026-07-26T09:00:00.000Z') },
        { smeId: 'sme-3', status: 'verified', recordId: 'r3', verifiedAt: null, updatedAt: new Date('2026-07-26T08:00:00.000Z') },
      ];
      mockChain.then.mockImplementation((resolve) => resolve(mockRows));

      const res = await kycWebhookService.listWebhooks({
        cursor: validCursor,
        status: 'verified',
        rawLimit: '2',
      });

      expect(res.data.length).toBe(2);
      expect(res.meta.hasMore).toBe(true);
      expect(res.meta.nextCursor).toBeDefined();
    });

    it('throws 500 INTERNAL_ERROR when response validation fails schema', async () => {
      const mockRows = [
        { smeId: null, status: 'verified', recordId: 'r1', verifiedAt: null, updatedAt: '2026-07-28T00:00:00.000Z' },
      ];
      mockChain.then.mockImplementation((resolve) => resolve(mockRows));

      await expect(
        kycWebhookService.listWebhooks({})
      ).rejects.toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });
});
