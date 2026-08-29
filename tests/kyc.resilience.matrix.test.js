'use strict';

/**
 * Additional provider-resilience matrix tests. The HTTP integration suite
 * covers request/response wiring; this file exhaustively locks down the
 * policy boundary so a future provider status or transport change cannot
 * accidentally turn a permanent error into a retry storm.
 */

const { CircuitBreaker, CircuitBreakerState } = require('../src/utils/circuitBreaker');
const {
  KycProviderError,
  KycUpstreamUnavailableError,
  classifyKycError,
  getKycProviderConfig,
  getKycProviderResilienceState,
  parseClampedInt,
  resetKycCircuitBreaker,
  sharedKycBreaker,
} = require('../src/services/kycService');

describe('KYC classification matrix', () => {
  it.each([
    ['status 408', { status: 408 }, true, 'status:408'],
    ['status 425', { status: 425 }, true, 'status:425'],
    ['status 429', { status: 429 }, true, 'status:429'],
    ['status 500', { status: 500 }, true, 'status:500'],
    ['status 502', { status: 502 }, true, 'status:502'],
    ['status 503', { status: 503 }, true, 'status:503'],
    ['status 504', { status: 504 }, true, 'status:504'],
    ['status 400', { status: 400 }, false, 'non-retryable'],
    ['status 401', { status: 401 }, false, 'non-retryable'],
    ['status 403', { status: 403 }, false, 'non-retryable'],
    ['status 404', { status: 404 }, false, 'non-retryable'],
    ['status 409', { status: 409 }, false, 'non-retryable'],
    ['status 422', { status: 422 }, false, 'non-retryable'],
  ])('classifies %s', (_label, error, retryable, reason) => {
    expect(classifyKycError(error)).toEqual({ retryable, reason });
  });

  it.each([
    ['ECONNRESET', 'ECONNRESET'], ['econnrefused', 'network:ECONNREFUSED'],
    ['ETIMEDOUT', 'network:ETIMEDOUT'], ['EAI_AGAIN', 'network:EAI_AGAIN'],
    ['ENOTFOUND', 'network:ENOTFOUND'], ['ABORT_ERR', 'network:ABORT_ERR'],
  ])('classifies transport code %s as transient', (code, reason) => {
    const result = classifyKycError({ code });
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe(code === 'ECONNRESET' ? 'network:ECONNRESET' : reason);
  });

  it.each([
    ['EPERM'], ['EACCES'], ['EINVAL'], ['EISDIR'], ['UNKNOWN'],
  ])('does not retry local/permanent code %s', (code) => {
    expect(classifyKycError({ code })).toEqual({ retryable: false, reason: 'non-retryable' });
  });

  it('prefers the typed provider error verdict over a misleading status field', () => {
    const permanent = new KycProviderError('bad signature', { status: 503, retryable: false, code: 'invalid_response_signature' });
    const transient = new KycProviderError('temporary', { status: 400, retryable: true, code: 'provider_busy' });
    expect(classifyKycError(permanent)).toEqual({ retryable: false, reason: 'invalid_response_signature' });
    expect(classifyKycError(transient)).toEqual({ retryable: true, reason: 'provider_busy' });
  });

  it('does not expose an upstream cause in the public unavailable message', () => {
    const error = new KycUpstreamUnavailableError(new Error('secret=provider-api-key response=ssn'));
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('ssn');
    expect(error.code).toBe('upstream_unavailable');
  });
});

describe('KYC provider configuration contract', () => {
  const keys = [
    'KYC_PROVIDER_URL', 'KYC_PROVIDER_API_KEY', 'KYC_PROVIDER_SECRET',
    'KYC_PROVIDER_TIMEOUT_MS', 'KYC_PROVIDER_MAX_RETRIES',
    'KYC_PROVIDER_BASE_DELAY_MS', 'KYC_PROVIDER_MAX_DELAY_MS',
    'KYC_PROVIDER_SIGN_REQUESTS', 'KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE',
    'KYC_PROVIDER_CB_FAILURE_THRESHOLD', 'KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS',
  ];
  const original = {};

  beforeEach(() => {
    for (const key of keys) original[key] = process.env[key];
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('is disabled when either provider credential or URL is absent', () => {
    expect(getKycProviderConfig()).toMatchObject({ enabled: false, apiKey: null, baseUrl: null });
    process.env.KYC_PROVIDER_URL = 'https://kyc.example';
    expect(getKycProviderConfig().enabled).toBe(false);
    process.env.KYC_PROVIDER_API_KEY = 'key';
    expect(getKycProviderConfig().enabled).toBe(true);
  });

  it('uses bounded production defaults', () => {
    expect(getKycProviderConfig()).toMatchObject({
      timeoutMs: 5000, maxRetries: 3, baseDelay: 200, maxDelay: 5000,
      signRequests: false, verifyResponseSignature: false,
    });
  });

  it('clamps timeout, retry, and delay configuration', () => {
    process.env.KYC_PROVIDER_TIMEOUT_MS = '999999';
    process.env.KYC_PROVIDER_MAX_RETRIES = '-10';
    process.env.KYC_PROVIDER_BASE_DELAY_MS = '-1';
    process.env.KYC_PROVIDER_MAX_DELAY_MS = '999999';
    expect(getKycProviderConfig()).toMatchObject({ timeoutMs: 30000, maxRetries: 0, baseDelay: 0, maxDelay: 60000 });
  });

  it('accepts opt-in signing and response-integrity flags only for true', () => {
    process.env.KYC_PROVIDER_SIGN_REQUESTS = 'TRUE';
    process.env.KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE = 'true';
    expect(getKycProviderConfig()).toMatchObject({ signRequests: true, verifyResponseSignature: true });
    process.env.KYC_PROVIDER_SIGN_REQUESTS = 'yes';
    process.env.KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE = '1';
    expect(getKycProviderConfig()).toMatchObject({ signRequests: false, verifyResponseSignature: false });
  });

  it.each([
    ['1', 1], ['100', 100], ['0', 1], ['1000', 100], ['garbage', 5],
  ])('clamps circuit threshold %s to %s', (raw, expected) => {
    expect(parseClampedInt(raw, 5, 1, 100)).toBe(expected);
  });
});

describe('per-dependency breaker behavior', () => {
  it('allows unrelated dependencies to continue while KYC is open', async () => {
    const kyc = new CircuitBreaker({ name: 'kyc', failureThreshold: 1, recoveryTimeout: 60_000 });
    const redis = new CircuitBreaker({ name: 'redis', failureThreshold: 1, recoveryTimeout: 60_000 });
    await expect(kyc.execute(async () => { throw new Error('kyc outage'); })).rejects.toThrow('kyc outage');
    expect(kyc.state).toBe(CircuitBreakerState.OPEN);
    await expect(redis.execute(async () => 'redis ok')).resolves.toBe('redis ok');
    expect(redis.state).toBe(CircuitBreakerState.CLOSED);
  });

  it('opens after N failed operations, not after N failed internal retry attempts', () => {
    const breaker = new CircuitBreaker({ name: 'one-call-one-failure', failureThreshold: 3, recoveryTimeout: 60_000 });
    expect(() => breaker.onFailure(new Error('first'))).toThrow();
    expect(() => breaker.onFailure(new Error('second'))).toThrow();
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
    expect(() => breaker.onFailure(new Error('third'))).toThrow();
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);
  });

  it('permits exactly the half-open probe after cooldown', async () => {
    const breaker = new CircuitBreaker({ name: 'half-open', failureThreshold: 1, recoveryTimeout: 2 });
    await expect(breaker.execute(async () => { throw new Error('outage'); })).rejects.toThrow('outage');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(breaker.execute(async () => 'probe ok')).resolves.toBe('probe ok');
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
  });

  it('reopens immediately when the half-open probe fails', async () => {
    const breaker = new CircuitBreaker({ name: 'half-open-fail', failureThreshold: 1, recoveryTimeout: 2 });
    await expect(breaker.execute(async () => { throw new Error('outage'); })).rejects.toThrow('outage');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(breaker.execute(async () => { throw new Error('still outage'); })).rejects.toThrow('still outage');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);
  });

  it('reports only safe fields from the shared KYC state snapshot', () => {
    resetKycCircuitBreaker();
    const snapshot = getKycProviderResilienceState();
    expect(Object.keys(snapshot).sort()).toEqual(['dependency', 'failureCount', 'nextAttemptAt', 'state']);
    expect(snapshot.dependency).toBe('kyc-provider');
  });

  it('resets the shared breaker to permit recovery after an operator action', () => {
    sharedKycBreaker.state = CircuitBreakerState.OPEN;
    sharedKycBreaker.failureCount = 99;
    resetKycCircuitBreaker();
    expect(getKycProviderResilienceState()).toMatchObject({ state: CircuitBreakerState.CLOSED, failureCount: 0 });
  });
});
