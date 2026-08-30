'use strict';

/**
 * @fileoverview Unit tests for src/utils/telemetryRedaction.js.
 *
 * Every edge case listed in issue #1200 is covered directly here:
 *  - nested identity field
 *  - provider error string contains a document number
 *  - large binary-like value
 *  - null and malformed error objects
 *  - redaction preserves correlation IDs
 */

const {
  MAX_TELEMETRY_STRING_LENGTH,
  MAX_REDACTION_DEPTH,
  IDENTITY_FIELD_PATTERNS,
  sanitizeTelemetryString,
  redactForTelemetry,
  redactErrorForTelemetry,
} = require('../src/utils/telemetryRedaction');

const REDACTED = '***REDACTED***';

describe('sanitizeTelemetryString', () => {
  it('passes non-string values through unchanged', () => {
    expect(sanitizeTelemetryString(42)).toBe(42);
    expect(sanitizeTelemetryString(true)).toBe(true);
    expect(sanitizeTelemetryString(null)).toBeNull();
    expect(sanitizeTelemetryString(undefined)).toBeUndefined();
    expect(sanitizeTelemetryString({ a: 1 })).toEqual({ a: 1 });
  });

  it('leaves an ordinary short string untouched', () => {
    expect(sanitizeTelemetryString('pending')).toBe('pending');
    expect(sanitizeTelemetryString('KYC provider responded with HTTP 503')).toBe('KYC provider responded with HTTP 503');
  });

  describe('edge case: provider error string contains a document number', () => {
    it('redacts a bare long-digit-run document number embedded in prose', () => {
      const result = sanitizeTelemetryString('Rejected: document number 987654321 is invalid');
      expect(result).not.toContain('987654321');
      expect(result).toBe(`Rejected: document number ${REDACTED} is invalid`);
    });

    it('redacts an SSN-shaped substring embedded in prose', () => {
      const result = sanitizeTelemetryString('Applicant SSN 123-45-6789 failed verification');
      expect(result).not.toContain('123-45-6789');
      expect(result).toContain(REDACTED);
    });

    it('redacts an email address embedded in prose', () => {
      const result = sanitizeTelemetryString('Notify jane.doe@example.com about the rejection');
      expect(result).not.toContain('jane.doe@example.com');
      expect(result).toContain(REDACTED);
    });

    it('redacts multiple embedded identifiers in the same string', () => {
      const result = sanitizeTelemetryString('doc 111222333 and SSN 123-45-6789 both flagged');
      expect(result).not.toContain('111222333');
      expect(result).not.toContain('123-45-6789');
    });

    it('does not redact short numbers that are not document-shaped (status codes, counts)', () => {
      expect(sanitizeTelemetryString('HTTP 503')).toBe('HTTP 503');
      expect(sanitizeTelemetryString('retry 3 of 5')).toBe('retry 3 of 5');
      expect(sanitizeTelemetryString('year 2026')).toBe('year 2026');
    });
  });

  describe('edge case: large binary-like value', () => {
    it('replaces a string over the max length with a bounded placeholder', () => {
      const huge = 'A'.repeat(MAX_TELEMETRY_STRING_LENGTH + 1);
      const result = sanitizeTelemetryString(huge);
      expect(result).toBe(`[REDACTED:large-value length=${huge.length}]`);
      expect(result.length).toBeLessThan(huge.length);
      expect(result).not.toContain('A'.repeat(50));
    });

    it('replaces a base64-shaped blob over the max length', () => {
      const blob = Buffer.from('x'.repeat(1000)).toString('base64');
      const result = sanitizeTelemetryString(blob);
      expect(result).toMatch(/^\[REDACTED:large-value length=\d+\]$/);
    });

    it('leaves a string exactly at the max length untouched (boundary)', () => {
      const atLimit = 'b'.repeat(MAX_TELEMETRY_STRING_LENGTH);
      expect(sanitizeTelemetryString(atLimit)).toBe(atLimit);
    });

    it('truncates rather than attempting to scrub inside an oversized value', () => {
      const huge = `ssn 123-45-6789 ${'z'.repeat(MAX_TELEMETRY_STRING_LENGTH)}`;
      const result = sanitizeTelemetryString(huge);
      expect(result).not.toContain('123-45-6789');
      expect(result).toMatch(/^\[REDACTED:large-value/);
    });
  });
});

describe('redactForTelemetry', () => {
  describe('edge case: nested identity field', () => {
    it('redacts an identity field nested inside a plain object', () => {
      const input = { smeId: 'sme_1', applicant: { dob: '1990-01-01' } };
      const result = redactForTelemetry(input);
      expect(result.applicant.dob).toBe(REDACTED);
      expect(result.smeId).toBe('sme_1');
    });

    it('redacts an identity field nested multiple levels deep', () => {
      const input = { level1: { level2: { level3: { ssn: '123-45-6789' } } } };
      const result = redactForTelemetry(input);
      expect(result.level1.level2.level3.ssn).toBe(REDACTED);
    });

    it('redacts identity fields nested inside an array of objects', () => {
      const input = { applicants: [{ firstName: 'Jane' }, { lastName: 'Doe' }] };
      const result = redactForTelemetry(input);
      expect(result.applicants[0].firstName).toBe(REDACTED);
      expect(result.applicants[1].lastName).toBe(REDACTED);
    });

    it.each([
      'ssn', 'socialSecurityNumber', 'dateOfBirth', 'dob', 'documentNumber',
      'passportNumber', 'driverLicense', 'driversLicenseNumber', 'nationalId',
      'taxId', 'cardNumber', 'cvv', 'cvc', 'bankAccountNumber', 'accountNumber',
      'routingNumber', 'iban', 'fullName', 'firstName', 'lastName', 'middleName',
      'email', 'phone', 'streetAddress', 'mailingAddress', 'homeAddress',
      'postalCode', 'zipCode',
    ])('redacts the identity field "%s"', (field) => {
      const result = redactForTelemetry({ [field]: 'sensitive-value' });
      expect(result[field]).toBe(REDACTED);
    });

    it('does NOT redact a bare "address" field (reserved for blockchain addresses in this codebase)', () => {
      const result = redactForTelemetry({ contractAddress: 'GABC123', escrowAddress: 'GXYZ789' });
      expect(result.contractAddress).toBe('GABC123');
      expect(result.escrowAddress).toBe('GXYZ789');
    });
  });

  it('scrubs identifier-shaped substrings inside string leaves that survive key-name redaction', () => {
    const result = redactForTelemetry({ reason: 'document 987654321 rejected' });
    expect(result.reason).not.toContain('987654321');
  });

  describe('edge case: redaction preserves correlation IDs', () => {
    it('leaves correlationId, requestId, smeId, tenantId, code, status, retryable untouched', () => {
      const input = {
        correlationId: 'corr-abc-123',
        requestId: 'req-abc-123',
        smeId: 'sme_9f8e7d',
        tenantId: 'tenant-42',
        code: 'upstream_unavailable',
        status: 503,
        retryable: true,
      };
      expect(redactForTelemetry(input)).toEqual(input);
    });

    it('preserves correlationId even alongside a sibling identity field that IS redacted', () => {
      const input = { correlationId: 'corr-1', applicant: { ssn: '123-45-6789' } };
      const result = redactForTelemetry(input);
      expect(result.correlationId).toBe('corr-1');
      expect(result.applicant.ssn).toBe(REDACTED);
    });
  });

  describe('edge case: null and malformed error objects', () => {
    it('passes null and undefined through unchanged', () => {
      expect(redactForTelemetry(null)).toBeNull();
      expect(redactForTelemetry(undefined)).toBeUndefined();
    });

    it('handles a plain object with no recognisable error shape without throwing', () => {
      expect(() => redactForTelemetry({ weird: 'shape' })).not.toThrow();
      expect(redactForTelemetry({ weird: 'shape' })).toEqual({ weird: 'shape' });
    });

    it('handles a malformed error-like object (message is not a string) without throwing', () => {
      expect(() => redactForTelemetry({ message: 123, code: null })).not.toThrow();
    });

    it('handles primitives without throwing', () => {
      expect(redactForTelemetry(42)).toBe(42);
      expect(redactForTelemetry(true)).toBe(true);
      expect(redactForTelemetry('a string')).toBe('a string');
    });

    it('handles an empty object and empty array without throwing', () => {
      expect(redactForTelemetry({})).toEqual({});
      expect(redactForTelemetry([])).toEqual([]);
    });
  });

  it('terminates on a deeply nested / circular object rather than looping forever', () => {
    const circular = {};
    circular.self = circular;
    expect(() => redactForTelemetry(circular)).not.toThrow();
  });

  it('bounds recursion depth on a very deep (non-circular) object', () => {
    let deep = { ssn: '123-45-6789' };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 10; i += 1) {
      deep = { nested: deep };
    }
    expect(() => redactForTelemetry(deep)).not.toThrow();
  });
});

describe('redactErrorForTelemetry', () => {
  describe('edge case: null and malformed error objects', () => {
    it('passes null and undefined through unchanged', () => {
      expect(redactErrorForTelemetry(null)).toBeNull();
      expect(redactErrorForTelemetry(undefined)).toBeUndefined();
    });

    it('handles a non-Error value with an Error-like shape without throwing', () => {
      const fake = { name: 'FakeError', message: 'looks like an error' };
      expect(() => redactErrorForTelemetry(fake)).not.toThrow();
    });

    it('handles a thrown string (not an Error instance) without throwing', () => {
      expect(() => redactErrorForTelemetry('just a string')).not.toThrow();
      expect(redactErrorForTelemetry('a string with ssn 123-45-6789')).not.toContain('123-45-6789');
    });

    it('handles an Error subclass whose message was reassigned to a non-string', () => {
      const err = new Error('original');
      err.message = 12345;
      expect(() => redactErrorForTelemetry(err)).not.toThrow();
    });
  });

  it('extracts name, message, code, status, retryable from a real Error', () => {
    const err = Object.assign(new Error('KYC provider responded with HTTP 503'), {
      name: 'KycProviderError',
      code: 'status:503',
      status: 503,
      retryable: true,
    });
    expect(redactErrorForTelemetry(err)).toEqual({
      name: 'KycProviderError',
      message: 'KYC provider responded with HTTP 503',
      code: 'status:503',
      status: 503,
      retryable: true,
    });
  });

  it('does not carry over unknown own-properties beyond the allowlisted fields', () => {
    const err = Object.assign(new Error('boom'), { applicantData: { ssn: '123-45-6789' } });
    const result = redactErrorForTelemetry(err);
    expect(result).not.toHaveProperty('applicantData');
  });

  it('redacts a document number embedded in the error message', () => {
    const err = new Error('Provider rejected document 987654321');
    const result = redactErrorForTelemetry(err);
    expect(result.message).not.toContain('987654321');
  });

  it('recursively redacts a nested cause chain', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const outer = new Error('KYC provider request failed: connect ECONNREFUSED');
    outer.cause = inner;
    outer.code = 'network:ECONNREFUSED';
    outer.retryable = true;

    const result = redactErrorForTelemetry(outer);
    expect(result.cause).toEqual({ name: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' });
  });

  it('redacts identity data embedded in a nested cause message', () => {
    const inner = new Error('applicant SSN 123-45-6789 rejected upstream');
    const outer = new Error('KYC provider request failed');
    outer.cause = inner;

    const result = redactErrorForTelemetry(outer);
    expect(result.cause.message).not.toContain('123-45-6789');
  });

  it('bounds a circular cause chain rather than recursing forever', () => {
    const errA = new Error('a');
    const errB = new Error('b');
    errA.cause = errB;
    errB.cause = errA;

    expect(() => redactErrorForTelemetry(errA)).not.toThrow();
    const result = JSON.stringify(redactErrorForTelemetry(errA));
    expect(result).toContain('cause-depth-exceeded');
  });

  it('omits optional fields the source error does not have, rather than emitting undefined', () => {
    const err = new Error('plain error, no extras');
    const result = redactErrorForTelemetry(err);
    expect(result).toEqual({ name: 'Error', message: 'plain error, no extras' });
    expect(Object.keys(result)).toEqual(['name', 'message']);
  });
});

describe('IDENTITY_FIELD_PATTERNS', () => {
  it('is a non-empty, frozen array of RegExp', () => {
    expect(Array.isArray(IDENTITY_FIELD_PATTERNS)).toBe(true);
    expect(IDENTITY_FIELD_PATTERNS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(IDENTITY_FIELD_PATTERNS)).toBe(true);
    for (const pattern of IDENTITY_FIELD_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});
