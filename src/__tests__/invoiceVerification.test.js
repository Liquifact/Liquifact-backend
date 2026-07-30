const { verifyInvoice, ReasonCode } = require('../services/invoiceVerification');

describe('Invoice Verification Service', () => {
  it('should verify a valid invoice', async () => {
    const payload = { amount: 5000, customer: 'Acme Corp' };
    const result = await verifyInvoice(payload);
    expect(result).toEqual({ status: 'VERIFIED' });
  });

  it('should reject if payload is not an object', async () => {
    const result = await verifyInvoice(null);
    expect(result).toEqual({
      status: 'REJECTED',
      reason: 'Invalid payload structure',
      reasonCode: ReasonCode.INVALID_PAYLOAD,
    });

    const result2 = await verifyInvoice('string');
    expect(result2).toEqual({
      status: 'REJECTED',
      reason: 'Invalid payload structure',
      reasonCode: ReasonCode.INVALID_PAYLOAD,
    });
  });

  it('should reject invalid amount types', async () => {
    const result = await verifyInvoice({ amount: '5000', customer: 'Acme Corp' });
    expect(result).toEqual({
      status: 'REJECTED',
      reason: 'Invalid amount: must be a positive number',
      reasonCode: ReasonCode.INVALID_AMOUNT,
    });
  });

  it('should reject zero or negative amounts', async () => {
    const resultZero = await verifyInvoice({ amount: 0, customer: 'Acme Corp' });
    expect(resultZero).toEqual({
      status: 'REJECTED',
      reason: 'Invalid amount: must be a positive number',
      reasonCode: ReasonCode.INVALID_AMOUNT,
    });

    const resultNegative = await verifyInvoice({ amount: -100, customer: 'Acme Corp' });
    expect(resultNegative).toEqual({
      status: 'REJECTED',
      reason: 'Invalid amount: must be a positive number',
      reasonCode: ReasonCode.INVALID_AMOUNT,
    });
  });

  it('should reject invalid customer types', async () => {
    const result = await verifyInvoice({ amount: 5000, customer: 12345 });
    expect(result).toEqual({
      status: 'REJECTED',
      reason: 'Invalid customer: must be a non-empty string',
      reasonCode: ReasonCode.INVALID_CUSTOMER,
    });
  });

  it('should reject empty customer string', async () => {
    const result = await verifyInvoice({ amount: 5000, customer: '   ' });
    expect(result).toEqual({
      status: 'REJECTED',
      reason: 'Invalid customer: must be a non-empty string',
      reasonCode: ReasonCode.INVALID_CUSTOMER,
    });
  });

  it('should reject an amount exceeding the maximum allowed threshold', async () => {
    const result = await verifyInvoice({ amount: 15000000, customer: 'Acme Corp' });
    expect(result).toEqual({
      status: 'REJECTED',
      reason: 'Amount exceeds maximum allowed threshold',
      reasonCode: ReasonCode.AMOUNT_EXCEEDS_FRAUD_CEILING,
    });
  });

  it('should require manual review for high value invoices', async () => {
    const result = await verifyInvoice({ amount: 1500000, customer: 'Acme Corp' });
    expect(result).toEqual({
      status: 'MANUAL_REVIEW',
      reason: 'High value invoice requires manual approval',
      reasonCode: ReasonCode.MANUAL_REVIEW_REQUIRED,
    });
  });

  it('should reject customers with suspicious characters (XSS/Injection)', async () => {
    const result = await verifyInvoice({ amount: 5000, customer: 'Acme <script>' });
    expect(result).toEqual({
      status: 'REJECTED',
      reason: 'Suspicious characters detected in customer data',
      reasonCode: ReasonCode.SUSPICIOUS_CUSTOMER,
    });
  });
});
