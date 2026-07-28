'use strict';

const kycWebhooksConstants = require('../../src/constants/kycWebhooks');
const {
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_EVENTS,
  KYC_STATUSES,
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
    expect(KYC_WEBHOOK_PAGINATION.SORT_FIELD).toBe('updated_at');
    expect(KYC_WEBHOOK_METRICS.STATUS_CLASS_2XX).toBe('2xx');
  });
});
