/**
 * tests/verificationThresholds.concurrency.test.js
 *
 * Regression tests for concurrent execution, idempotent retries,
 * and duplicate work prevention in verificationThresholds config module.
 */

const {
  resolveThresholds,
  VerificationConfigError,
  _resetThresholdCache,
} = require('../src/config/verificationThresholds');

describe('verificationThresholds - concurrency and idempotency', () => {
  beforeEach(() => {
    delete process.env.INVOICE_FRAUD_CEILING;
    delete process.env.INVOICE_MANUAL_REVIEW_THRESHOLD;
    delete process.env.INVOICE_TENANT_THRESHOLDS;
    _resetThresholdCache();
  });

  afterAll(() => {
    delete process.env.INVOICE_FRAUD_CEILING;
    delete process.env.INVOICE_MANUAL_REVIEW_THRESHOLD;
    delete process.env.INVOICE_TENANT_THRESHOLDS;
    _resetThresholdCache();
  });

  it('handles racing requests safely returning the exact same thresholds', async () => {
    process.env.INVOICE_FRAUD_CEILING = '2000000';
    _resetThresholdCache();

    // Create a large number of "concurrent" requests using Promise.all
    const promises = Array.from({ length: 100 }, () => 
      Promise.resolve().then(() => resolveThresholds())
    );

    const results = await Promise.all(promises);
    
    // Verify all results have the correctly parsed values
    results.forEach((result) => {
      expect(result.fraudCeiling).toBe(2000000);
      expect(result.manualReviewThreshold).toBe(1000000); // default
    });
  });

  it('prevents duplicate work and implements idempotent retries on failure', () => {
    // Inject a malformed configuration
    process.env.INVOICE_TENANT_THRESHOLDS = '{ not valid json }';
    _resetThresholdCache();

    // Spy on JSON.parse to ensure we only parse once (prevent duplicate work)
    const jsonParseSpy = jest.spyOn(JSON, 'parse');

    // First attempt should throw and memoize the error
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);
    expect(jsonParseSpy).toHaveBeenCalledTimes(1);

    // Subsequent idempotent retries should throw the exact same error without doing duplicate work
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);

    // The parsing function must not have been called again
    expect(jsonParseSpy).toHaveBeenCalledTimes(1);

    jsonParseSpy.mockRestore();
  });

  it('ensures configuration cache is deeply frozen to prevent unsafe mutations', () => {
    process.env.INVOICE_FRAUD_CEILING = '5000000';
    process.env.INVOICE_TENANT_THRESHOLDS = JSON.stringify({
      acme: { fraudCeiling: 5000000, manualReviewThreshold: 1000 },
    });
    _resetThresholdCache();

    const thresholdsGlobal = resolveThresholds();
    const thresholdsTenant = resolveThresholds('acme');

    // Attempt to mutate the results
    thresholdsGlobal.fraudCeiling = 999;
    thresholdsTenant.fraudCeiling = 999;

    // A fresh resolution should remain unaffected because the internal cache is frozen
    // and returns fresh copies.
    const freshGlobal = resolveThresholds();
    expect(freshGlobal.fraudCeiling).toBe(5000000);

    const freshTenant = resolveThresholds('acme');
    expect(freshTenant.fraudCeiling).toBe(5000000);
  });
});
