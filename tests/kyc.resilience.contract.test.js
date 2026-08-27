'use strict';

/**
 * Contract-level coverage for the KYC provider resilience boundary.
 *
 * These tests intentionally exercise the small, dependency-free primitives
 * directly as well as the exported KYC service state. The provider tests own
 * HTTP integration; this suite locks down retry policy, breaker isolation,
 * bounded configuration, stable error codes, and observability shape.
 */

const { CircuitBreaker, CircuitBreakerState } = require('../src/utils/circuitBreaker');
const { withRetry } = require('../src/utils/retry');
const {
  KycProviderError,
  KycUpstreamUnavailableError,
  classifyKycError,
  getKycProviderResilienceState,
  parseClampedInt,
  sharedKycBreaker,
  resetKycCircuitBreaker,
} = require('../src/services/kycService');

describe('KYC retry classification contract', () => {
  it.each([
    [408, true], [425, true], [429, true], [500, true], [502, true],
    [503, true], [504, true], [400, false], [401, false], [403, false],
    [404, false], [409, false], [422, false],
  ])('classifies HTTP status %s as retryable=%s', (status, retryable) => {
    expect(classifyKycError({ status })).toMatchObject({ retryable });
  });

  it.each([
    ['ETIMEDOUT', true], ['ECONNRESET', true], ['ECONNREFUSED', true],
    ['EAI_AGAIN', true], ['ENOTFOUND', true], ['ABORT_ERR', true],
    ['EPERM', false], ['EACCES', false], ['EINVAL', false],
  ])('classifies network code %s as retryable=%s', (code, retryable) => {
    expect(classifyKycError({ code })).toMatchObject({ retryable });
  });

  it('classifies timeout names without requiring a Node error code', () => {
    expect(classifyKycError({ name: 'AbortError' })).toEqual({ retryable: true, reason: 'timeout' });
    expect(classifyKycError({ name: 'TimeoutError' })).toEqual({ retryable: true, reason: 'timeout' });
  });

  it('does not retry an already typed permanent provider error', () => {
    const error = new KycProviderError('invalid response', { status: 422, retryable: false, code: 'invalid_request' });
    expect(classifyKycError(error)).toEqual({ retryable: false, reason: 'invalid_request' });
  });

  it('preserves a stable typed fail-fast shape', () => {
    const cause = new Error('provider internals must not cross the boundary');
    const error = new KycUpstreamUnavailableError(cause);
    expect(error).toMatchObject({
      name: 'KycUpstreamUnavailableError',
      code: 'upstream_unavailable',
      status: 503,
      retryable: true,
    });
    expect(error.message).toBe('KYC provider is temporarily unavailable');
    expect(error.cause).toBe(cause);
  });

  it('returns a safe classification for malformed thrown values', () => {
    expect(classifyKycError(null)).toEqual({ retryable: false, reason: 'invalid-error-shape' });
    expect(classifyKycError('provider down')).toEqual({ retryable: false, reason: 'invalid-error-shape' });
    expect(classifyKycError({})).toEqual({ retryable: false, reason: 'non-retryable' });
  });
});

describe('KYC bounded retry contract', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries transient errors and eventually returns the provider result', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('verified');
    const promise = withRetry(operation, {
      maxRetries: 4,
      baseDelay: 10,
      maxDelay: 100,
      shouldRetry: (error) => classifyKycError(error).retryable,
    });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('verified');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent provider failures', async () => {
    const operation = jest.fn().mockRejectedValue({ status: 422, message: 'invalid request' });
    const promise = withRetry(operation, {
      maxRetries: 10,
      baseDelay: 1,
      shouldRetry: (error) => classifyKycError(error).retryable,
    });
    await expect(promise).rejects.toMatchObject({ status: 422 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops after the configured retry bound', async () => {
    const operation = jest.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    const promise = withRetry(operation, {
      maxRetries: 2,
      baseDelay: 5,
      maxDelay: 10,
      shouldRetry: (error) => classifyKycError(error).retryable,
    });
    const assertion = expect(promise).rejects.toThrow('down');
    await jest.runAllTimersAsync();
    await assertion;
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('honors a retry predicate that rejects a non-idempotent operation', async () => {
    const operation = jest.fn().mockRejectedValue(Object.assign(new Error('write uncertain'), { code: 'ETIMEDOUT' }));
    const promise = withRetry(operation, {
      maxRetries: 5,
      shouldRetry: () => false,
    });
    await expect(promise).rejects.toThrow('write uncertain');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('caps invalid retry configuration in the shared helper', async () => {
    const operation = jest.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'ETIMEDOUT' }));
    const promise = withRetry(operation, {
      maxRetries: 1000,
      baseDelay: 100000,
      maxDelay: 100000,
      shouldRetry: () => true,
    });
    const assertion = expect(promise).rejects.toThrow('down');
    // The helper caps attempts at 10; advancing timers proves the promise
    // resolves through the bounded path instead of waiting indefinitely.
    await jest.runAllTimersAsync();
    await assertion;
    expect(operation).toHaveBeenCalledTimes(11);
  });
});

describe('CircuitBreaker dependency isolation and transitions', () => {
  it('opens only the dependency instance whose failures crossed the threshold', async () => {
    const kyc = new CircuitBreaker({ name: 'kyc-test', failureThreshold: 2, recoveryTimeout: 60_000 });
    const email = new CircuitBreaker({ name: 'email-test', failureThreshold: 2, recoveryTimeout: 60_000 });
    await expect(kyc.execute(async () => { throw new Error('kyc down'); })).rejects.toThrow('kyc down');
    await expect(kyc.execute(async () => { throw new Error('kyc down'); })).rejects.toThrow('kyc down');
    expect(kyc.state).toBe(CircuitBreakerState.OPEN);
    expect(email.state).toBe(CircuitBreakerState.CLOSED);
    await expect(email.execute(async () => 'healthy')).resolves.toBe('healthy');
  });

  it('fails fast while open without invoking the operation', async () => {
    const breaker = new CircuitBreaker({ name: 'fail-fast', failureThreshold: 1, recoveryTimeout: 60_000 });
    const operation = jest.fn().mockRejectedValue(new Error('outage'));
    await expect(breaker.execute(operation)).rejects.toThrow('outage');
    operation.mockClear();
    await expect(breaker.execute(operation)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('transitions half-open to closed after a successful probe', async () => {
    const breaker = new CircuitBreaker({ name: 'probe', failureThreshold: 1, recoveryTimeout: 1 });
    await expect(breaker.execute(async () => { throw new Error('first'); })).rejects.toThrow('first');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
    expect(breaker.failureCount).toBe(0);
  });

  it('reopens after a half-open probe fails', async () => {
    const breaker = new CircuitBreaker({ name: 'probe-fails', failureThreshold: 1, recoveryTimeout: 1 });
    await expect(breaker.execute(async () => { throw new Error('first'); })).rejects.toThrow('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(breaker.execute(async () => { throw new Error('still down'); })).rejects.toThrow('still down');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);
  });

  it('supports explicit operational reset', async () => {
    const breaker = new CircuitBreaker({ name: 'reset', failureThreshold: 1, recoveryTimeout: 60_000 });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow('down');
    breaker.reset();
    expect(breaker).toMatchObject({ state: CircuitBreakerState.CLOSED, failureCount: 0 });
    await expect(breaker.execute(async () => 'up')).resolves.toBe('up');
  });

  it('does not count successful calls toward the next failure threshold', async () => {
    const breaker = new CircuitBreaker({ name: 'success-reset', failureThreshold: 3, recoveryTimeout: 60_000 });
    await expect(breaker.execute(async () => { throw new Error('one'); })).rejects.toThrow('one');
    await expect(breaker.execute(async () => 'success')).resolves.toBe('success');
    expect(breaker.failureCount).toBe(0);
    await expect(breaker.execute(async () => { throw new Error('one-again'); })).rejects.toThrow('one-again');
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
  });
});

describe('KYC configuration and operational snapshot', () => {
  afterEach(() => {
    resetKycCircuitBreaker();
  });

  it.each([
    [undefined, 5, 1, 10, 5],
    ['0', 5, 1, 10, 1],
    ['99', 5, 1, 10, 10],
    ['not-a-number', 5, 1, 10, 5],
    ['7', 5, 1, 10, 7],
  ])('clamps raw=%s fallback=%s to %s', (raw, fallback, min, max, expected) => {
    expect(parseClampedInt(raw, fallback, min, max)).toBe(expected);
  });

  it('reports the KYC dependency and only safe breaker fields', () => {
    const state = getKycProviderResilienceState();
    expect(state).toEqual(expect.objectContaining({ dependency: 'kyc-provider', state: 'CLOSED', failureCount: 0 }));
    expect(state).not.toHaveProperty('apiKey');
    expect(state).not.toHaveProperty('secret');
    expect(state).not.toHaveProperty('baseUrl');
  });

  it('reflects a provider failure in the exported snapshot', () => {
    sharedKycBreaker.failureThreshold = 1;
    sharedKycBreaker.reset();
    expect(() => sharedKycBreaker.onFailure(new Error('provider unavailable'))).toThrow('provider unavailable');
    expect(getKycProviderResilienceState()).toMatchObject({ state: 'OPEN', failureCount: 1 });
  });

  it('reset helper closes the shared provider breaker', () => {
    sharedKycBreaker.state = 'OPEN';
    sharedKycBreaker.failureCount = 4;
    resetKycCircuitBreaker();
    expect(getKycProviderResilienceState()).toMatchObject({ state: 'CLOSED', failureCount: 0 });
  });
});
