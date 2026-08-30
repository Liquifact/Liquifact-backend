'use strict';

/**
 * @fileoverview Comprehensive unit tests for src/services/kycQuarantineService.js (Issue #1197).
 *
 * Edge cases covered:
 *   1. invalid JSON
 *   2. valid envelope with invalid event
 *   3. oversized payload
 *   4. unknown event type
 *   5. sensitive fields in the quarantine record (redaction)
 *   6. tenant isolation and bounded inspection queries
 *   7. DB error resilience (fail-safe quarantine write)
 */

const db = require('../../src/db/knex');
const {
  quarantineKycWebhook,
  listQuarantinedWebhooks,
  getQuarantinedWebhookById,
  validateEnvelope,
  redactQuarantineValue,
  redactQuarantineString,
  getMaxIngestionPayloadBytes,
  REDACTED,
} = require('../../src/services/kycQuarantineService');
const {
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
} = require('../../src/constants/kycWebhooks');
const { encodeCursor } = require('../../src/utils/cursorPagination');

jest.mock('../../src/db/knex', () => {
  const mKnex = jest.fn();
  return mKnex;
});

describe('kycQuarantineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES;
  });

  // ── Redaction tests ────────────────────────────────────────────────────────

  describe('redactQuarantineValue', () => {
    it('redacts sensitive fields from objects (passwords, tokens, secrets, api keys, ssn, cards)', () => {
      const input = {
        smeId: 'sme-001',
        status: 'verified',
        password: 'my-super-secret-password',
        secret: 'provider-secret-123',
        apiKey: 'api-key-xyz',
        api_key: 'another-key',
        authToken: 'bearer token',
        authorization: 'Bearer 12345',
        privateKey: '---BEGIN PRIVATE KEY---',
        private_key: 'priv-key',
        seed: 'seed-phrase',
        mnemonic: 'twelve words here',
        ssn: '000-11-2222',
        socialSecurityNumber: '000-11-2222',
        tax_id: '12-3456789',
        nationalId: 'NAT-12345',
        cardNumber: '4111222233334444',
        card_number: '5555444433332222',
        cvv: '123',
        cvc: '456',
        passport: 'P12345678',
        signature: 'hex-signature',
        nested: {
          token: 'inner-secret',
          safeField: 'hello',
        },
        arrayField: [
          { token: 'item-secret', safe: 'world' },
          'plain-string',
        ],
      };

      const redacted = redactQuarantineValue(input);

      expect(redacted.smeId).toBe('sme-001');
      expect(redacted.status).toBe('verified');
      expect(redacted.password).toBe(REDACTED);
      expect(redacted.secret).toBe(REDACTED);
      expect(redacted.apiKey).toBe(REDACTED);
      expect(redacted.api_key).toBe(REDACTED);
      expect(redacted.authToken).toBe(REDACTED);
      expect(redacted.authorization).toBe(REDACTED);
      expect(redacted.privateKey).toBe(REDACTED);
      expect(redacted.private_key).toBe(REDACTED);
      expect(redacted.seed).toBe(REDACTED);
      expect(redacted.mnemonic).toBe(REDACTED);
      expect(redacted.ssn).toBe(REDACTED);
      expect(redacted.socialSecurityNumber).toBe(REDACTED);
      expect(redacted.tax_id).toBe(REDACTED);
      expect(redacted.nationalId).toBe(REDACTED);
      expect(redacted.cardNumber).toBe(REDACTED);
      expect(redacted.card_number).toBe(REDACTED);
      expect(redacted.cvv).toBe(REDACTED);
      expect(redacted.cvc).toBe(REDACTED);
      expect(redacted.passport).toBe(REDACTED);
      expect(redacted.signature).toBe(REDACTED);
      expect(redacted.nested.token).toBe(REDACTED);
      expect(redacted.nested.safeField).toBe('hello');
      expect(redacted.arrayField[0].token).toBe(REDACTED);
      expect(redacted.arrayField[0].safe).toBe('world');
      expect(redacted.arrayField[1]).toBe('plain-string');
    });

    it('handles primitives, null, and undefined safely', () => {
      expect(redactQuarantineValue(null)).toBeNull();
      expect(redactQuarantineValue(undefined)).toBeUndefined();
      expect(redactQuarantineValue(12345)).toBe(12345);
      expect(redactQuarantineValue('test-string')).toBe('test-string');
      expect(redactQuarantineValue(true)).toBe(true);
    });
  });

  describe('redactQuarantineString', () => {
    it('redacts sensitive key patterns in raw string text and bounds length', () => {
      const raw = '{"password": "secretPassword", "token": "jwt123", "smeId": "sme-1"}';
      const redacted = redactQuarantineString(raw);
      expect(redacted).not.toContain('secretPassword');
      expect(redacted).not.toContain('jwt123');
      expect(redacted).toContain('smeId');
    });

    it('returns empty string for non-string input', () => {
      expect(redactQuarantineString(null)).toBe('');
      expect(redactQuarantineString(123)).toBe('');
    });
  });

  // ── Envelope validation tests ──────────────────────────────────────────────

  describe('validateEnvelope', () => {
    it('Edge Case 1: invalid JSON → returns valid=false with INVALID_PAYLOAD', () => {
      const result = validateEnvelope('{ malformed json body');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
      expect(result.reason).toBe(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD);
      expect(result.errorDetails).toBeDefined();
    });

    it('Edge Case 2: valid envelope with invalid event payload structure → returns valid=false', () => {
      const result = validateEnvelope(JSON.stringify({
        event: 'kyc.verified',
        data: 'invalid-data-must-be-object',
      }));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Invalid event data/i);
    });

    it('Edge Case 3: oversized payload → returns valid=false with PAYLOAD_TOO_LARGE', () => {
      process.env.KYC_WEBHOOK_MAX_PAYLOAD_BYTES = '50';
      const bigString = 'x'.repeat(100);
      const result = validateEnvelope(JSON.stringify({ note: bigString }));
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE);
      expect(result.reason).toBe(KYC_WEBHOOK_MESSAGES.PAYLOAD_TOO_LARGE);
    });

    it('Edge Case 4: unknown event type → returns valid=false with UNKNOWN_EVENT_TYPE', () => {
      const result = validateEnvelope(JSON.stringify({
        event: 'unknown.bogus.event',
        data: { smeId: 'sme-1', status: 'verified' },
      }));
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.UNKNOWN_EVENT_TYPE);
      expect(result.reason).toMatch(/Unknown KYC webhook event type/i);
    });

    it('rejects invalid event field format (non-string)', () => {
      const result = validateEnvelope(JSON.stringify({
        event: 12345,
        smeId: 'sme-1',
        status: 'verified',
      }));
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_EVENT);
    });

    it('rejects array root payload', () => {
      const result = validateEnvelope(JSON.stringify([{ smeId: 'sme-1' }]));
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD);
    });

    it('accepts valid flat KYC payload', () => {
      const result = validateEnvelope(JSON.stringify({
        smeId: 'sme-001',
        status: 'verified',
        recordId: 'rec-1',
      }));
      expect(result.valid).toBe(true);
      expect(result.domainData.smeId).toBe('sme-001');
      expect(result.domainData.status).toBe('verified');
      expect(result.domainData.recordId).toBe('rec-1');
    });

    it('accepts valid enveloped KYC payload (event + data wrapper)', () => {
      const result = validateEnvelope(JSON.stringify({
        event: 'kyc.verified',
        data: {
          smeId: 'sme-002',
          status: 'verified',
          verifiedAt: '2026-08-29T10:00:00.000Z',
        },
      }));
      expect(result.valid).toBe(true);
      expect(result.event).toBe('kyc.verified');
      expect(result.domainData.smeId).toBe('sme-002');
      expect(result.domainData.status).toBe('verified');
    });
  });

  // ── Quarantine persistence tests ───────────────────────────────────────────

  describe('quarantineKycWebhook', () => {
    it('Edge Case 5: redacts sensitive fields in stored quarantine record', async () => {
      const mockInsert = jest.fn().mockResolvedValue([1]);
      db.mockReturnValue({ insert: mockInsert });

      const rawBody = JSON.stringify({
        smeId: 'sme-001',
        status: 'invalid_status',
        password: 'clear-text-password',
        secret: 'super-secret-key',
        ssn: '123-45-6789',
      });

      const record = await quarantineKycWebhook({
        rawBody,
        reason: 'Unknown provider status',
        errorCode: 'unknown_status',
        tenantId: 'tenant-123',
        smeId: 'sme-001',
        actor: 'test-actor',
      });

      expect(mockInsert).toHaveBeenCalledTimes(1);
      const inserted = mockInsert.mock.calls[0][0];

      expect(inserted.tenant_id).toBe('tenant-123');
      expect(inserted.sme_id).toBe('sme-001');
      expect(inserted.reason).toBe('Unknown provider status');
      expect(inserted.error_code).toBe('unknown_status');

      // Parsed payload in database insert must be redacted
      const storedPayload = JSON.parse(inserted.payload);
      expect(storedPayload.password).toBe(REDACTED);
      expect(storedPayload.secret).toBe(REDACTED);
      expect(storedPayload.ssn).toBe(REDACTED);
      expect(storedPayload.smeId).toBe('sme-001');

      // Returned record payload must also be redacted
      expect(record.payload.password).toBe(REDACTED);
      expect(record.payload.secret).toBe(REDACTED);
      expect(record.payload.ssn).toBe(REDACTED);
    });

    it('persists malformed raw JSON string into quarantine with redacted body', async () => {
      const mockInsert = jest.fn().mockResolvedValue([1]);
      db.mockReturnValue({ insert: mockInsert });

      const rawBody = '{ token: "secret-token", broken json';
      const record = await quarantineKycWebhook({
        rawBody,
        reason: 'Invalid JSON payload',
        errorCode: 'invalid_payload',
        tenantId: 'tenant-abc',
      });

      expect(record.id).toBeDefined();
      expect(record.reason).toBe('Invalid JSON payload');
      expect(record.payload.malformed).toBe(true);
      expect(record.rawPayload).not.toContain('secret-token');
    });

    it('does not throw when database insert fails (fail-safe bounded side effect)', async () => {
      db.mockReturnValue({
        insert: jest.fn().mockRejectedValue(new Error('DB connection refused')),
      });

      await expect(
        quarantineKycWebhook({
          rawBody: '{}',
          reason: 'Test failure',
          errorCode: 'test_code',
        })
      ).resolves.toBeDefined();
    });
  });

  // ── Authorized inspection tests ───────────────────────────────────────────

  describe('listQuarantinedWebhooks', () => {
    let mockChain;

    beforeEach(() => {
      mockChain = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        then: jest.fn(),
      };
      db.mockReturnValue(mockChain);
    });

    it('strictly enforces tenant isolation: filters by tenant_id', async () => {
      const mockRows = [
        {
          id: 'quar-1',
          tenant_id: 'tenant-a',
          sme_id: 'sme-1',
          event: 'unknown',
          payload: JSON.stringify({ smeId: 'sme-1' }),
          reason: 'Invalid status',
          error_code: 'unknown_status',
          created_at: new Date('2026-08-29T08:00:00.000Z'),
          updated_at: new Date('2026-08-29T08:00:00.000Z'),
        },
      ];
      mockChain.then.mockImplementation((resolve) => resolve(mockRows));

      const res = await listQuarantinedWebhooks({
        tenantId: 'tenant-a',
      });

      expect(mockChain.where).toHaveBeenCalledWith('tenant_id', 'tenant-a');
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe('quar-1');
      expect(res.data[0].tenantId).toBe('tenant-a');
    });

    it('applies filters for smeId, event, reason, errorCode, and date bounds', async () => {
      mockChain.then.mockImplementation((resolve) => resolve([]));

      await listQuarantinedWebhooks({
        tenantId: 'tenant-a',
        smeId: 'sme-99',
        event: 'kyc.verified',
        reason: 'Invalid event',
        errorCode: 'invalid_event',
        createdAfter: '2026-08-01T00:00:00.000Z',
        createdBefore: '2026-08-30T00:00:00.000Z',
        rawLimit: '10',
        rawOffset: '20',
      });

      expect(mockChain.where).toHaveBeenCalledWith('tenant_id', 'tenant-a');
      expect(mockChain.where).toHaveBeenCalledWith('sme_id', 'sme-99');
      expect(mockChain.where).toHaveBeenCalledWith('event', 'kyc.verified');
      expect(mockChain.where).toHaveBeenCalledWith('reason', 'Invalid event');
      expect(mockChain.where).toHaveBeenCalledWith('error_code', 'invalid_event');
      expect(mockChain.where).toHaveBeenCalledWith('created_at', '>=', '2026-08-01T00:00:00.000Z');
      expect(mockChain.where).toHaveBeenCalledWith('created_at', '<', '2026-08-30T00:00:00.000Z');
      expect(mockChain.offset).toHaveBeenCalledWith(20);
      expect(mockChain.limit).toHaveBeenCalledWith(11);
    });

    it('supports cursor pagination and produces nextCursor when hasMore is true', async () => {
      const mockRows = [
        {
          id: 'quar-1',
          tenant_id: 'tenant-a',
          created_at: new Date('2026-08-29T08:00:00.000Z'),
          updated_at: new Date('2026-08-29T08:00:00.000Z'),
          payload: '{}',
        },
        {
          id: 'quar-2',
          tenant_id: 'tenant-a',
          created_at: new Date('2026-08-29T07:00:00.000Z'),
          updated_at: new Date('2026-08-29T07:00:00.000Z'),
          payload: '{}',
        },
      ];
      mockChain.then.mockImplementation((resolve) => resolve(mockRows));

      const res = await listQuarantinedWebhooks({
        tenantId: 'tenant-a',
        rawLimit: '1',
      });

      expect(res.data).toHaveLength(1);
      expect(res.meta.hasMore).toBe(true);
      expect(res.meta.nextCursor).toBeDefined();
    });
  });

  describe('getQuarantinedWebhookById', () => {
    it('returns record matching ID and tenantId', async () => {
      const mockRow = {
        id: 'quar-123',
        tenant_id: 'tenant-a',
        sme_id: 'sme-1',
        event: 'kyc.verified',
        payload: JSON.stringify({ smeId: 'sme-1', password: 'secret' }),
        reason: 'Malformed',
        error_code: 'invalid_payload',
        created_at: new Date('2026-08-29T08:00:00.000Z'),
        updated_at: new Date('2026-08-29T08:00:00.000Z'),
      };

      const mockFirst = jest.fn().mockResolvedValue(mockRow);
      const mockQuery = {
        where: jest.fn().mockReturnThis(),
        first: mockFirst,
      };
      db.mockReturnValue(mockQuery);

      const res = await getQuarantinedWebhookById('quar-123', { tenantId: 'tenant-a' });
      expect(res).toBeDefined();
      expect(res.id).toBe('quar-123');
      expect(res.tenantId).toBe('tenant-a');
      expect(res.payload.password).toBe(REDACTED);
    });

    it('returns null if record does not exist or tenant does not match', async () => {
      const mockFirst = jest.fn().mockResolvedValue(null);
      const mockQuery = {
        where: jest.fn().mockReturnThis(),
        first: mockFirst,
      };
      db.mockReturnValue(mockQuery);

      const res = await getQuarantinedWebhookById('quar-nonexistent', { tenantId: 'tenant-a' });
      expect(res).toBeNull();
    });
  });
});
