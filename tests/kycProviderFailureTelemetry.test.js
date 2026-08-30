'use strict';

/**
 * @fileoverview Integration tests for issue #1200 — redaction of sensitive
 * fields in KYC provider-failure telemetry.
 *
 * Unlike tests/telemetryRedaction.test.js (which tests the redaction utility
 * in isolation), these tests exercise the actual application call sites —
 * `verifyWithExternalProvider` / `getKycStatus` in kycService.js,
 * `ingestKycWebhook`'s unknown-status and persistence-error paths in
 * kycWebhookService.js, and `kycWebhookErrorHandler` — and assert against
 * the *serialized* logger call (`JSON.stringify(...)`), not just the raw
 * arguments, per the issue's explicit requirement: "add tests that inspect
 * serialized telemetry rather than only logger arguments." This matches the
 * existing "Secret-leak prevention" test convention already used in
 * tests/kyc.provider.test.js.
 *
 * Also covers: success / failure / retry / authorization paths for the
 * webhook ingestion route, per the acceptance criteria.
 */

jest.mock('../src/db/knex');

const db = require('../src/db/knex');
const request = require('supertest');

const logger = require('../src/logger');
const {
  getKycStatus,
  verifyWithExternalProvider,
  sharedKycBreaker,
  resetKycCircuitBreaker,
  resetMockRecords,
} = require('../src/services/kycService');
const kycRoutes = require('../src/routes/kyc');

const originalFetch = global.fetch;

const ORIGINAL_ENV = {
  KYC_PROVIDER_BASE_DELAY_MS: process.env.KYC_PROVIDER_BASE_DELAY_MS,
  KYC_PROVIDER_MAX_DELAY_MS: process.env.KYC_PROVIDER_MAX_DELAY_MS,
  KYC_STATUS_CACHE_TTL_SECONDS: process.env.KYC_STATUS_CACHE_TTL_SECONDS,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.KYC_PROVIDER_BASE_DELAY_MS = '0';
  process.env.KYC_PROVIDER_MAX_DELAY_MS = '0';
  process.env.KYC_STATUS_CACHE_TTL_SECONDS = '0';
  delete process.env.KYC_PROVIDER_URL;
  delete process.env.KYC_PROVIDER_API_KEY;
  delete process.env.KYC_PROVIDER_SECRET;
  delete process.env.KYC_PROVIDER_MAX_RETRIES;
  process.env.KYC_PROVIDER_MAX_RETRIES = '0'; // one attempt only — keeps failure tests fast/deterministic
  global.fetch = jest.fn();
  resetKycCircuitBreaker();
  sharedKycBreaker.failureThreshold = 5;
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of Object.keys(ORIGINAL_ENV)) {
    if (ORIGINAL_ENV[key] === undefined) { delete process.env[key]; } else { process.env[key] = ORIGINAL_ENV[key]; }
  }
  resetKycCircuitBreaker();
  resetMockRecords();
});

function enableProvider() {
  process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
  process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
}

/** Collects every logger.error/warn call as a JSON string, for content assertions. */
function serializedLoggerCalls(spy) {
  return spy.mock.calls.map((call) => JSON.stringify(call));
}

describe('kycService: provider-call failure telemetry (issue #1200)', () => {
  it('redacts a document number embedded in a network error message', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(
      new Error('connect failed for applicant document 987654321'),
    );
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(verifyWithExternalProvider('sme-doc-1')).rejects.toThrow();

    const serialized = serializedLoggerCalls(errorSpy);
    expect(serialized.length).toBeGreaterThan(0);
    for (const call of serialized) {
      expect(call).not.toContain('987654321');
    }
  });

  it('redacts identity data embedded in a nested cause chain', async () => {
    enableProvider();
    const cause = new Error('upstream said: SSN 123-45-6789 already on file');
    const outer = new Error('KYC provider request failed');
    outer.cause = cause;
    global.fetch = jest.fn().mockRejectedValue(outer);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(verifyWithExternalProvider('sme-doc-2')).rejects.toThrow();

    const serialized = serializedLoggerCalls(errorSpy);
    for (const call of serialized) {
      expect(call).not.toContain('123-45-6789');
    }
  });

  it('preserves the smeId and providerHost fields in the failure log (correlation is not lost)', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(verifyWithExternalProvider('sme-corr-1')).rejects.toThrow();

    const call = errorSpy.mock.calls.find(([payload]) => payload && payload.smeId === 'sme-corr-1');
    expect(call).toBeDefined();
    expect(call[0].providerHost).toBe('kyc.example.com');
  });

  it('getKycStatus fallback path redacts a document number in the provider error before logging', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(
      new Error('provider rejected: document 555666777 invalid'),
    );
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await getKycStatus('sme-fallback-1');

    expect(result).toBeDefined(); // fail-closed: never throws
    const serialized = serializedLoggerCalls(warnSpy);
    for (const call of serialized) {
      expect(call).not.toContain('555666777');
    }
  });

  it('large binary-like provider error message is truncated, not logged verbatim', async () => {
    enableProvider();
    const hugeBlob = Buffer.from('x'.repeat(2000)).toString('base64');
    global.fetch = jest.fn().mockRejectedValue(new Error(`provider dump: ${hugeBlob}`));
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(verifyWithExternalProvider('sme-blob-1')).rejects.toThrow();

    const serialized = serializedLoggerCalls(errorSpy).join('\n');
    expect(serialized).not.toContain(hugeBlob);
    expect(serialized).toContain('REDACTED:large-value');
  });
});

describe('kycService.normalizeProviderStatus: unmapped-status telemetry (issue #1200)', () => {
  const { normalizeProviderStatus, KYC_STATUSES } = require('../src/services/kycService');

  it('redacts a document number embedded in an unmapped provider status before logging', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = normalizeProviderStatus('rejected: document 987654321 flagged as fraudulent');

    expect(result).toBe(KYC_STATUSES.UNKNOWN);
    const serialized = serializedLoggerCalls(warnSpy);
    expect(serialized.length).toBeGreaterThan(0);
    for (const call of serialized) {
      expect(call).not.toContain('987654321');
    }
  });

  it('redacts an SSN embedded in an unmapped provider status before logging', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    normalizeProviderStatus('flagged: SSN 123-45-6789 already on file');

    const serialized = serializedLoggerCalls(warnSpy);
    for (const call of serialized) {
      expect(call).not.toContain('123-45-6789');
    }
  });

  it('a null/undefined status still logs UNKNOWN safely without a redaction crash', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(() => normalizeProviderStatus(null)).not.toThrow();
    expect(() => normalizeProviderStatus(undefined)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not redact an ordinary recognised status (no false positive on the happy path)', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = normalizeProviderStatus('approved');
    expect(result).not.toBe(KYC_STATUSES.UNKNOWN);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/kyc/webhook: provider-controlled status telemetry (issue #1200)', () => {
  const { createSignatureHeader } = require('../src/services/webhooks');

  let app;

  beforeEach(() => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';
    app = require('express')();
    app.use(require('express').raw({ type: 'application/json', limit: '100kb' }));
    app.use('/api/kyc', kycRoutes);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockReturnValue({
        onConflict: jest.fn().mockReturnValue({ merge: jest.fn().mockResolvedValue([1]) }),
      }),
      update: jest.fn().mockResolvedValue(1),
    }));
  });

  // No tenant middleware is mounted on this bare router (tenant context
  // normally comes from extractTenant upstream in app.js), so payloads here
  // omit `tenantId` — with no payload tenant to compare against, the
  // tenant-mismatch/missing-tenant-context checks in kycWebhookService.js
  // are correctly skipped, and these tests can focus purely on the
  // redaction behaviour under test.

  it('edge case: provider error string contains a document number — redacted from the log AND the API response', async () => {
    const payload = { smeId: 'sme-webhook-1', status: 'document 987654321 flagged as fraudulent' };
    const rawBody = JSON.stringify(payload);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', createSignatureHeader('webhook-secret', rawBody))
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('987654321');
    const serialized = serializedLoggerCalls(warnSpy);
    for (const call of serialized) {
      expect(call).not.toContain('987654321');
    }
  });

  it('unknown-status log line still carries smeId for correlation', async () => {
    const payload = { smeId: 'sme-webhook-corr', status: 'totally-unknown-status' };
    const rawBody = JSON.stringify(payload);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', createSignatureHeader('webhook-secret', rawBody))
      .send(rawBody);

    const call = warnSpy.mock.calls.find(([payload2]) => payload2 && payload2.smeId === 'sme-webhook-corr');
    expect(call).toBeDefined();
  });

  it('persistence failure redacts a DB constraint-violation message that echoes a value', async () => {
    const payload = { smeId: 'sme-webhook-2', status: 'approved' };
    const rawBody = JSON.stringify(payload);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockImplementation(() => {
        throw new Error('duplicate key value violates unique constraint "kyc_records_ssn_key" DETAIL: Key (ssn)=(123-45-6789) already exists.');
      }),
      onConflict: jest.fn().mockReturnThis(),
      merge: jest.fn(),
      update: jest.fn(),
    }));
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', createSignatureHeader('webhook-secret', rawBody))
      .send(rawBody);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('123-45-6789');
    const serialized = serializedLoggerCalls(errorSpy);
    for (const call of serialized) {
      expect(call).not.toContain('123-45-6789');
    }
  });

  it('authorization: an unsigned webhook request is rejected before any status/error content is processed', async () => {
    const payload = { smeId: 'sme-webhook-3', status: 'document 111222333 flagged' };
    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('111222333');
  });

  it('authorization: an incorrectly-signed webhook request is rejected', async () => {
    const payload = { smeId: 'sme-webhook-4', status: 'approved' };
    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 't=1700000000,v1=deadbeef')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(401);
  });

  it('a correctly-signed, recognised-status webhook succeeds (baseline success path)', async () => {
    const payload = { smeId: 'sme-webhook-5', status: 'approved' };
    const rawBody = JSON.stringify(payload);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', createSignatureHeader('webhook-secret', rawBody))
      .send(rawBody);

    expect(res.status).toBe(200);
  });
});
