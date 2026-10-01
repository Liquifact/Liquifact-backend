'use strict';

const kycWebhooksConstants = require('../../src/constants/kycWebhooks');
const {
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_EVENTS,
  KYC_STATUSES,
  KYC_WEBHOOK_VALIDATION,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_PAGINATION,
  KYC_WEBHOOK_METRICS,
  KYC_WEBHOOK_CONSTANTS,
} = kycWebhooksConstants;

describe('src/constants/kycWebhooks.js', () => {
  it('exports all expected constant categories and master object', () => {
    expect(KYC_WEBHOOK_CONSTANTS).toBeDefined();
    expect(HTTP_HEADERS).toBeDefined();
    expect(KYC_WEBHOOK_ROUTES).toBeDefined();
    expect(KYC_WEBHOOK_EVENTS).toBeDefined();
    expect(KYC_STATUSES).toBeDefined();
    expect(KYC_WEBHOOK_VALIDATION).toBeDefined();
    expect(KYC_WEBHOOK_ERROR_CODES).toBeDefined();
    expect(KYC_WEBHOOK_MESSAGES).toBeDefined();
    expect(KYC_WEBHOOK_DB).toBeDefined();
    expect(KYC_WEBHOOK_PAGINATION).toBeDefined();
    expect(KYC_WEBHOOK_METRICS).toBeDefined();
  });

  it('ensures all exported constant groups are deeply frozen (Object.isFrozen)', () => {
    expect(Object.isFrozen(kycWebhooksConstants)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_CONSTANTS)).toBe(true);
    expect(Object.isFrozen(HTTP_HEADERS)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_ROUTES)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_EVENTS)).toBe(true);
    expect(Object.isFrozen(KYC_STATUSES)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_VALIDATION)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS)).toBe(true);
    expect(typeof KYC_WEBHOOK_VALIDATION.SME_ID_PATTERN).toBe('string');
    expect(typeof KYC_WEBHOOK_VALIDATION.IDEMPOTENCY_KEY_PATTERN).toBe('string');
    expect(Object.isFrozen(KYC_WEBHOOK_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_MESSAGES)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_DB)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_PAGINATION)).toBe(true);
    expect(Object.isFrozen(KYC_WEBHOOK_METRICS)).toBe(true);
  });

  it('prevents runtime mutation attempts (strict mode throws)', () => {
    expect(() => {
      HTTP_HEADERS.X_SIGNATURE = 'MUTATED';
    }).toThrow(TypeError);

    expect(() => {
      KYC_WEBHOOK_EVENTS.VERIFIED = 'MUTATED';
    }).toThrow(TypeError);

    expect(() => {
      KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET = 'MUTATED';
    }).toThrow(TypeError);
  });

  it('maintains exact literal values for key constants', () => {
    expect(HTTP_HEADERS.X_SIGNATURE).toBe('X-Signature');
    expect(HTTP_HEADERS.IDEMPOTENCY_KEY).toBe('Idempotency-Key');
    expect(KYC_WEBHOOK_ROUTES.WEBHOOK).toBe('/webhook');
    expect(KYC_WEBHOOK_EVENTS.VERIFIED).toBe('kyc.verified');
    expect(KYC_STATUSES.PENDING).toBe('pending');
    expect(KYC_STATUSES.UNKNOWN).toBe('unknown');
    expect(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET).toBe('missing_secret');
    expect(KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS).toBe('unknown_status');
    expect(KYC_WEBHOOK_MESSAGES.MISSING_SECRET).toBe('KYC webhook ingestion is not configured');
    expect(KYC_WEBHOOK_DB.TABLE_KYC_RECORDS).toBe('kyc_records');
    expect(KYC_WEBHOOK_DB.JOB_TYPE_DELIVERY).toBe('kyc_webhook_delivery');
    expect(KYC_WEBHOOK_PAGINATION.MAX_LIMIT).toBe(100);
    expect(KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT).toBe(20);
    expect(KYC_WEBHOOK_PAGINATION.MIN_LIMIT).toBe(1);
    expect(KYC_WEBHOOK_PAGINATION.MIN_OFFSET).toBe(0);
    expect(KYC_WEBHOOK_PAGINATION.MAX_OFFSET).toBe(Number.MAX_SAFE_INTEGER);
    expect(KYC_WEBHOOK_PAGINATION.SORT_FIELD).toBe('updated_at');
    expect(KYC_WEBHOOK_METRICS.STATUS_CLASS_2XX).toBe('2xx');
  });

  it('defines explicit payload, idempotency, and request-size boundaries', () => {
    expect(KYC_WEBHOOK_VALIDATION).toMatchObject({
      SME_ID_MIN_LENGTH: 1,
      SME_ID_MAX_LENGTH: 128,
      STATUS_MIN_LENGTH: 1,
      STATUS_MAX_LENGTH: 50,
      RECORD_ID_MAX_LENGTH: 255,
      IDEMPOTENCY_KEY_MIN_LENGTH: 8,
      IDEMPOTENCY_KEY_MAX_LENGTH: 128,
      MAX_PAYLOAD_BYTES: 102_400,
    });
    expect(KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS).toEqual([
      'kyc.verified',
      'kyc.rejected',
      'kyc.exempted',
      'kyc.pending',
      'kyc_status_updated',
      'kyc.status_changed',
    ]);
    const idempotencyPattern = new RegExp(KYC_WEBHOOK_VALIDATION.IDEMPOTENCY_KEY_PATTERN);
    expect(idempotencyPattern.test('12345678')).toBe(true);
    expect(idempotencyPattern.test('bad key!')).toBe(false);
  });
});
