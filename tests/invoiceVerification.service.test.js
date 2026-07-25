/**
 * Comprehensive test suite for Invoice Verification Service.
 *
 * Covers fraud checks, business rules, security validations, machine-readable
 * reason codes, configuration-driven thresholds, per-tenant overrides, and
 * invalid-configuration handling across all decision paths.
 */

const { verifyInvoice, ReasonCode } = require('../src/services/invoiceVerification');
const {
  resolveThresholds,
  VerificationConfigError,
  DEFAULT_FRAUD_CEILING,
  DEFAULT_MANUAL_REVIEW_THRESHOLD,
  _resetThresholdCache,
} = require('../src/config/verificationThresholds');

const THRESHOLD_ENV_KEYS = [
  'INVOICE_FRAUD_CEILING',
  'INVOICE_MANUAL_REVIEW_THRESHOLD',
  'INVOICE_TENANT_THRESHOLDS',
];

/** Remove all threshold env vars so each test starts from documented defaults. */
function clearThresholdEnv() {
  for (const key of THRESHOLD_ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearThresholdEnv();
  _resetThresholdCache();
});

afterAll(() => {
  clearThresholdEnv();
  _resetThresholdCache();
});

describe('Invoice Verification Service - Comprehensive Decision Matrix', () => {
  // ============================================================================
  // GROUP 1: VERIFIED (Terminal Success Path)
  // ============================================================================
  describe('VERIFIED - successful invoice passes all checks', () => {
    it('should verify a valid invoice with standard amount', async () => {
      const payload = { amount: 5000, customer: 'Acme Corp' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with minimum valid amount (0.01)', async () => {
      const payload = { amount: 0.01, customer: 'Test Customer' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice just below manual review threshold (999999.99)', async () => {
      const payload = {
        amount: 999999.99,
        customer: 'Large Customer',
      };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with customer name containing spaces and hyphens', async () => {
      const payload = {
        amount: 1500,
        customer: 'Smith & Co - NYC Branch',
      };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with customer name containing numbers', async () => {
      const payload = { amount: 2000, customer: 'Customer123' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should verify invoice with customer name containing periods and commas', async () => {
      const payload = { amount: 3000, customer: 'Inc., LLC. Ltd' };
      const result = await verifyInvoice(payload);
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should require manual review for very large but valid amount (9999999)', async () => {
      const payload = { amount: 9999999, customer: 'Big Corp' };
      const result = await verifyInvoice(payload);
      // 9999999 >= 1000000, so it requires manual review
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
        reasonCode: ReasonCode.MANUAL_REVIEW_REQUIRED,
      });
    });
  });

  // ============================================================================
  // GROUP 2: REJECTED - Invalid Payload Structure
  // ============================================================================
  describe('REJECTED - invalid payload structure', () => {
    it('should reject null payload', async () => {
      const result = await verifyInvoice(null);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
        reasonCode: ReasonCode.INVALID_PAYLOAD,
      });
    });

    it('should reject undefined payload', async () => {
      const result = await verifyInvoice(undefined);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
        reasonCode: ReasonCode.INVALID_PAYLOAD,
      });
    });

    it('should reject string payload', async () => {
      const result = await verifyInvoice('not an object');
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
        reasonCode: ReasonCode.INVALID_PAYLOAD,
      });
    });

    it('should reject number payload', async () => {
      const result = await verifyInvoice(12345);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
        reasonCode: ReasonCode.INVALID_PAYLOAD,
      });
    });

    it('should reject boolean payload', async () => {
      const result = await verifyInvoice(true);
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid payload structure',
        reasonCode: ReasonCode.INVALID_PAYLOAD,
      });
    });

    it('should treat array as object (arrays are typeof "object" in JS)', async () => {
      const result = await verifyInvoice([5000, 'Acme Corp']);
      // Arrays are objects, so payload check passes; then amount check fails
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });
  });

  // ============================================================================
  // GROUP 3: REJECTED - Invalid Amount (Type and Boundary)
  // ============================================================================
  describe('REJECTED - invalid amount validation', () => {
    it('should reject amount as string', async () => {
      const result = await verifyInvoice({
        amount: '5000',
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject amount as boolean', async () => {
      const result = await verifyInvoice({
        amount: true,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject amount as null', async () => {
      const result = await verifyInvoice({
        amount: null,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject amount as array', async () => {
      const result = await verifyInvoice({
        amount: [5000],
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject amount as object', async () => {
      const result = await verifyInvoice({
        amount: { value: 5000 },
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject NaN amount', async () => {
      const result = await verifyInvoice({
        amount: NaN,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject zero amount (boundary)', async () => {
      const result = await verifyInvoice({
        amount: 0,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject negative amount', async () => {
      const result = await verifyInvoice({
        amount: -100,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject very large negative amount', async () => {
      const result = await verifyInvoice({
        amount: -999999999,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject -0 (negative zero)', async () => {
      const result = await verifyInvoice({
        amount: -0,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should reject Infinity (exceeds fraud ceiling)', async () => {
      const result = await verifyInvoice({
        amount: Infinity,
        customer: 'Acme Corp',
      });
      // Infinity is > fraud ceiling, so it fails the ceiling check, not the type check
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
        reasonCode: ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING,
      });
    });

    it('should reject negative Infinity', async () => {
      const result = await verifyInvoice({
        amount: -Infinity,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });
  });

  // ============================================================================
  // GROUP 4: REJECTED - Invalid Customer (Type and Content)
  // ============================================================================
  describe('REJECTED - invalid customer validation', () => {
    it('should reject customer as number', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 12345,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject customer as boolean', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: false,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject customer as null', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: null,
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject customer as array', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: ['Acme', 'Corp'],
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject customer as object', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: { name: 'Acme Corp' },
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject empty customer string', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject whitespace-only customer (spaces)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '   ',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject whitespace-only customer (tabs)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '\t\t',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject whitespace-only customer (newlines)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: '\n\n',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should reject whitespace-only customer (mixed)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: ' \t\n ',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });
  });

  // ============================================================================
  // GROUP 5: REJECTED - Injection Pattern Detection (Security)
  // ============================================================================
  describe('REJECTED - injection pattern security validation', () => {
    const cases = [
      ['HTML injection (<)', 'Acme<Corp'],
      ['HTML closing tag injection (>)', 'Acme>Corp'],
      ['script tag', '<script>alert("xss")</script>'],
      ['curly braces (template injection)', 'Acme{Corp}'],
      ['opening curly brace only', 'Acme{Corp'],
      ['closing curly brace only', 'AcmeCorp}'],
      ['dollar sign (variable injection)', 'Acme$Corp'],
      ['template literal syntax', '`Acme${Corp}`'],
      ['multiple injection patterns', '<Acme$Corp>'],
      ['leading suspicious character', '<Acme'],
      ['trailing suspicious character', 'Acme>'],
    ];

    it.each(cases)('should reject customer with %s', async (_label, customer) => {
      const result = await verifyInvoice({ amount: 5000, customer });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Suspicious characters detected in customer data',
        reasonCode: ReasonCode.SUSPICIOUS_CUSTOMER,
      });
    });
  });

  // ============================================================================
  // GROUP 6: Fraud ceiling (default configuration)
  // ============================================================================
  describe('REJECTED - amount exceeds fraud ceiling (defaults)', () => {
    it('should require manual review exactly at the fraud ceiling (10000000)', async () => {
      const result = await verifyInvoice({
        amount: 10000000,
        customer: 'Acme Corp',
      });
      // 10000000 is not > ceiling, and >= manual-review threshold
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'High value invoice requires manual approval',
        reasonCode: ReasonCode.MANUAL_REVIEW_REQUIRED,
      });
    });

    it('should reject amount just above the fraud ceiling (10000000.01)', async () => {
      const result = await verifyInvoice({
        amount: 10000000.01,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
        reasonCode: ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING,
      });
    });

    it('should reject very large amount (100000000)', async () => {
      const result = await verifyInvoice({
        amount: 100000000,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
        reasonCode: ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING,
      });
    });

    it('should reject amount of 1e10 (scientific notation)', async () => {
      const result = await verifyInvoice({
        amount: 1e10,
        customer: 'Acme Corp',
      });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Amount exceeds maximum allowed threshold',
        reasonCode: ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING,
      });
    });
  });

  // ============================================================================
  // GROUP 7: MANUAL_REVIEW - High Value Invoice (default configuration)
  // ============================================================================
  describe('MANUAL_REVIEW - high value invoice threshold (defaults)', () => {
    const expected = {
      status: 'MANUAL_REVIEW',
      reason: 'High value invoice requires manual approval',
      reasonCode: ReasonCode.MANUAL_REVIEW_REQUIRED,
    };

    it('should require manual review at the manual-review threshold (1000000)', async () => {
      const result = await verifyInvoice({ amount: 1000000, customer: 'Large Corp' });
      expect(result).toEqual(expected);
    });

    it('should require manual review just above the threshold (1000000.01)', async () => {
      const result = await verifyInvoice({ amount: 1000000.01, customer: 'Large Corp' });
      expect(result).toEqual(expected);
    });

    it('should require manual review at mid-range (5000000)', async () => {
      const result = await verifyInvoice({ amount: 5000000, customer: 'Enterprise Corp' });
      expect(result).toEqual(expected);
    });

    it('should require manual review just below the fraud ceiling (9999999.99)', async () => {
      const result = await verifyInvoice({ amount: 9999999.99, customer: 'Mega Corp' });
      expect(result).toEqual(expected);
    });
  });

  // ============================================================================
  // GROUP 8: Order of Validation - Early Exit Behavior
  // ============================================================================
  describe('validation order - early exit on first failure', () => {
    it('should reject invalid payload before checking amount', async () => {
      const result = await verifyInvoice(null);
      expect(result.reasonCode).toBe(ReasonCode.INVALID_PAYLOAD);
    });

    it('should check amount before customer when payload is valid', async () => {
      const result = await verifyInvoice({ amount: 'invalid', customer: null });
      expect(result.reasonCode).toBe(ReasonCode.INVALID_AMOUNT);
    });

    it('should check customer validity before injection patterns', async () => {
      const result = await verifyInvoice({ amount: 5000, customer: null });
      expect(result.reasonCode).toBe(ReasonCode.INVALID_CUSTOMER);
    });

    it('should check fraud ceiling before customer injection', async () => {
      const result = await verifyInvoice({ amount: 15000000, customer: 'Normal<Customer' });
      expect(result.reasonCode).toBe(ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING);
    });

    it('should reach injection check after all other validations pass', async () => {
      const result = await verifyInvoice({ amount: 5000, customer: 'Acme<Corp' });
      expect(result.reasonCode).toBe(ReasonCode.SUSPICIOUS_CUSTOMER);
    });
  });

  // ============================================================================
  // GROUP 9: Edge Cases and Boundary Conditions
  // ============================================================================
  describe('edge cases and boundary conditions', () => {
    it('should handle payload with extra fields gracefully', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Acme Corp',
        extra: 'field',
        another: 123,
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should ignore a tenantId smuggled in the payload (not options)', async () => {
      process.env.INVOICE_TENANT_THRESHOLDS = JSON.stringify({
        evil: { manualReviewThreshold: 1 },
      });
      _resetThresholdCache();
      // Even though the payload carries tenantId, it must NOT influence thresholds.
      const result = await verifyInvoice({ amount: 5000, customer: 'Acme', tenantId: 'evil' });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle explicitly null or undefined options parameter', async () => {
      const resultNull = await verifyInvoice({ amount: 5000, customer: 'Acme Corp' }, null);
      expect(resultNull).toEqual({ status: 'VERIFIED' });

      const resultUndefined = await verifyInvoice({ amount: 5000, customer: 'Acme Corp' }, undefined);
      expect(resultUndefined).toEqual({ status: 'VERIFIED' });
    });

    it('should treat undefined amount field as invalid', async () => {
      const result = await verifyInvoice({ amount: undefined, customer: 'Acme Corp' });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid amount: must be a positive number',
        reasonCode: ReasonCode.INVALID_AMOUNT,
      });
    });

    it('should treat undefined customer field as invalid', async () => {
      const result = await verifyInvoice({ amount: 5000, customer: undefined });
      expect(result).toEqual({
        status: 'REJECTED',
        reason: 'Invalid customer: must be a non-empty string',
        reasonCode: ReasonCode.INVALID_CUSTOMER,
      });
    });

    it('should handle very small positive amount (0.001)', async () => {
      const result = await verifyInvoice({ amount: 0.001, customer: 'Micro Corp' });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle very long customer name', async () => {
      const longName = 'A'.repeat(1000);
      const result = await verifyInvoice({ amount: 5000, customer: longName });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle customer name with international characters', async () => {
      const result = await verifyInvoice({ amount: 5000, customer: 'Société Générale' });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('should handle customer name with special safe characters (@ & # %)', async () => {
      const result = await verifyInvoice({
        amount: 5000,
        customer: 'Company @ Branch & Division #1',
      });
      expect(result).toEqual({ status: 'VERIFIED' });
    });
  });

  // ============================================================================
  // GROUP 10: Integration-Like Scenarios (Multiple Valid Invoices)
  // ============================================================================
  describe('integration scenarios - processing multiple invoices', () => {
    it('should verify batch of valid invoices independently', async () => {
      const invoices = [
        { amount: 100, customer: 'Customer A' },
        { amount: 50000, customer: 'Customer B' },
        { amount: 999999, customer: 'Customer C' },
      ];

      for (const invoice of invoices) {
        const result = await verifyInvoice(invoice);
        expect(result.status).toBe('VERIFIED');
      }
    });

    it('should handle mixed results from batch processing', async () => {
      const invoices = [
        { amount: 5000, customer: 'Valid Corp' }, // VERIFIED
        { amount: 0, customer: 'Invalid Corp' }, // REJECTED
        { amount: 5000000, customer: 'Large Corp' }, // MANUAL_REVIEW
      ];

      const results = await Promise.all(invoices.map((invoice) => verifyInvoice(invoice)));

      expect(results[0].status).toBe('VERIFIED');
      expect(results[1].status).toBe('REJECTED');
      expect(results[2].status).toBe('MANUAL_REVIEW');
    });
  });

  // ============================================================================
  // GROUP 11: Configuration-driven global thresholds
  // ============================================================================
  describe('configuration-driven global thresholds', () => {
    it('applies a custom fraud ceiling from INVOICE_FRAUD_CEILING', async () => {
      process.env.INVOICE_FRAUD_CEILING = '2000000';
      _resetThresholdCache();

      const rejected = await verifyInvoice({ amount: 2000001, customer: 'Acme' });
      expect(rejected.reasonCode).toBe(ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING);

      // At the new ceiling: not rejected, but >= default manual-review threshold.
      const review = await verifyInvoice({ amount: 2000000, customer: 'Acme' });
      expect(review.reasonCode).toBe(ReasonCode.MANUAL_REVIEW_REQUIRED);
    });

    it('applies a custom manual-review threshold from INVOICE_MANUAL_REVIEW_THRESHOLD', async () => {
      process.env.INVOICE_MANUAL_REVIEW_THRESHOLD = '5000';
      _resetThresholdCache();

      const review = await verifyInvoice({ amount: 5000, customer: 'Acme' });
      expect(review.reasonCode).toBe(ReasonCode.MANUAL_REVIEW_REQUIRED);

      const verified = await verifyInvoice({ amount: 4999.99, customer: 'Acme' });
      expect(verified).toEqual({ status: 'VERIFIED' });
    });

    it('tightens both thresholds together', async () => {
      process.env.INVOICE_FRAUD_CEILING = '100000';
      process.env.INVOICE_MANUAL_REVIEW_THRESHOLD = '10000';
      _resetThresholdCache();

      expect((await verifyInvoice({ amount: 9999, customer: 'Acme' })).status).toBe('VERIFIED');
      expect((await verifyInvoice({ amount: 10000, customer: 'Acme' })).reasonCode).toBe(
        ReasonCode.MANUAL_REVIEW_REQUIRED
      );
      expect((await verifyInvoice({ amount: 100001, customer: 'Acme' })).reasonCode).toBe(
        ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING
      );
    });
  });

  // ============================================================================
  // GROUP 12: Per-tenant overrides
  // ============================================================================
  describe('per-tenant threshold overrides', () => {
    beforeEach(() => {
      process.env.INVOICE_TENANT_THRESHOLDS = JSON.stringify({
        'tenant-strict': { fraudCeiling: 50000, manualReviewThreshold: 10000 },
        'tenant-loose': { fraudCeiling: 50000000, manualReviewThreshold: 5000000 },
        'tenant-partial': { manualReviewThreshold: 250000 },
      });
      _resetThresholdCache();
    });

    it('applies a stricter tenant override', async () => {
      const review = await verifyInvoice(
        { amount: 10000, customer: 'Acme' },
        { tenantId: 'tenant-strict' }
      );
      expect(review.reasonCode).toBe(ReasonCode.MANUAL_REVIEW_REQUIRED);

      const rejected = await verifyInvoice(
        { amount: 50001, customer: 'Acme' },
        { tenantId: 'tenant-strict' }
      );
      expect(rejected.reasonCode).toBe(ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING);
    });

    it('applies a looser tenant override', async () => {
      // Amount that defaults would send to manual review is verified for the loose tenant.
      const verified = await verifyInvoice(
        { amount: 4999999, customer: 'Acme' },
        { tenantId: 'tenant-loose' }
      );
      expect(verified).toEqual({ status: 'VERIFIED' });
    });

    it('fills omitted override fields from global defaults (partial override)', async () => {
      // Only manualReviewThreshold overridden; fraudCeiling falls back to default 10000000.
      const review = await verifyInvoice(
        { amount: 250000, customer: 'Acme' },
        { tenantId: 'tenant-partial' }
      );
      expect(review.reasonCode).toBe(ReasonCode.MANUAL_REVIEW_REQUIRED);

      const rejected = await verifyInvoice(
        { amount: 10000001, customer: 'Acme' },
        { tenantId: 'tenant-partial' }
      );
      expect(rejected.reasonCode).toBe(ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING);
    });

    it('falls back to defaults for an unknown tenant', async () => {
      const result = await verifyInvoice(
        { amount: 999999, customer: 'Acme' },
        { tenantId: 'no-such-tenant' }
      );
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('falls back to defaults when no tenantId is supplied', async () => {
      const result = await verifyInvoice({ amount: 999999, customer: 'Acme' });
      expect(result).toEqual({ status: 'VERIFIED' });
    });

    it('does not resolve prototype-pollution keys as tenants', async () => {
      const result = await verifyInvoice(
        { amount: 999999, customer: 'Acme' },
        { tenantId: '__proto__' }
      );
      // Should use defaults (999999 < 1000000 => VERIFIED), not crash or inherit.
      expect(result).toEqual({ status: 'VERIFIED' });
    });
  });

  // ============================================================================
  // GROUP 13: Invalid configuration handling (fail closed)
  // ============================================================================
  describe('invalid configuration handling', () => {
    it('fails closed to MANUAL_REVIEW on a non-numeric fraud ceiling', async () => {
      process.env.INVOICE_FRAUD_CEILING = 'not-a-number';
      _resetThresholdCache();

      const result = await verifyInvoice({ amount: 5000, customer: 'Acme' });
      expect(result).toEqual({
        status: 'MANUAL_REVIEW',
        reason: 'Threshold configuration unavailable; manual review required',
        reasonCode: ReasonCode.CONFIG_UNAVAILABLE,
      });
    });

    it('fails closed when manual-review threshold exceeds the fraud ceiling', async () => {
      process.env.INVOICE_FRAUD_CEILING = '1000';
      process.env.INVOICE_MANUAL_REVIEW_THRESHOLD = '5000';
      _resetThresholdCache();

      const result = await verifyInvoice({ amount: 100, customer: 'Acme' });
      expect(result.reasonCode).toBe(ReasonCode.CONFIG_UNAVAILABLE);
    });

    it('fails closed on malformed tenant override JSON', async () => {
      process.env.INVOICE_TENANT_THRESHOLDS = '{ not valid json';
      _resetThresholdCache();

      const result = await verifyInvoice(
        { amount: 5000, customer: 'Acme' },
        { tenantId: 'tenant-strict' }
      );
      expect(result.reasonCode).toBe(ReasonCode.CONFIG_UNAVAILABLE);
    });

    it('still rejects structurally invalid input before consulting config', async () => {
      process.env.INVOICE_FRAUD_CEILING = 'not-a-number';
      _resetThresholdCache();

      // Structural checks run before threshold resolution, so this is a clean reject.
      const result = await verifyInvoice({ amount: -1, customer: 'Acme' });
      expect(result.reasonCode).toBe(ReasonCode.INVALID_AMOUNT);
    });

    it('propagates non-VerificationConfigError exceptions from threshold resolution', async () => {
      const originalHas = Map.prototype.has;
      Map.prototype.has = function (key) {
        if (key === 'cause-generic-error') {
          throw new TypeError('Generic Map error');
        }
        return originalHas.apply(this, arguments);
      };

      try {
        await expect(
          verifyInvoice({ amount: 5000, customer: 'Acme' }, { tenantId: 'cause-generic-error' })
        ).rejects.toThrow(TypeError);
      } finally {
        Map.prototype.has = originalHas;
      }
    });
  });
});

// ============================================================================
// Configuration module unit tests
// ============================================================================
describe('verificationThresholds config module', () => {
  it('returns documented defaults when no env vars are set', () => {
    const thresholds = resolveThresholds();
    expect(thresholds).toEqual({
      fraudCeiling: DEFAULT_FRAUD_CEILING,
      manualReviewThreshold: DEFAULT_MANUAL_REVIEW_THRESHOLD,
    });
  });

  it('treats empty-string env values as unset and uses defaults', () => {
    process.env.INVOICE_FRAUD_CEILING = '';
    process.env.INVOICE_MANUAL_REVIEW_THRESHOLD = '   ';
    _resetThresholdCache();
    expect(resolveThresholds()).toEqual({
      fraudCeiling: DEFAULT_FRAUD_CEILING,
      manualReviewThreshold: DEFAULT_MANUAL_REVIEW_THRESHOLD,
    });
  });

  it('memoizes parsed config until reset', () => {
    // Keep manual-review threshold low so the custom ceilings stay consistent.
    process.env.INVOICE_MANUAL_REVIEW_THRESHOLD = '100';
    process.env.INVOICE_FRAUD_CEILING = '12345';
    _resetThresholdCache();
    expect(resolveThresholds().fraudCeiling).toBe(12345);

    // Mutating env without resetting must not change the memoized value.
    process.env.INVOICE_FRAUD_CEILING = '999';
    expect(resolveThresholds().fraudCeiling).toBe(12345);

    _resetThresholdCache();
    expect(resolveThresholds().fraudCeiling).toBe(999);
  });

  it('returns a fresh object each call so callers cannot mutate the cache', () => {
    const a = resolveThresholds();
    a.fraudCeiling = 1;
    const b = resolveThresholds();
    expect(b.fraudCeiling).toBe(DEFAULT_FRAUD_CEILING);
  });

  it('throws VerificationConfigError on a zero threshold', () => {
    process.env.INVOICE_MANUAL_REVIEW_THRESHOLD = '0';
    _resetThresholdCache();
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);
  });

  it('throws VerificationConfigError on a negative threshold', () => {
    process.env.INVOICE_FRAUD_CEILING = '-5';
    _resetThresholdCache();
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);
  });

  it('throws when tenant overrides JSON is an array, not an object', () => {
    process.env.INVOICE_TENANT_THRESHOLDS = '[]';
    _resetThresholdCache();
    expect(() => resolveThresholds()).toThrow(VerificationConfigError);
  });

  it('throws when a tenant override is not an object', () => {
    process.env.INVOICE_TENANT_THRESHOLDS = JSON.stringify({ acme: 5 });
    _resetThresholdCache();
    expect(() => resolveThresholds('acme')).toThrow(VerificationConfigError);
  });

  it('throws when a tenant override field is not a positive number', () => {
    process.env.INVOICE_TENANT_THRESHOLDS = JSON.stringify({
      acme: { fraudCeiling: 'huge' },
    });
    _resetThresholdCache();
    expect(() => resolveThresholds('acme')).toThrow(VerificationConfigError);
  });

  it('accepts a numeric tenantId by coercing it to a string key', () => {
    process.env.INVOICE_TENANT_THRESHOLDS = JSON.stringify({
      '42': { manualReviewThreshold: 500 },
    });
    _resetThresholdCache();
    expect(resolveThresholds(42).manualReviewThreshold).toBe(500);
  });
});
