'use strict';

/**
 * Tests for KYC provider integration and persistence.
 *
 * Covers (issue #592):
 *  1. Provider success — correct URL, bearer auth, content-type; status persisted and returned
 *  2. Provider failure — falls back to persisted record (fail-closed); never auto-verifies
 *  3. Persistence read-back — getKycStatus returns DB record when provider is off
 *  4. Funding denied when status is pending / rejected / unknown
 *  5. verifyWithExternalProvider — typed KycProviderError contract on non-ok
 *  6. Bounded timeout — AbortController fires when provider exceeds KYC_PROVIDER_TIMEOUT_MS
 *  7. Retry — transient 5xx / network codes retried; permanent 4xx fail-fast
 *  8. Circuit breaker — sustained 5xx trips OPEN; subsequent call fails fast with CIRCUIT_OPEN
 *  9. Outbound HMAC signing — opt-in X-KYC-Signature header matches createSignatureHeader
 * 10. Response integrity verification — defensive verify of X-KYC-Signature; strict mode requires header
 * 11. classifyKycError — 5xx/network retryable, 4xx non-retryable
 * 12. Secret-leak prevention — API key + signing secret never logged or returned
 * 13. parseClampedInt — fallback when invalid; clamp to min/max
 * 14. Mock path preserved — when provider env vars unset, no fetch is invoked
 * 15. Defensive normalizeProviderStatus — non-string / null / empty → UNKNOWN
 * 16. resetKycCircuitBreaker — wired helper actually resets the breaker
 * 17. Mock record fallback — legacy in-memory record is returned when DB row is gone
 * 18. KYC webhook route — signature verification, fail-closed on unknown status
 */

jest.mock('../src/db/knex');

const db = require('../src/db/knex');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  KYC_STATUSES,
  getKycStatus,
  canFundWithKycStatus,
  verifyWithExternalProvider,
  persistKycRecord,
  readKycRecord,
  verifySmeSafe,
  rejectSmeKyc,
  exemptSmeFromKyc,
  KycProviderError,
  KycUpstreamUnavailableError,
  classifyKycError,
  getKycProviderConfig,
  normalizeProviderStatus,
  resetKycCircuitBreaker,
  resetMockRecords,
  sharedKycBreaker,
  parseClampedInt,
} = require('../src/services/kycService');
const { createSignatureHeader, verifySignature } = require('../src/services/webhooks');
const kycRoutes = require('../src/routes/kyc');

const originalFetch = global.fetch;

// Snapshot environment state so this suite doesn't leak CLIs to other test
// files that rely on the production defaults (e.g. kycService.persistence.test.js).
const ORIGINAL_ENV = {
  KYC_PROVIDER_BASE_DELAY_MS: process.env.KYC_PROVIDER_BASE_DELAY_MS,
  KYC_PROVIDER_MAX_DELAY_MS: process.env.KYC_PROVIDER_MAX_DELAY_MS,
  KYC_STATUS_CACHE_TTL_SECONDS: process.env.KYC_STATUS_CACHE_TTL_SECONDS,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Disable retry back-off so test suites stay fast.
  process.env.KYC_PROVIDER_BASE_DELAY_MS = '0';
  process.env.KYC_PROVIDER_MAX_DELAY_MS = '0';
  // Disable status lookup cache so every test exercises a fresh provider call.
  process.env.KYC_STATUS_CACHE_TTL_SECONDS = '0';
  delete process.env.KYC_PROVIDER_URL;
  delete process.env.KYC_PROVIDER_API_KEY;
  delete process.env.KYC_PROVIDER_SECRET;
  delete process.env.KYC_PROVIDER_SIGN_REQUESTS;
  delete process.env.KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE;
  delete process.env.KYC_PROVIDER_TIMEOUT_MS;
  delete process.env.KYC_PROVIDER_MAX_RETRIES;
  // Replace global.fetch with a fresh jest.fn so `expect(global.fetch).not.toHaveBeenCalled()` works.
  global.fetch = jest.fn();
  // Reset circuit breaker to a clean state with the default 5-failure threshold.
  sharedKycBreaker.failureThreshold = 5;
  sharedKycBreaker.reset();
});

afterEach(() => {
  global.fetch = originalFetch;
  // Restore the original env so CLIs don't leak between test files.
  for (const key of Object.keys(ORIGINAL_ENV)) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
  // Reset module-level state so this suite doesn't pollute later files.
  sharedKycBreaker.reset();
  resetMockRecords();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function enableProvider() {
  process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
  process.env.KYC_PROVIDER_API_KEY = 'test-api-key';
}

/**
 * Builds a fetch mock that resolves with a Response-shaped object carrying the
 * fields {@link kycService.verifyWithExternalProvider} actually reads: `text()`
 * (raw body for both signature verification and JSON parse), `headers.get(name)`
 * (X-KYC-Signature / X-KYC-Response-Signature), and `ok` / `status`.
 */
function mockFetchOk(body, extraHeaders = {}) {
  const headers = new Map(Object.entries(extraHeaders));
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: {
      get: (name) => headers.get(name.toLowerCase()) || null,
    },
  });
}

function mockFetchFail(status = 503) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(''),
    headers: { get: () => null },
  });
}

function emptyDb() {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue([1]),
    update: jest.fn().mockResolvedValue(1),
  };
}

// ── 1. Provider success ───────────────────────────────────────────────────────

describe('provider success', () => {
  beforeEach(() => {
    enableProvider();
    mockFetchOk({
      status: 'verified',
      recordId: 'rec_abc123',
      verifiedAt: '2026-05-27T10:00:00.000Z',
    });
    db.mockImplementation(() => emptyDb());
  });

  it('calls the provider with the correct URL and bearer auth header', async () => {
    await getKycStatus('sme-001');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://kyc.example.com/verify');
    expect(opts.headers.Authorization).toBe('Bearer test-api-key');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('returns the provider status', async () => {
    const result = await getKycStatus('sme-001b');
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('rec_abc123');
  });

  it('does not leak the API key or signing secret in the returned object', async () => {
    process.env.KYC_PROVIDER_SECRET = 'super-secret';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ status: 'verified', recordId: 'r1' })),
      headers: { get: () => null },
    });

    const result = await getKycStatus('sme-leak-1');
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('test-api-key');
    expect(serialised).not.toContain('super-secret');
  });

  it('persists the result to the database', async () => {
    await getKycStatus('sme-001c');
    expect(db).toHaveBeenCalledWith('kyc_records');
  });
});

// ── 2. Provider failure — fail-closed ────────────────────────────────────────

describe('provider failure fallback', () => {
  it('returns persisted record when provider returns 5xx', async () => {
    enableProvider();
    mockFetchFail(503);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'verified',
        provider_record_id: 'rec_old',
        verified_at: '2026-01-01T00:00:00.000Z',
      }),
      insert: jest.fn(),
      update: jest.fn(),
    }));

    const result = await getKycStatus('sme-002');
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('rec_old');
  });

  it('returns pending when provider fails and no DB record exists', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const result = await getKycStatus('sme-003');
    expect(result.status).toBe(KYC_STATUSES.PENDING);
  });

  it('does not throw — always returns a status object', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    await expect(getKycStatus('sme-004')).resolves.toMatchObject({ status: expect.any(String) });
  });
});

// ── 3. Persistence read-back ──────────────────────────────────────────────────

describe('persistence read-back', () => {
  it('returns DB record when provider is not configured', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'exempted',
        provider_record_id: 'rec_exempt',
        verified_at: null,
      }),
    }));

    const result = await getKycStatus('sme-005');
    expect(result.status).toBe('exempted');
    expect(result.recordId).toBe('rec_exempt');
  });

  it('returns pending when provider is off and no DB record', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const result = await getKycStatus('sme-006');
    expect(result.status).toBe(KYC_STATUSES.PENDING);
  });

  it('readKycRecord maps DB columns to camelCase fields', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'verified',
        provider_record_id: 'rec_xyz',
        verified_at: '2026-05-01T00:00:00.000Z',
      }),
    }));

    const record = await readKycRecord('sme-007');
    expect(record.status).toBe('verified');
    expect(record.recordId).toBe('rec_xyz');
    expect(record.verifiedAt).toMatch(/2026-05-01/);
  });

  it('readKycRecord returns null when no row found', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const record = await readKycRecord('sme-missing');
    expect(record).toBeNull();
  });
});

// ── 4. Funding gate ───────────────────────────────────────────────────────────

describe('canFundWithKycStatus', () => {
  it('allows funding for verified', () => {
    expect(canFundWithKycStatus('verified')).toBe(true);
  });

  it('allows funding for exempted', () => {
    expect(canFundWithKycStatus('exempted')).toBe(true);
  });

  it('denies funding for pending', () => {
    expect(canFundWithKycStatus('pending')).toBe(false);
  });

  it('denies funding for rejected', () => {
    expect(canFundWithKycStatus('rejected')).toBe(false);
  });

  it('denies funding for unknown/undefined status', () => {
    expect(canFundWithKycStatus(undefined)).toBe(false);
    expect(canFundWithKycStatus('')).toBe(false);
  });
});

// ── 5. Input validation ───────────────────────────────────────────────────────

describe('input validation', () => {
  it('throws on missing smeId', async () => {
    await expect(getKycStatus('')).rejects.toThrow('Invalid SME ID');
  });

  it('throws on non-string smeId', async () => {
    await expect(getKycStatus(123)).rejects.toThrow('Invalid SME ID');
  });
});

// ── 6. verifyWithExternalProvider — unit ─────────────────────────────────────

describe('verifyWithExternalProvider', () => {
  it('throws when provider is not configured', async () => {
    await expect(verifyWithExternalProvider('sme-x', {})).rejects.toThrow(
      'KYC provider not configured'
    );
  });

  it('throws a KycProviderError on non-ok response with retryable=false', async () => {
    enableProvider();
    mockFetchFail(400);
    db.mockImplementation(() => emptyDb());

    const promise = verifyWithExternalProvider('sme-x', {});
    await expect(promise).rejects.toBeInstanceOf(KycProviderError);
    await expect(promise).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    await expect(promise).rejects.toThrow(/400/);
  });

  it('does not send X-KYC-Signature when signing is disabled', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'my-secret';
    mockFetchOk({ status: 'verified', recordId: 'r1', verifiedAt: null });
    db.mockImplementation(() => emptyDb());

    await verifyWithExternalProvider('sme-x', {});

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers).not.toHaveProperty('X-KYC-Signature');
  });
});

// ── 7. Bounded timeout (Issue #592) ──────────────────────────────────────────

describe('bounded timeout (issue #592)', () => {
  beforeEach(() => {
    enableProvider();
    process.env.KYC_PROVIDER_TIMEOUT_MS = '150';
  });

  it('aborts via AbortController when fetch exceeds KYC_PROVIDER_TIMEOUT_MS', async () => {
    let signalSeenDuringCall;
    global.fetch = jest.fn(async (_url, init = {}) => {
      signalSeenDuringCall = init.signal;
      // Simulate a slow provider: never resolve until abort fires (or 5 s safety net).
      await new Promise((resolve, reject) => {
        if (init.signal && init.signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        init.signal && init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
        setTimeout(resolve, 5000);
      });
    });

    db.mockImplementation(() => emptyDb());

    const start = Date.now();
    const promise = getKycStatus('sme-timeout');
    await expect(promise).resolves.toBeDefined();
    const elapsed = Date.now() - start;

    // 150 ms timeout fires; allow generous slack for jest scheduling and retries.
    expect(elapsed).toBeLessThan(2000);
    expect(signalSeenDuringCall).toBeDefined();
    expect(signalSeenDuringCall.aborted).toBe(true);
  });

  it('clamps invalid KYC_PROVIDER_TIMEOUT_MS to a safe fallback', () => {
    process.env.KYC_PROVIDER_TIMEOUT_MS = '0'; // below min
    expect(getKycProviderConfig().timeoutMs).toBeGreaterThanOrEqual(100);
    process.env.KYC_PROVIDER_TIMEOUT_MS = '99999999'; // above max
    expect(getKycProviderConfig().timeoutMs).toBeLessThanOrEqual(30000);
  });
});

// ── 8. Retry behaviour (Issue #592) ──────────────────────────────────────────

describe('retry behaviour (issue #592)', () => {
  it('retries transient 503 and succeeds on the second attempt', async () => {
    enableProvider();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve(''), headers: { get: () => null } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: 'verified', recordId: 'rec_recovered' })),
        headers: { get: () => null },
      });
    db.mockImplementation(() => emptyDb());

    const result = await getKycStatus('sme-retry-1');
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('rec_recovered');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent 4xx (400 Bad Request)', async () => {
    enableProvider();
    mockFetchFail(400);
    db.mockImplementation(() => emptyDb());

    await expect(verifyWithExternalProvider('sme-perm-400', {})).rejects.toBeInstanceOf(KycProviderError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a network ETIMEDOUT error then succeeds', async () => {
    enableProvider();
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: 'verified', recordId: 'rec_after_timeout' })),
        headers: { get: () => null },
      });
    db.mockImplementation(() => emptyDb());

    const result = await getKycStatus('sme-retry-network');
    expect(result.status).toBe('verified');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries (4 fetch attempts total) then surfaces retryable KycProviderError on persistent 503', async () => {
    enableProvider();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(''),
      headers: { get: () => null },
    });
    db.mockImplementation(() => emptyDb());

    const err = await verifyWithExternalProvider('sme-503-spam', {}).catch((e) => e);
    expect(err).toBeInstanceOf(KycProviderError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    // Default KYC_PROVIDER_MAX_RETRIES=3 → 1 initial + 3 retries = 4 attempts.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('surfaces retryable=true on the KycProviderError after retry exhaustion', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    );
    db.mockImplementation(() => emptyDb());

    const err = await verifyWithExternalProvider('sme-prov-down', {}).catch((e) => e);
    expect(err).toBeInstanceOf(KycProviderError);
    expect(err.retryable).toBe(true);
    expect(err.code).toMatch(/network/i);
  });
});

// ── 9. Circuit breaker (Issue #592) ──────────────────────────────────────────

describe('circuit breaker (issue #592)', () => {
  it('opens after threshold consecutive failures and fails fast with CIRCUIT_OPEN', async () => {
    enableProvider();
    sharedKycBreaker.failureThreshold = 3;
    sharedKycBreaker.reset();

    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    );
    db.mockImplementation(() => emptyDb());

    // Three exhausted-retry calls bump the breaker failure count to threshold.
    await expect(verifyWithExternalProvider('sme-cb-1', {})).rejects.toBeInstanceOf(KycProviderError);
    await expect(verifyWithExternalProvider('sme-cb-2', {})).rejects.toBeInstanceOf(KycProviderError);
    await expect(verifyWithExternalProvider('sme-cb-3', {})).rejects.toBeInstanceOf(KycProviderError);

    // The breaker should now be OPEN. A direct verify call fails fast with a
    // stable upstream_unavailable contract rather than leaking breaker internals.
    const callCountBefore = global.fetch.mock.calls.length;
    await expect(verifyWithExternalProvider('sme-cb-4', {})).rejects.toBeInstanceOf(KycUpstreamUnavailableError);
    await expect(verifyWithExternalProvider('sme-cb-5', {})).rejects.toMatchObject({
      code: 'upstream_unavailable', status: 503, retryable: true,
    });
    expect(global.fetch.mock.calls.length).toBe(callCountBefore);
  });

  it('successful calls keep the breaker CLOSED and failureCount at 0', async () => {
    enableProvider();
    mockFetchOk({ status: 'verified' });
    db.mockImplementation(() => emptyDb());

    await verifyWithExternalProvider('sme-ok-1', {});
    expect(sharedKycBreaker.failureCount).toBe(0);
    expect(sharedKycBreaker.state).toBe('CLOSED');
  });
});

// ── 10. Outbound HMAC request signing (Issue #592) ───────────────────────────

describe('outbound HMAC request signing (issue #592)', () => {
  it('sends a valid X-KYC-Signature header when KYC_PROVIDER_SIGN_REQUESTS=true', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'super-secret';
    process.env.KYC_PROVIDER_SIGN_REQUESTS = 'true';

    let capturedOpts;
    let rawBody;
    global.fetch = jest.fn(async (_url, opts = {}) => {
      capturedOpts = opts;
      rawBody = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: 'verified', recordId: 'r_hmac' })),
        headers: { get: () => null },
      };
    });
    db.mockImplementation(() => emptyDb());

    await verifyWithExternalProvider('sme-hmac-1', {});

    expect(capturedOpts.headers['X-KYC-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // Recompute the expected signature against the actual body and verify match.
    const header = capturedOpts.headers['X-KYC-Signature'];
    const verification = verifySignature('super-secret', rawBody, header);
    expect(verification.valid).toBe(true);
  });

  it('omits X-KYC-Signature when KYC_PROVIDER_SECRET is set but signing flag is off', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'super-secret';
    process.env.KYC_PROVIDER_SIGN_REQUESTS = 'false';
    mockFetchOk({ status: 'verified' });
    db.mockImplementation(() => emptyDb());

    await verifyWithExternalProvider('sme-hmac-2', {});
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers).not.toHaveProperty('X-KYC-Signature');
  });

  it('omits X-KYC-Signature when KYC_PROVIDER_SIGN_REQUESTS=true but no secret configured', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SIGN_REQUESTS = 'true';
    mockFetchOk({ status: 'verified' });
    db.mockImplementation(() => emptyDb());

    await verifyWithExternalProvider('sme-hmac-3', {});
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers).not.toHaveProperty('X-KYC-Signature');
  });
});

// ── 11. Response integrity verification (Issue #592) ─────────────────────────

describe('response integrity verification (issue #592)', () => {
  it('defensively verifies X-KYC-Signature when provider sends one (rejects mismatches)', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'shared-secret';

    const body = JSON.stringify({ status: 'verified', recordId: 'r_int' });
    const tamperedBody = JSON.stringify({ status: 'rejected', recordId: 'r_evil' });
    const wrongSig = createSignatureHeader('attacker-secret', body);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(tamperedBody),
      headers: {
        get: (name) => (name.toLowerCase() === 'x-kyc-signature' ? wrongSig : null),
      },
    });
    db.mockImplementation(() => emptyDb());

    const err = await verifyWithExternalProvider('sme-int-1', {}).catch((e) => e);
    expect(err).toBeInstanceOf(KycProviderError);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('invalid_response_signature');
  });

  it('accepts a valid X-KYC-Signature header from the provider', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'shared-secret';

    const body = JSON.stringify({ status: 'verified', recordId: 'r_signed' });
    const goodSig = createSignatureHeader('shared-secret', body);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
      headers: {
        get: (name) => (name.toLowerCase() === 'x-kyc-response-signature' ? goodSig : null),
      },
    });
    db.mockImplementation(() => emptyDb());

    const result = await verifyWithExternalProvider('sme-int-2', {});
    expect(result.status).toBe('verified');
    // Assert that fetch was actually consulted — a regression that short-
    // circuits to a cached value would otherwise pass on `result.status`.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('strict mode rejects when provider omits the signature header', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'shared-secret';
    process.env.KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE = 'true';
    mockFetchOk({ status: 'verified' });
    db.mockImplementation(() => emptyDb());

    const err = await verifyWithExternalProvider('sme-int-3', {}).catch((e) => e);
    expect(err).toBeInstanceOf(KycProviderError);
    expect(err.code).toBe('missing_response_signature');
    expect(err.retryable).toBe(false);
  });

  it('non-strict mode accepts when provider omits the signature header (default)', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_SECRET = 'shared-secret';
    mockFetchOk({ status: 'verified', recordId: 'r_no_sig' });
    db.mockImplementation(() => emptyDb());

    const result = await verifyWithExternalProvider('sme-int-4', {});
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('r_no_sig');
  });

  it('rejects non-JSON response body (fail-closed)', async () => {
    enableProvider();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<html>not json</html>'),
      headers: { get: () => null },
    });
    db.mockImplementation(() => emptyDb());

    const err = await verifyWithExternalProvider('sme-int-5', {}).catch((e) => e);
    expect(err).toBeInstanceOf(KycProviderError);
    expect(err.code).toBe('invalid_response_body');
    expect(err.retryable).toBe(false);
  });
});

// ── 12. classifyKycError (Issue #592) ─────────────────────────────────────────

describe('classifyKycError (issue #592)', () => {
  it('marks 5xx as retryable', () => {
    expect(classifyKycError({ status: 503 }).retryable).toBe(true);
    expect(classifyKycError({ status: 500 }).retryable).toBe(true);
    expect(classifyKycError({ status: 502 }).retryable).toBe(true);
    expect(classifyKycError({ status: 504 }).retryable).toBe(true);
  });

  it('marks transient network codes as retryable with a stable reason code', () => {
    // Both the boolean verdict AND the stable reason string must hold, so a
    // regression that flips retryable=true without also stamping the right
    // reason (e.g. a future reordering of the classifier) is caught.
    expect(classifyKycError({ code: 'ETIMEDOUT' })).toMatchObject({
      retryable: true,
      reason: expect.stringMatching(/^network:/i),
    });
    expect(classifyKycError({ code: 'econnrefused' })).toMatchObject({
      retryable: true,
      reason: expect.stringMatching(/^network:/i),
    });
    expect(classifyKycError({ code: 'ENOTFOUND' })).toMatchObject({
      retryable: true,
      reason: expect.stringMatching(/^network:/i),
    });
    expect(classifyKycError({ name: 'AbortError' })).toMatchObject({
      retryable: true,
      reason: 'timeout',
    });
  });

  it('marks 429 as retryable', () => {
    expect(classifyKycError({ status: 429 }).retryable).toBe(true);
  });

  it('marks permanent 4xx as non-retryable', () => {
    expect(classifyKycError({ status: 400 }).retryable).toBe(false);
    expect(classifyKycError({ status: 401 }).retryable).toBe(false);
    expect(classifyKycError({ status: 403 }).retryable).toBe(false);
    expect(classifyKycError({ status: 404 }).retryable).toBe(false);
  });

  it('marks unrelated errors as non-retryable', () => {
    expect(classifyKycError(null).retryable).toBe(false);
    expect(classifyKycError(undefined).retryable).toBe(false);
    expect(classifyKycError('string error').retryable).toBe(false);
    expect(classifyKycError({ code: 'EBADRQC' }).retryable).toBe(false);
  });

  it('honours explicit retryable flag on KycProviderError', () => {
    expect(classifyKycError(new KycProviderError('clock', { retryable: true })).retryable).toBe(true);
    expect(classifyKycError(new KycProviderError('boom', { retryable: false })).retryable).toBe(false);
  });
});

// ── 13. Secret-leak prevention (Issue #592 security note) ────────────────────

describe('secret-leak prevention (issue #592)', () => {
  it('verifyWithExternalProvider error messages never include secrets', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_API_KEY = 'leaky-key-12345';
    process.env.KYC_PROVIDER_SECRET = 'leaky-secret-67890';
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    );
    db.mockImplementation(() => emptyDb());

    const err = await verifyWithExternalProvider('sme-leak-2', {}).catch((e) => e);
    expect(err).toBeInstanceOf(KycProviderError);
    expect(err.message).not.toContain('leaky-key-12345');
    expect(err.message).not.toContain('leaky-secret-67890');
  });

  it('logs emitted by verifyWithExternalProvider never contain secrets', async () => {
    enableProvider();
    process.env.KYC_PROVIDER_API_KEY = 'log-leak-key';
    process.env.KYC_PROVIDER_SECRET = 'log-leak-secret';

    const logger = require('../src/logger');
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    mockFetchFail(503);
    db.mockImplementation(() => emptyDb());
    await verifyWithExternalProvider('sme-leak-3', {}).catch(() => {});

    const allCalls = [...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain('log-leak-key');
      expect(serialised).not.toContain('log-leak-secret');
    }

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ── 14. parseClampedInt (Issue #592 helper) ──────────────────────────────────

describe('parseClampedInt (issue #592 helper)', () => {
  it('returns fallback for missing / non-numeric input', () => {
    expect(parseClampedInt(undefined, 50, 10, 100)).toBe(50);
    expect(parseClampedInt('', 50, 10, 100)).toBe(50);
    expect(parseClampedInt('not-a-number', 50, 10, 100)).toBe(50);
  });

  it('clamps to min and max', () => {
    expect(parseClampedInt('0', 50, 10, 100)).toBe(10);
    expect(parseClampedInt('999', 50, 10, 100)).toBe(100);
    expect(parseClampedInt('50', 50, 10, 100)).toBe(50);
  });

  it('handles numeric, string, and number inputs', () => {
    expect(parseClampedInt(42, 50, 10, 100)).toBe(42);
    expect(parseClampedInt('42', 50, 10, 100)).toBe(42);
    expect(parseClampedInt(null, 50, 10, 100)).toBe(50);
  });
});

// ── 15. Mock path preserved when provider unconfigured (Issue #592) ──────────

describe('mock path preserved when provider unconfigured (issue #592)', () => {
  it('falls back to readKycRecord on every code path when KYC_PROVIDER_* is absent', async () => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'verified',
        provider_record_id: 'rec_unconfigured',
        verified_at: null,
      }),
    }));

    const result = await getKycStatus('sme-unconfigured');
    expect(result.status).toBe('verified');
    expect(result.recordId).toBe('rec_unconfigured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not invoke the provider when only the URL is set without the API key', async () => {
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const result = await getKycStatus('sme-half-config');
    expect(result.status).toBe(KYC_STATUSES.PENDING);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── 16. Defensive branches and helpers (Issue #592 hardening follow-ups) ────

describe('input validation hardening (issue #592)', () => {
  it('readKycRecord throws on null / undefined / non-string smeId', async () => {
    await expect(readKycRecord(null)).rejects.toThrow('Invalid SME ID');
    await expect(readKycRecord(undefined)).rejects.toThrow('Invalid SME ID');
    await expect(readKycRecord(123)).rejects.toThrow('Invalid SME ID');
  });

  it('persistKycRecord throws on missing smeId', async () => {
    await expect(persistKycRecord({ smeId: '', status: 'verified' })).rejects.toThrow('Invalid SME ID');
    await expect(persistKycRecord({ smeId: null, status: 'verified' })).rejects.toThrow('Invalid SME ID');
  });

  it('verifySmeSafe throws on missing smeId', async () => {
    await expect(verifySmeSafe('')).rejects.toThrow('Invalid SME ID');
    await expect(verifySmeSafe(null)).rejects.toThrow('Invalid SME ID');
    await expect(verifySmeSafe(123)).rejects.toThrow('Invalid SME ID');
  });

  it('rejectSmeKyc throws on missing smeId', async () => {
    await expect(rejectSmeKyc('')).rejects.toThrow('Invalid SME ID');
    await expect(rejectSmeKyc(undefined)).rejects.toThrow('Invalid SME ID');
  });

  it('exemptSmeFromKyc throws on missing smeId', async () => {
    await expect(exemptSmeFromKyc('')).rejects.toThrow('Invalid SME ID');
    await expect(exemptSmeFromKyc(0)).rejects.toThrow('Invalid SME ID');
  });
});

describe('normalizeProviderStatus defensive defaults (issue #592)', () => {
  it('returns UNKNOWN for null / undefined provider status', () => {
    expect(normalizeProviderStatus(null)).toBe(KYC_STATUSES.UNKNOWN);
    expect(normalizeProviderStatus(undefined)).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('returns UNKNOWN for non-string provider status', () => {
    expect(normalizeProviderStatus(123)).toBe(KYC_STATUSES.UNKNOWN);
    expect(normalizeProviderStatus({})).toBe(KYC_STATUSES.UNKNOWN);
    expect(normalizeProviderStatus([])).toBe(KYC_STATUSES.UNKNOWN);
    expect(normalizeProviderStatus(true)).toBe(KYC_STATUSES.UNKNOWN);
  });

  it('returns UNKNOWN for empty / whitespace-only provider status', () => {
    expect(normalizeProviderStatus('')).toBe(KYC_STATUSES.UNKNOWN);
    expect(normalizeProviderStatus('   ')).toBe(KYC_STATUSES.UNKNOWN);
  });
});

describe('resetKycCircuitBreaker (issue #592)', () => {
  it('returns the shared breaker to CLOSED state with failureCount=0 after tripping', async () => {
    enableProvider();
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    );
    db.mockImplementation(() => emptyDb());

    // Trip the breaker via a single low-threshold failure cycle.
    sharedKycBreaker.failureThreshold = 1;
    await verifyWithExternalProvider('sme-trip', {}).catch(() => {});
    expect(sharedKycBreaker.state).toBe('OPEN');
    expect(sharedKycBreaker.failureCount).toBeGreaterThanOrEqual(1);

    // Reset via the exported helper, then assert CLOSED state.
    resetKycCircuitBreaker();
    expect(sharedKycBreaker.state).toBe('CLOSED');
    expect(sharedKycBreaker.failureCount).toBe(0);
  });
});

describe('mock record fallback when DB is empty (issue #592)', () => {
  it('returns the in-memory mock record when DB has no matching row', async () => {
    // 1. Seed the in-memory mock store via verifySmeSafe (also writes to DB).
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));
    await verifySmeSafe('sme-mock-only-1');

    // 2. Simulate a freshly cleared DB (no row) while the mock store still holds the record.
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    }));

    const result = await getKycStatus('sme-mock-only-1');
    expect(result.status).toBe(KYC_STATUSES.VERIFIED);
  });
});

// ── 17. KYC webhook route (unchanged behaviour, post-issue-#592) ─────────────

describe('KYC webhook route', () => {
  let app;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
    app = require('express')();
    app.use(require('express').raw({ type: 'application/json', limit: '100kb' }));
    app.use('/api/kyc', kycRoutes);
  });

  it('accepts valid signed webhook payload and persists the record', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-webhook-01',
      status: 'approved',
      recordId: 'rec_webhook_01',
      verifiedAt: '2026-06-24T12:00:00.000Z',
      tenantId: 'tenant-a',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);
    const token = jwt.sign({ sub: 'svc-internal', tenantId: 'tenant-a' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-a')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('verified');
  });

  it('rejects webhook with invalid signature', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { smeId: 'sme-webhook-02', status: 'approved', tenantId: 'tenant-a' };
    const rawBody = JSON.stringify(payload);
    const token = jwt.sign({ sub: 'svc-internal', tenantId: 'tenant-a' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-a')
      .set('X-Signature', 't=123,v1=deadbeef')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid webhook signature/);
  });

  it('rejects authenticated requests that lack tenant context', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const token = jwt.sign({ sub: 'svc-internal' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const payload = { smeId: 'sme-webhook-05', status: 'approved', tenantId: 'tenant-a' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing tenant context.');
  });

  it('rejects cross-tenant webhook updates', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const token = jwt.sign({ sub: 'svc-internal', tenantId: 'tenant-a' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const payload = { smeId: 'sme-webhook-06', status: 'approved', tenantId: 'tenant-b' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Tenant scope mismatch.');
  });

  it('accepts matching tenant-scoped webhook updates', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const token = jwt.sign({ sub: 'svc-internal', tenantId: 'tenant-a' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const payload = { smeId: 'sme-webhook-07', status: 'approved', tenantId: 'tenant-a' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-a')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.smeId).toBe('sme-webhook-07');
  });

  it('rejects webhook with unknown provider status', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { smeId: 'sme-webhook-03', status: 'mystery_status', tenantId: 'tenant-a' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);
    const token = jwt.sign({ sub: 'svc-internal', tenantId: 'tenant-a' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-a')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown provider status/);
  });

  it('accepts repeated webhook deliveries without failing', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-webhook-04',
      status: 'approved',
      recordId: 'rec_webhook_04',
      verifiedAt: '2026-06-24T12:00:00.000Z',
      tenantId: 'tenant-a',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);
    const token = jwt.sign({ sub: 'svc-internal', tenantId: 'tenant-a' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const where = jest.fn().mockReturnThis();
    const first = jest.fn().mockResolvedValue({ sme_id: 'sme-webhook-04' });
    const insert = jest.fn();
    const update = jest.fn().mockResolvedValue(1);

    db.mockImplementation(() => ({ where, first, insert, update }));

    const firstResponse = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-a')
      .set('X-Signature', signature)
      .send(rawBody);

    const secondResponse = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-a')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});

// ── 18. KYC webhook metrics (issue #731) ────────────────────────────────────

describe('KYC webhook metrics (issue #731)', () => {
  let app;
  let metrics;

  beforeEach(() => {
    app = require('express')();
    app.use(require('express').raw({ type: 'application/json', limit: '100kb' }));
    app.use('/api/kyc', kycRoutes);
    metrics = require('../src/metrics');
    metrics.kycWebhookRequestDurationSeconds.reset();
    metrics.kycWebhookRequestsTotal.reset();
    metrics.kycWebhookErrorsTotal.reset();
  });

  function getHashEntries(metric) {
    return Object.values(metric.hashMap || {});
  }

  it('emits 2xx status class metric on successful webhook ingestion', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-metric-01',
      status: 'approved',
      recordId: 'rec_metric_01',
      verifiedAt: '2026-06-24T12:00:00.000Z',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);

    const reqEntries = getHashEntries(metrics.kycWebhookRequestsTotal);
    const req2xx = reqEntries.find((e) => e.labels.status_class === '2xx');
    expect(req2xx).toBeDefined();
    expect(req2xx.value).toBe(1);

    const durationEntries = getHashEntries(metrics.kycWebhookRequestDurationSeconds);
    const dur2xx = durationEntries.find((e) => e.labels && e.labels.status_class === '2xx');
    expect(dur2xx).toBeDefined();
  });

  it('emits 4xx status class and missing_signature cause on missing X-Signature', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { smeId: 'sme-metric-02', status: 'approved' };
    const rawBody = JSON.stringify(payload);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);

    const reqEntries = getHashEntries(metrics.kycWebhookRequestsTotal);
    const req4xx = reqEntries.find((e) => e.labels.status_class === '4xx');
    expect(req4xx).toBeDefined();
    expect(req4xx.value).toBe(1);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errSig = errEntries.find((e) => e.labels.cause === 'missing_signature');
    expect(errSig).toBeDefined();
    expect(errSig.value).toBe(1);
  });

  it('emits 4xx status class and invalid_signature cause on bad signature', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { smeId: 'sme-metric-03', status: 'approved' };
    const rawBody = JSON.stringify(payload);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 't=123,v1=deadbeef')
      .send(rawBody);

    expect(res.status).toBe(401);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errSig = errEntries.find((e) => e.labels.cause === 'invalid_signature');
    expect(errSig).toBeDefined();
    expect(errSig.value).toBe(1);
  });

  it('emits 4xx and unknown_status cause for unrecognized provider status', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { smeId: 'sme-metric-04', status: 'mystery_status' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errStatus = errEntries.find((e) => e.labels.cause === 'unknown_status');
    expect(errStatus).toBeDefined();
    expect(errStatus.value).toBe(1);
  });

  it('emits 5xx status class and missing_secret cause when KYC_PROVIDER_SECRET is absent', async () => {
    delete process.env.KYC_PROVIDER_SECRET;

    const payload = { smeId: 'sme-metric-05', status: 'approved' };
    const rawBody = JSON.stringify(payload);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(503);

    const reqEntries = getHashEntries(metrics.kycWebhookRequestsTotal);
    const req5xx = reqEntries.find((e) => e.labels.status_class === '5xx');
    expect(req5xx).toBeDefined();
    expect(req5xx.value).toBe(1);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errSecret = errEntries.find((e) => e.labels.cause === 'missing_secret');
    expect(errSecret).toBeDefined();
    expect(errSecret.value).toBe(1);
  });

  it('emits 4xx and invalid_payload cause for malformed JSON body', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const rawBody = '{ invalid json';
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errPayload = errEntries.find((e) => e.labels.cause === 'invalid_payload');
    expect(errPayload).toBeDefined();
    expect(errPayload.value).toBe(1);
  });

  it('emits 4xx and missing_sme_id cause when smeId is absent', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { status: 'approved' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing or invalid smeId/);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errSme = errEntries.find((e) => e.labels.cause === 'missing_sme_id');
    expect(errSme).toBeDefined();
    expect(errSme.value).toBe(1);
  });

  it('emits 4xx and missing_status cause when status is absent', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = { smeId: 'sme-metric-07' };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing or invalid status/);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errStatus = errEntries.find((e) => e.labels.cause === 'missing_status');
    expect(errStatus).toBeDefined();
    expect(errStatus.value).toBe(1);
  });

  it('emits 5xx and persistence_error cause when persistKycRecord throws', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-metric-08',
      status: 'approved',
      recordId: 'rec_metric_08',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockRejectedValue(new Error('DB write failed')),
      update: jest.fn().mockResolvedValue(1),
    }));

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/DB write failed/);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const errPersist = errEntries.find((e) => e.labels.cause === 'persistence_error');
    expect(errPersist).toBeDefined();
    expect(errPersist.value).toBe(1);
  });

  it('no error metric is emitted for 2xx success responses', async () => {
    process.env.KYC_PROVIDER_SECRET = 'webhook-secret';

    const payload = {
      smeId: 'sme-metric-09',
      status: 'approved',
      recordId: 'rec_metric_09',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('webhook-secret', rawBody);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));

    await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);

    const errEntries = getHashEntries(metrics.kycWebhookErrorsTotal);
    const noneValues = errEntries.filter((v) => v.labels.cause === 'none');
    expect(noneValues.length).toBe(0);
  });
});

// ── 19. KYC webhook metrics normalizers (issue #731) ────────────────────────

describe('normalizeKycWebhookStatusClass (issue #731)', () => {
  const { normalizeKycWebhookStatusClass } = require('../src/metrics');

  it('returns 2xx for successful statuses', () => {
    expect(normalizeKycWebhookStatusClass(200)).toBe('2xx');
    expect(normalizeKycWebhookStatusClass(201)).toBe('2xx');
  });

  it('returns 4xx for client error statuses', () => {
    expect(normalizeKycWebhookStatusClass(400)).toBe('4xx');
    expect(normalizeKycWebhookStatusClass(401)).toBe('4xx');
    expect(normalizeKycWebhookStatusClass(404)).toBe('4xx');
  });

  it('returns 5xx for server error statuses', () => {
    expect(normalizeKycWebhookStatusClass(500)).toBe('5xx');
    expect(normalizeKycWebhookStatusClass(503)).toBe('5xx');
  });

  it('handles non-numeric input gracefully', () => {
    expect(normalizeKycWebhookStatusClass('400')).toBe('4xx');
    expect(normalizeKycWebhookStatusClass(undefined)).toBe('2xx');
    expect(normalizeKycWebhookStatusClass(null)).toBe('2xx');
  });
});

describe('normalizeKycWebhookCause (issue #731)', () => {
  const { normalizeKycWebhookCause } = require('../src/metrics');

  it('returns none for 2xx responses without error code', () => {
    expect(normalizeKycWebhookCause({ status: 200 })).toBe('none');
    expect(normalizeKycWebhookCause({ status: 201 })).toBe('none');
  });

  it('returns the errorCode when it is a valid bounded value', () => {
    expect(normalizeKycWebhookCause({ status: 400, errorCode: 'missing_sme_id' })).toBe('missing_sme_id');
    expect(normalizeKycWebhookCause({ status: 401, errorCode: 'invalid_signature' })).toBe('invalid_signature');
    expect(normalizeKycWebhookCause({ status: 503, errorCode: 'missing_secret' })).toBe('missing_secret');
  });

  it('returns internal for unknown error codes', () => {
    expect(normalizeKycWebhookCause({ status: 500, errorCode: 'something_unexpected' })).toBe('internal');
    expect(normalizeKycWebhookCause({ status: 400, errorCode: '' })).toBe('4xx' ? 'internal' : 'internal');
  });

  it('returns internal for 4xx without an error code', () => {
    expect(normalizeKycWebhookCause({ status: 400 })).toBe('internal');
    expect(normalizeKycWebhookCause({ status: 500 })).toBe('internal');
  });
});

// Additional contract tests: field aliases and raw-body signature requirement
describe('KYC webhook contract — aliases and raw-body signature', () => {
  let app;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
    app = require('express')();
    app.use(require('express').raw({ type: 'application/json', limit: '100kb' }));
    app.use('/api/kyc', require('../src/routes/kyc'));
  });

  it('accepts alias fields (`sme_id`, `kyc_status`, `provider_record_id`) and normalises status', async () => {
    process.env.KYC_PROVIDER_SECRET = 'alias-secret';

    const payload = {
      sme_id: 'sme-alias-01',
      kyc_status: 'approved',
      provider_record_id: 'rec_alias_01',
      tenant_id: 'tenant-x',
    };
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader('alias-secret', rawBody);
    const token = jwt.sign({ sub: 'svc', tenantId: 'tenant-x' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-x')
      .set('X-Signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.smeId).toBe('sme-alias-01');
    expect(res.body.status).toBe('verified');
  });

  it('requires signature be computed over the exact raw body bytes (whitespace matters)', async () => {
    process.env.KYC_PROVIDER_SECRET = 'whitespace-secret';

    const payload = { smeId: 'sme-space-01', status: 'approved' };
    const rawBodyNoSpace = JSON.stringify(payload);
    // Pretty-printed with additional whitespace
    const rawBodyPretty = JSON.stringify(payload, null, 2);

    // Signature computed over the compact form
    const signature = createSignatureHeader('whitespace-secret', rawBodyNoSpace);

    const res = await request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBodyPretty);

    // Signature must not validate because the raw bytes differ
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid webhook signature/);
  });
});
