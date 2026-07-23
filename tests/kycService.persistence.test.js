'use strict';

/**
 * KYC Service Persistence Tests
 * 
 * Verifies that KYC statuses are correctly saved to and retrieved from the database,
 * ensuring they survive service restarts and are idempotent.
 */

const knex = jest.requireActual('knex');
const knexConfig = require('../knexfile').test;
const realDb = knex(knexConfig);

const mockDb = require('../src/db/knex');
const kycService = require('../src/services/kycService');
const migration = require('../src/db/migrations/20260425_add_kyc_status');

describe('KYC Service Database Persistence', () => {
  let originalMockImpl;

  beforeAll(async () => {
    // Save original mock implementation
    originalMockImpl = mockDb.getMockImplementation();

    // Delegate mock Knex calls to the real Knex instance
    mockDb.mockImplementation((table) => realDb(table));
    mockDb.raw = realDb.raw;
    mockDb.schema = realDb.schema;
    mockDb.migrate = realDb.migrate;

    // Run the KYC status table migration on the real DB
    await migration.up(realDb);
  });

  afterAll(async () => {
    // Restore the original mock implementation for other tests
    mockDb.mockImplementation(originalMockImpl);
    
    // Close the real database connection
    await realDb.destroy();
  });

  beforeEach(async () => {
    // Clean database records and reset mock state before each test
    await realDb('kyc_records').del();
    kycService.resetMockRecords();
  });

  it('should return pending status for an unknown SME', async () => {
    const result = await kycService.getKycStatus('unknown_sme');
    expect(result.status).toBe(kycService.KYC_STATUSES.PENDING);
  });

  it('should persist verification status to the database', async () => {
    const smeId = 'sme_persist_01';
    const verifyResult = await kycService.verifySmeSafe(smeId);
    expect(verifyResult.status).toBe(kycService.KYC_STATUSES.VERIFIED);

    // Verify it is in the database
    const dbRecord = await realDb('kyc_records').where({ sme_id: smeId }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    expect(dbRecord.provider_record_id).toBe(verifyResult.recordId);
  });

  it('should survive a restart (clearing mock store does not lose KYC status)', async () => {
    const smeId = 'sme_restart_01';
    
    // 1. Verify SME (marks in DB and mock store)
    await kycService.verifySmeSafe(smeId);
    
    // 2. Clear mock in-memory store to simulate process restart
    kycService.resetMockRecords();
    
    // 3. Status should still be retrieved from DB
    const result = await kycService.getKycStatus(smeId);
    expect(result.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    expect(result.recordId).toBeDefined();
  });

  it('should persist reject status to the database', async () => {
    const smeId = 'sme_reject_01';
    const rejectResult = await kycService.rejectSmeKyc(smeId, 'High-risk business');
    expect(rejectResult.status).toBe(kycService.KYC_STATUSES.REJECTED);

    // Verify it is in the database
    const dbRecord = await realDb('kyc_records').where({ sme_id: smeId }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe(kycService.KYC_STATUSES.REJECTED);

    // Verify subsequent lookup gets rejection
    kycService.resetMockRecords();
    const lookup = await kycService.getKycStatus(smeId);
    expect(lookup.status).toBe(kycService.KYC_STATUSES.REJECTED);
  });

  it('should persist exemption status to the database', async () => {
    const smeId = 'sme_exempt_01';
    const exemptResult = await kycService.exemptSmeFromKyc(smeId, 'Government entity');
    expect(exemptResult.status).toBe(kycService.KYC_STATUSES.EXEMPTED);

    // Verify it is in the database
    const dbRecord = await realDb('kyc_records').where({ sme_id: smeId }).first();
    expect(dbRecord).toBeDefined();
    expect(dbRecord.status).toBe(kycService.KYC_STATUSES.EXEMPTED);

    // Verify subsequent lookup gets exemption
    kycService.resetMockRecords();
    const lookup = await kycService.getKycStatus(smeId);
    expect(lookup.status).toBe(kycService.KYC_STATUSES.EXEMPTED);
  });

  it('should be idempotent (re-verifying a verified SME is safe and updates the record)', async () => {
    const smeId = 'sme_idempotent_01';
    
    // First verification
    const res1 = await kycService.verifySmeSafe(smeId);
    const dbRecord1 = await realDb('kyc_records').where({ sme_id: smeId }).first();
    
    // Second verification
    const res2 = await kycService.verifySmeSafe(smeId);
    const dbRecord2 = await realDb('kyc_records').where({ sme_id: smeId }).first();

    expect(res1.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    expect(res2.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    
    // Verify records got updated/saved without throwing duplicate key errors
    expect(dbRecord2.sme_id).toBe(dbRecord1.sme_id);
    expect(dbRecord2.status).toBe(dbRecord1.status);
  });

  /**
   * Short-TTL cache for external KYC provider status lookups (issue #440).
   *
   * These tests run against the real (delegated) database configured by the
   * surrounding suite. The external provider is exercised via a mocked
   * `global.fetch`; cache behaviour is asserted by counting provider calls.
   */
  describe('short-TTL provider status cache (issue #440)', () => {
    const originalFetch = global.fetch;

    const enableProvider = () => {
      process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
      process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
    };

    /**
     * Builds a fetch mock that resolves with a Response-shaped object carrying
     * the fields {@link kycService.verifyWithExternalProvider} actually reads:
     *   - `text()` — used as the raw body for response-signature verification
     *     and as the source for JSON.parse
     *   - `headers.get(name)` — used to read X-KYC-Signature / X-KYC-Response-Signature
     *   - `ok`, `status` — used to short-circuit non-2xx and to populate KycProviderError
     *
     * The previous version of this helper omitted `text()` and `headers.get()`,
     * which silently broke once issue #592 wired the real upstream call into
     * `verifyWithExternalProvider` (the call now reads the raw body and looks
     * for an `X-KYC-Signature` header).
     */
    const mockProvider = (status) => {
      const body = { status, recordId: `rec_${status}`, verifiedAt: null };
      return jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
        json: () => Promise.resolve(body),
        headers: { get: () => null },
      });
    };

    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.KYC_PROVIDER_URL;
      delete process.env.KYC_PROVIDER_API_KEY;
      delete process.env.KYC_PROVIDER_SECRET;
      delete process.env.KYC_STATUS_CACHE_TTL_SECONDS;
    });

    it('cache miss: the first read calls the external provider', async () => {
      enableProvider();
      global.fetch = mockProvider('verified');

      const res = await kycService.getKycStatus('sme_cache_miss');

      expect(res.status).toBe(kycService.KYC_STATUSES.VERIFIED);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('cache hit within TTL: the second read reuses cache and skips the provider', async () => {
      enableProvider();
      // Capture the first fetch mock by reference so we can assert on it after
      // `global.fetch` is replaced for the second read. Asserting on
      // `global.fetch` directly would silently check the NEW mock (0 calls).
      const firstFetchMock = mockProvider('verified');
      global.fetch = firstFetchMock;
      const smeId = 'sme_cache_hit';

      const first = await kycService.getKycStatus(smeId);
      expect(first.status).toBe(kycService.KYC_STATUSES.VERIFIED);
      expect(firstFetchMock).toHaveBeenCalledTimes(1);

      // The provider would now report a different status, but within the TTL the
      // cached value must win and the provider must not be called again.
      // Route through the helper so the Response shape (text/headers) is always
      // in lockstep with mockProvider — a future cache regression that lets the
      // second call reach the provider must surface as a real assertion failure,
      // not as a silently swallowed PENDING fallback.
      const secondFetchMock = mockProvider('rejected');
      global.fetch = secondFetchMock;

      const second = await kycService.getKycStatus(smeId);

      // The first mock was called exactly once (cache miss); the second mock
      // must not be invoked at all (cache hit on the second read).
      expect(firstFetchMock).toHaveBeenCalledTimes(1);
      expect(secondFetchMock).toHaveBeenCalledTimes(0);
      expect(second.status).toBe(kycService.KYC_STATUSES.VERIFIED);
    });

    it('webhook invalidation: a persisted status change drops the cached approval', async () => {
      enableProvider();
      global.fetch = mockProvider('verified');
      const smeId = 'sme_cache_webhook';

      const first = await kycService.getKycStatus(smeId);
      expect(first.status).toBe(kycService.KYC_STATUSES.VERIFIED);

      // Simulate the KYC webhook persisting a revocation. The webhook route calls
      // persistKycRecord, which invalidates the cache entry.
      await kycService.persistKycRecord({
        smeId,
        status: 'rejected',
        providerRecordId: 'rec_revoked',
      });

      // Provider now reports the revocation too; because the cache was invalidated,
      // it is consulted again rather than serving the stale 'verified' value.
      global.fetch = mockProvider('rejected');
      const second = await kycService.getKycStatus(smeId);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(second.status).toBe(kycService.KYC_STATUSES.REJECTED);
    });

    it('security: a cached approval never survives a revocation event', async () => {
      enableProvider();
      global.fetch = mockProvider('verified');
      const smeId = 'sme_revoke_wins';

      await kycService.getKycStatus(smeId); // caches 'verified'

      // Revocation arrives via webhook/persisted write.
      await kycService.persistKycRecord({
        smeId,
        status: 'rejected',
        providerRecordId: 'rec_revoked',
      });

      // Even if the provider is now unreachable, the read must NOT serve the
      // cached approval — it falls back to the persisted revoked record.
      global.fetch = jest.fn().mockRejectedValue(new Error('provider down'));
      const after = await kycService.getKycStatus(smeId);

      expect(after.status).toBe(kycService.KYC_STATUSES.REJECTED);
    });

    it('TTL expiry: the provider is consulted again after the entry expires', async () => {
      enableProvider();
      process.env.KYC_STATUS_CACHE_TTL_SECONDS = '0.05'; // 50ms
      global.fetch = mockProvider('verified');
      const smeId = 'sme_ttl_expiry';

      await kycService.getKycStatus(smeId);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 120));

      await kycService.getKycStatus(smeId);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('caching disabled (TTL=0): the provider is consulted on every read', async () => {
      enableProvider();
      process.env.KYC_STATUS_CACHE_TTL_SECONDS = '0';
      global.fetch = mockProvider('verified');
      const smeId = 'sme_no_cache';

      await kycService.getKycStatus(smeId);
      await kycService.getKycStatus(smeId);

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('getStatusCacheTtlMs honours configuration and rejects invalid values', () => {
      delete process.env.KYC_STATUS_CACHE_TTL_SECONDS;
      expect(kycService.getStatusCacheTtlMs()).toBe(30000);

      process.env.KYC_STATUS_CACHE_TTL_SECONDS = '5';
      expect(kycService.getStatusCacheTtlMs()).toBe(5000);

      process.env.KYC_STATUS_CACHE_TTL_SECONDS = '0';
      expect(kycService.getStatusCacheTtlMs()).toBe(0);

      process.env.KYC_STATUS_CACHE_TTL_SECONDS = 'not-a-number';
      expect(kycService.getStatusCacheTtlMs()).toBe(0);
    });

    it('invalidateKycStatusCache ignores invalid smeId values without throwing', () => {
      expect(() => kycService.invalidateKycStatusCache('')).not.toThrow();
      expect(() => kycService.invalidateKycStatusCache(null)).not.toThrow();
      expect(() => kycService.invalidateKycStatusCache(123)).not.toThrow();
    });
  });
});
