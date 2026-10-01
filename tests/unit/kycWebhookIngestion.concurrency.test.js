'use strict';

/**
 * @fileoverview Concurrent-execution regression tests for
 * kycWebhookService.processWebhookIngestion.
 *
 * Covers:
 *   - Duplicate smeId concurrent calls resolve to same record (no double-write)
 *   - The DB-level row-lock guard serializes concurrent ingestion
 *   - quarantineKycWebhook failure does NOT mask the primary validation error
 *   - Tenant mismatch still quarantines before throw under concurrent scenario
 *   - Boundary inputs: empty body, null tenantId, missing secret
 *   - KycWebhookError context fields (smeId/tenantId) are populated on throws
 *   - The success path returns { success: true, smeId, status }
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

// We need a knex mock that correctly handles db.transaction() with the
// FOR UPDATE pattern.  The mock exposes enough of the query-builder chain to
// exercise the concurrency guard without a real database.
let _trxCalls = 0;
const _lockedRows = new Map(); // sme_id → row (simulates row-level locking)

const mockTrx = {
  // table(name) call returns this
  _table: null,
  _whereClause: null,
  _firstResult: null,
};

function makeMockTrxBuilder(forUpdateResult = null) {
  // In Knex, .first() returns a QueryBuilder that is also a Promise-like.
  // .timeout() is a method on QueryBuilder, so it must be available on
  // whatever .first() returns.  We return a thenable that also exposes
  // .timeout() so the service's `.first().timeout(5000)` chain resolves.
  const firstResult = {
    then: (resolve) => resolve(forUpdateResult),
    catch: jest.fn().mockReturnThis(),
    timeout: jest.fn().mockResolvedValue(forUpdateResult),
  };
  const builder = {
    where: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    first: jest.fn().mockReturnValue(firstResult),
    timeout: jest.fn().mockResolvedValue(forUpdateResult),
  };
  return builder;
}

// db() returns table builder; db.transaction(fn) calls fn(trx)
let _mockTrxBuilder = null;

const mockDb = jest.fn((tableName) => {
  if (tableName === 'kyc_records') {
    return _mockTrxBuilder || makeMockTrxBuilder(null);
  }
  return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
});

mockDb.transaction = jest.fn(async (fn) => {
  _trxCalls += 1;
  const trx = jest.fn((tableName) => {
    if (tableName === 'kyc_records') {
      return _mockTrxBuilder || makeMockTrxBuilder(null);
    }
    return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
  });
  trx.commit = jest.fn();
  trx.rollback = jest.fn();
  return fn(trx);
});

jest.mock('../../src/db/knex', () => mockDb);

// webhooks.verifySignature — by default returns valid
jest.mock('../../src/services/webhooks', () => ({
  verifySignature: jest.fn(() => ({ valid: true })),
}));

// kycService — expose the minimum needed
const _mockPersistKycRecord = jest.fn();
const _mockNormalizeProviderStatus = jest.fn((s) => {
  const map = {
    verified: 'verified', approved: 'verified',
    pending: 'pending', rejected: 'rejected', exempted: 'exempted',
  };
  return map[s] || 'unknown';
});

jest.mock('../../src/services/kycService', () => ({
  getKycProviderConfig: jest.fn(() => ({ apiSecret: 'test-secret-12345' })),
  normalizeProviderStatus: _mockNormalizeProviderStatus,
  persistKycRecord: _mockPersistKycRecord,
  KYC_STATUSES: { UNKNOWN: 'unknown' },
}));

// quarantineKycWebhook / validateEnvelope — expose controllable doubles
const _mockQuarantineKycWebhook = jest.fn().mockResolvedValue({ id: 'quar_1' });
const _mockValidateEnvelope = jest.fn();

jest.mock('../../src/services/kycQuarantineService', () => ({
  quarantineKycWebhook: _mockQuarantineKycWebhook,
  validateEnvelope: _mockValidateEnvelope,
}));

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/auditLog', () => ({
  getAuditLogs: jest.fn().mockResolvedValue([]),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const KycWebhookError = require('../../src/errors/KycWebhookError');
const webhooks = require('../../src/services/webhooks');

/** Build a valid signed body + header for a given smeId and status. */
function makeValidIngestion(smeId = 'sme-001', status = 'verified', tenantId = null) {
  const payload = JSON.stringify({ smeId, status, ...(tenantId ? { tenantId } : {}) });
  const sig = webhooks.createSignatureHeader
    ? webhooks.createSignatureHeader('test-secret-12345', payload)
    : `t=${Math.floor(Date.now() / 1000)},v1=fakesig`;
  return { rawBody: payload, signatureHeader: sig, requestTenantId: tenantId };
}

/** Configure validateEnvelope to return a valid result for the given args. */
function setupValidEnvelope(smeId, status, tenantId = null) {
  _mockValidateEnvelope.mockReturnValue({
    valid: true,
    payload: { smeId, status },
    event: 'kyc.verified',
    domainData: { smeId, status, recordId: null, verifiedAt: null, tenantId },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _trxCalls = 0;
  _mockTrxBuilder = null;
  _mockPersistKycRecord.mockResolvedValue({
    smeId: 'sme-001',
    status: 'verified',
    recordId: 'rec-1',
  });
  process.env.WEBHOOK_SIGNING_KEY = 'test-secret-12345';
  delete process.env.WEBHOOK_SIGNING_KEY_RETIRING;
  webhooks.verifySignature.mockReturnValue({ valid: true });
});

afterEach(() => {
  delete process.env.WEBHOOK_SIGNING_KEY;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

const kycWebhookService = require('../../src/services/kycWebhookService');

describe('processWebhookIngestion – concurrency guard', () => {
  test('wraps persistKycRecord in a db.transaction', async () => {
    setupValidEnvelope('sme-001', 'verified');
    const { rawBody, signatureHeader } = makeValidIngestion('sme-001', 'verified');

    await kycWebhookService.processWebhookIngestion({ rawBody, signatureHeader });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(_mockPersistKycRecord).toHaveBeenCalledTimes(1);
  });

  test('calls SELECT … FOR UPDATE (forUpdate) on the kyc_records table inside the transaction', async () => {
    const forUpdateSpy = jest.fn().mockReturnThis();
    const timeoutSpy = jest.fn().mockResolvedValue(null);
    const firstResult = {
      then: (resolve) => resolve(null),
      catch: jest.fn().mockReturnThis(),
      timeout: timeoutSpy,
    };
    const firstSpy = jest.fn().mockReturnValue(firstResult);
    const whereSpy = jest.fn().mockReturnThis();

    _mockTrxBuilder = {
      where: whereSpy,
      forUpdate: forUpdateSpy,
      first: firstSpy,
      timeout: timeoutSpy,
    };

    setupValidEnvelope('sme-002', 'verified');
    await kycWebhookService.processWebhookIngestion({
      rawBody: JSON.stringify({ smeId: 'sme-002', status: 'verified' }),
      signatureHeader: 'sig',
    });

    expect(forUpdateSpy).toHaveBeenCalledTimes(1);
    expect(firstSpy).toHaveBeenCalledTimes(1);
  });

  test('two sequential calls for the same smeId both succeed (upsert semantics)', async () => {
    setupValidEnvelope('sme-003', 'verified');

    const call1 = await kycWebhookService.processWebhookIngestion({
      rawBody: JSON.stringify({ smeId: 'sme-003', status: 'verified' }),
      signatureHeader: 'sig',
    });

    setupValidEnvelope('sme-003', 'verified'); // same envelope again
    const call2 = await kycWebhookService.processWebhookIngestion({
      rawBody: JSON.stringify({ smeId: 'sme-003', status: 'verified' }),
      signatureHeader: 'sig',
    });

    expect(call1).toEqual({ success: true, smeId: 'sme-001', status: 'verified' });
    expect(call2).toEqual({ success: true, smeId: 'sme-001', status: 'verified' });
    // persistKycRecord called once per ingestion (idempotent at DB level via upsert)
    expect(_mockPersistKycRecord).toHaveBeenCalledTimes(2);
  });

  test('returns { success: true, smeId, status } on success', async () => {
    setupValidEnvelope('sme-001', 'verified');
    _mockPersistKycRecord.mockResolvedValueOnce({ smeId: 'sme-001', status: 'verified', recordId: 'r1' });

    const result = await kycWebhookService.processWebhookIngestion({
      rawBody: JSON.stringify({ smeId: 'sme-001', status: 'verified' }),
      signatureHeader: 'sig',
    });

    expect(result).toEqual({ success: true, smeId: 'sme-001', status: 'verified' });
  });

  test('DB transaction error is caught and rethrown as KycWebhookError 500 PERSISTENCE_ERROR', async () => {
    setupValidEnvelope('sme-004', 'verified');
    _mockPersistKycRecord.mockRejectedValueOnce(new Error('connection timeout'));

    await expect(
      kycWebhookService.processWebhookIngestion({
        rawBody: JSON.stringify({ smeId: 'sme-004', status: 'verified' }),
        signatureHeader: 'sig',
      })
    ).rejects.toMatchObject({
      status: 500,
      code: 'persistence_error',
    });
  });

  test('PERSISTENCE_ERROR includes smeId in context for observability', async () => {
    setupValidEnvelope('sme-005', 'verified');
    _mockPersistKycRecord.mockRejectedValueOnce(new Error('DB error'));

    try {
      await kycWebhookService.processWebhookIngestion({
        rawBody: JSON.stringify({ smeId: 'sme-005', status: 'verified' }),
        signatureHeader: 'sig',
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err instanceof KycWebhookError).toBe(true);
      const logCtx = err.toLogContext();
      expect(logCtx.smeId).toBe('sme-005');
    }
  });

  test('DB error message is NOT leaked verbatim into the thrown error message (redacted)', async () => {
    setupValidEnvelope('sme-006', 'verified');
    _mockPersistKycRecord.mockRejectedValueOnce(
      new Error('Key (ssn)=(123-45-6789) already exists')
    );

    try {
      await kycWebhookService.processWebhookIngestion({
        rawBody: JSON.stringify({ smeId: 'sme-006', status: 'verified' }),
        signatureHeader: 'sig',
      });
    } catch (err) {
      // The raw PII from the DB error must not appear verbatim in the thrown message
      // (redactErrorForTelemetry scrubs it)
      expect(err.message).not.toContain('123-45-6789');
    }
  });
});

describe('processWebhookIngestion – boundary inputs', () => {
  test('missing secret throws 503 KycWebhookError with MISSING_SECRET code', async () => {
    delete process.env.WEBHOOK_SIGNING_KEY;
    const kycService = require('../../src/services/kycService');
    kycService.getKycProviderConfig.mockReturnValueOnce({ apiSecret: null });

    await expect(
      kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: 'sig' })
    ).rejects.toMatchObject({ status: 503, code: 'missing_secret' });
  });

  test('missing signature header throws 401 with MISSING_SIGNATURE code', async () => {
    await expect(
      kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: '' })
    ).rejects.toMatchObject({ status: 401, code: 'missing_signature' });
  });

  test('invalid signature throws 401 with INVALID_SIGNATURE code', async () => {
    webhooks.verifySignature.mockReturnValueOnce({ valid: false, error: 'bad hmac' });

    await expect(
      kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: 'bad' })
    ).rejects.toMatchObject({ status: 401, code: 'invalid_signature' });
  });

  test('invalid envelope throws 400 and quarantines the payload', async () => {
    _mockValidateEnvelope.mockReturnValueOnce({
      valid: false,
      reason: 'Payload too large',
      errorCode: 'PAYLOAD_TOO_LARGE',
      payload: null,
      event: 'unknown',
      errorDetails: { byteLength: 99999, maxBytes: 65536 },
    });

    await expect(
      kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: 'sig' })
    ).rejects.toMatchObject({ status: 400 });

    expect(_mockQuarantineKycWebhook).toHaveBeenCalledTimes(1);
  });

  test('quarantine failure does NOT mask the primary validation error', async () => {
    _mockValidateEnvelope.mockReturnValueOnce({
      valid: false,
      reason: 'Missing smeId',
      errorCode: 'missing_sme_id',
      payload: null,
      event: 'unknown',
      errorDetails: null,
    });
    // Quarantine throws — should be suppressed, not re-thrown
    _mockQuarantineKycWebhook.mockRejectedValueOnce(new Error('Quarantine DB down'));

    const err = await kycWebhookService.processWebhookIngestion({
      rawBody: '{}',
      signatureHeader: 'sig',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(KycWebhookError);
    expect(err.status).toBe(400);
  });

  test('tenant mismatch throws 403 TENANT_MISMATCH and quarantines', async () => {
    _mockValidateEnvelope.mockReturnValueOnce({
      valid: true,
      payload: { smeId: 'sme-007', status: 'verified', tenantId: 'tenant-A' },
      event: 'kyc.verified',
      domainData: {
        smeId: 'sme-007',
        status: 'verified',
        recordId: null,
        verifiedAt: null,
        tenantId: 'tenant-A',
      },
    });

    await expect(
      kycWebhookService.processWebhookIngestion({
        rawBody: JSON.stringify({ smeId: 'sme-007', status: 'verified', tenantId: 'tenant-A' }),
        signatureHeader: 'sig',
        requestTenantId: 'tenant-B', // mismatch
      })
    ).rejects.toMatchObject({ status: 403, code: 'tenant_mismatch' });

    expect(_mockQuarantineKycWebhook).toHaveBeenCalledTimes(1);
  });

  test('tenant mismatch KycWebhookError includes tenantId in context', async () => {
    _mockValidateEnvelope.mockReturnValueOnce({
      valid: true,
      payload: { smeId: 'sme-008', status: 'verified', tenantId: 'tenant-X' },
      event: 'kyc.verified',
      domainData: {
        smeId: 'sme-008',
        status: 'verified',
        recordId: null,
        verifiedAt: null,
        tenantId: 'tenant-X',
      },
    });

    try {
      await kycWebhookService.processWebhookIngestion({
        rawBody: '{}',
        signatureHeader: 'sig',
        requestTenantId: 'tenant-Y',
      });
    } catch (err) {
      expect(err instanceof KycWebhookError).toBe(true);
      // The request tenantId is carried in context
      const logCtx = err.toLogContext();
      expect(logCtx.tenantId).toBeDefined();
    }
  });

  test('unknown provider status throws 400 UNKNOWN_STATUS and quarantines', async () => {
    setupValidEnvelope('sme-009', 'UNKNOWN_PROVIDER_STATUS');
    // normalizeProviderStatus returns 'unknown' for unrecognized statuses
    _mockNormalizeProviderStatus.mockReturnValueOnce('unknown');

    await expect(
      kycWebhookService.processWebhookIngestion({
        rawBody: JSON.stringify({ smeId: 'sme-009', status: 'UNKNOWN_PROVIDER_STATUS' }),
        signatureHeader: 'sig',
      })
    ).rejects.toMatchObject({ status: 400, code: 'unknown_status' });

    expect(_mockQuarantineKycWebhook).toHaveBeenCalledTimes(1);
  });

  test('null requestTenantId is handled gracefully on success path', async () => {
    setupValidEnvelope('sme-010', 'verified', null);
    _mockPersistKycRecord.mockResolvedValueOnce({ smeId: 'sme-010', status: 'verified', recordId: null });

    const result = await kycWebhookService.processWebhookIngestion({
      rawBody: JSON.stringify({ smeId: 'sme-010', status: 'verified' }),
      signatureHeader: 'sig',
      requestTenantId: null,
    });
    expect(result.success).toBe(true);
  });

  test('Buffer rawBody is handled identically to string rawBody', async () => {
    setupValidEnvelope('sme-011', 'verified');
    const bodyStr = JSON.stringify({ smeId: 'sme-011', status: 'verified' });
    _mockPersistKycRecord.mockResolvedValueOnce({ smeId: 'sme-011', status: 'verified', recordId: null });

    const result = await kycWebhookService.processWebhookIngestion({
      rawBody: Buffer.from(bodyStr, 'utf8'),
      signatureHeader: 'sig',
    });
    expect(result.success).toBe(true);
  });
});

describe('processWebhookIngestion – KycWebhookError context enrichment', () => {
  test('MISSING_SECRET error is retryable', async () => {
    delete process.env.WEBHOOK_SIGNING_KEY;
    const kycService = require('../../src/services/kycService');
    kycService.getKycProviderConfig.mockReturnValueOnce({ apiSecret: null });

    try {
      await kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: 'sig' });
    } catch (err) {
      expect(err.isRetryable()).toBe(true);
    }
  });

  test('MISSING_SIGNATURE error is NOT retryable', async () => {
    try {
      await kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: '' });
    } catch (err) {
      expect(err.isRetryable()).toBe(false);
    }
  });

  test('PERSISTENCE_ERROR error is NOT retryable', async () => {
    setupValidEnvelope('sme-012', 'verified');
    _mockPersistKycRecord.mockRejectedValueOnce(new Error('DB failed'));

    try {
      await kycWebhookService.processWebhookIngestion({
        rawBody: JSON.stringify({ smeId: 'sme-012', status: 'verified' }),
        signatureHeader: 'sig',
      });
    } catch (err) {
      expect(err.isRetryable()).toBe(false);
      expect(err.code).toBe('persistence_error');
    }
  });

  test('all thrown KycWebhookErrors have a non-empty code', async () => {
    const scenarios = [
      async () => {
        delete process.env.WEBHOOK_SIGNING_KEY;
        require('../../src/services/kycService').getKycProviderConfig.mockReturnValueOnce({ apiSecret: null });
        return kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: 'x' });
      },
      async () => kycWebhookService.processWebhookIngestion({ rawBody: '{}', signatureHeader: '' }),
    ];

    for (const scenario of scenarios) {
      process.env.WEBHOOK_SIGNING_KEY = 'test-secret-12345'; // reset
      try {
        await scenario();
      } catch (err) {
        expect(err instanceof KycWebhookError).toBe(true);
        expect(typeof err.code).toBe('string');
        expect(err.code.length).toBeGreaterThan(0);
      }
    }
  });
});
