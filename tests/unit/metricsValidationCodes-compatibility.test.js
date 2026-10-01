'use strict';

/**
 * @file tests/unit/metricsValidationCodes-compatibility.test.js
 * @description Unit tests for compatibility contract validation in metricsValidationCodes.js.
 *
 * Tests the runtime validation that ensures the module exports satisfy the
 * compatibility contract (frozen codes, stable values, correct types, etc.).
 */

describe('metricsValidationCodes compatibility contract', () => {
  const {
    METRICS_VALIDATION_CODES,
    METRICS_VALIDATION_ERROR_CODE,
    METRICS_VALIDATION_PROBLEM_TYPE,
    codeForIssue,
    METRICS_VALIDATION_CODES_VERSION,
  } = require('../../src/constants/metricsValidationCodes');

  describe('export stability', () => {
    test('exports METRICS_VALIDATION_CODES', () => {
      expect(METRICS_VALIDATION_CODES).toBeDefined();
    });

    test('exports METRICS_VALIDATION_ERROR_CODE', () => {
      expect(METRICS_VALIDATION_ERROR_CODE).toBeDefined();
    });

    test('exports METRICS_VALIDATION_PROBLEM_TYPE', () => {
      expect(METRICS_VALIDATION_PROBLEM_TYPE).toBeDefined();
    });

    test('exports codeForIssue function', () => {
      expect(codeForIssue).toBeDefined();
      expect(typeof codeForIssue).toBe('function');
    });

    test('exports METRICS_VALIDATION_CODES_VERSION', () => {
      expect(METRICS_VALIDATION_CODES_VERSION).toBeDefined();
      expect(typeof METRICS_VALIDATION_CODES_VERSION).toBe('string');
    });
  });

  describe('code object immutability', () => {
    test('METRICS_VALIDATION_CODES is frozen', () => {
      expect(Object.isFrozen(METRICS_VALIDATION_CODES)).toBe(true);
    });

    test('cannot add new properties to METRICS_VALIDATION_CODES', () => {
      expect(() => {
        METRICS_VALIDATION_CODES.NEW_CODE = 'NEW_CODE';
      }).toThrow();
    });

    test('cannot delete properties from METRICS_VALIDATION_CODES', () => {
      expect(() => {
        delete METRICS_VALIDATION_CODES.FIELD_REQUIRED;
      }).toThrow();
    });

    test('cannot modify existing properties in METRICS_VALIDATION_CODES', () => {
      expect(() => {
        METRICS_VALIDATION_CODES.FIELD_REQUIRED = 'MODIFIED';
      }).toThrow();
    });
  });

  describe('code value stability', () => {
    test('each code value equals its key (self-describing)', () => {
      for (const [key, value] of Object.entries(METRICS_VALIDATION_CODES)) {
        expect(value).toBe(key);
      }
    });

    test('all code values are strings', () => {
      for (const value of Object.values(METRICS_VALIDATION_CODES)) {
        expect(typeof value).toBe('string');
      }
    });

    test('all code values are non-empty', () => {
      for (const value of Object.values(METRICS_VALIDATION_CODES)) {
        expect(value.length).toBeGreaterThan(0);
      }
    });
  });

  describe('top-level constants', () => {
    test('METRICS_VALIDATION_ERROR_CODE is a string', () => {
      expect(typeof METRICS_VALIDATION_ERROR_CODE).toBe('string');
    });

    test('METRICS_VALIDATION_ERROR_CODE is non-empty', () => {
      expect(METRICS_VALIDATION_ERROR_CODE.length).toBeGreaterThan(0);
    });

    test('METRICS_VALIDATION_PROBLEM_TYPE is a string', () => {
      expect(typeof METRICS_VALIDATION_PROBLEM_TYPE).toBe('string');
    });

    test('METRICS_VALIDATION_PROBLEM_TYPE is an HTTPS URI', () => {
      expect(METRICS_VALIDATION_PROBLEM_TYPE).toMatch(/^https:\/\//);
    });

    test('METRICS_VALIDATION_PROBLEM_TYPE contains liquifact.io domain', () => {
      expect(METRICS_VALIDATION_PROBLEM_TYPE).toContain('liquifact.io');
    });
  });

  describe('codeForIssue returns known codes', () => {
    test('returns known code for invalid_type with undefined received', () => {
      const result = codeForIssue({ code: 'invalid_type', received: 'undefined' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for invalid_type with number received', () => {
      const result = codeForIssue({ code: 'invalid_type', received: 'number' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for unrecognized_keys', () => {
      const result = codeForIssue({ code: 'unrecognized_keys', keys: [] });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for too_small string', () => {
      const result = codeForIssue({ code: 'too_small', origin: 'string' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for too_big string', () => {
      const result = codeForIssue({ code: 'too_big', origin: 'string' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for too_small array', () => {
      const result = codeForIssue({ code: 'too_small', origin: 'array' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for too_big array', () => {
      const result = codeForIssue({ code: 'too_big', origin: 'array' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for too_small number', () => {
      const result = codeForIssue({ code: 'too_small', origin: 'number' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for too_big number', () => {
      const result = codeForIssue({ code: 'too_big', origin: 'number' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for not_multiple_of', () => {
      const result = codeForIssue({ code: 'not_multiple_of' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for invalid_format', () => {
      const result = codeForIssue({ code: 'invalid_format' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for unknown issue code', () => {
      const result = codeForIssue({ code: 'some_future_zod_code' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for null issue', () => {
      const result = codeForIssue(null);
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('returns known code for undefined issue', () => {
      const result = codeForIssue(undefined);
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });
  });

  describe('version semantic', () => {
    test('version follows semver format', () => {
      expect(METRICS_VALIDATION_CODES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('version is at least 1.0.0', () => {
      const [major] = METRICS_VALIDATION_CODES_VERSION.split('.').map(Number);
      expect(major).toBeGreaterThanOrEqual(1);
    });
  });

  describe('backward compatibility', () => {
    test('existing codes remain present', () => {
      const expectedCodes = [
        'FIELD_REQUIRED',
        'FIELD_TYPE_INVALID',
        'FIELD_TOO_SHORT',
        'FIELD_TOO_LONG',
        'VALUE_BELOW_MINIMUM',
        'VALUE_ABOVE_MAXIMUM',
        'VALUE_NOT_INTEGER',
        'ARRAY_TOO_SMALL',
        'ARRAY_TOO_LARGE',
        'UNKNOWN_FIELD',
        'FIELD_FORMAT_INVALID',
        'FIELD_INVALID',
      ];

      for (const code of expectedCodes) {
        expect(METRICS_VALIDATION_CODES).toHaveProperty(code);
      }
    });

    test('existing code values remain unchanged', () => {
      expect(METRICS_VALIDATION_CODES.FIELD_REQUIRED).toBe('FIELD_REQUIRED');
      expect(METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID).toBe('FIELD_TYPE_INVALID');
      expect(METRICS_VALIDATION_CODES.FIELD_TOO_SHORT).toBe('FIELD_TOO_SHORT');
      expect(METRICS_VALIDATION_CODES.FIELD_TOO_LONG).toBe('FIELD_TOO_LONG');
      expect(METRICS_VALIDATION_CODES.VALUE_BELOW_MINIMUM).toBe('VALUE_BELOW_MINIMUM');
      expect(METRICS_VALIDATION_CODES.VALUE_ABOVE_MAXIMUM).toBe('VALUE_ABOVE_MAXIMUM');
      expect(METRICS_VALIDATION_CODES.VALUE_NOT_INTEGER).toBe('VALUE_NOT_INTEGER');
      expect(METRICS_VALIDATION_CODES.ARRAY_TOO_SMALL).toBe('ARRAY_TOO_SMALL');
      expect(METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE).toBe('ARRAY_TOO_LARGE');
      expect(METRICS_VALIDATION_CODES.UNKNOWN_FIELD).toBe('UNKNOWN_FIELD');
      expect(METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID).toBe('FIELD_FORMAT_INVALID');
      expect(METRICS_VALIDATION_CODES.FIELD_INVALID).toBe('FIELD_INVALID');
    });

    test('top-level error code remains unchanged', () => {
      expect(METRICS_VALIDATION_ERROR_CODE).toBe('METRICS_VALIDATION_ERROR');
    });

    test('problem type URI remains unchanged', () => {
      expect(METRICS_VALIDATION_PROBLEM_TYPE).toBe(
        'https://liquifact.io/problems/validation-error'
      );
    });
  });

  describe('empty and malformed data handling', () => {
    test('codeForIssue handles empty object', () => {
      const result = codeForIssue({});
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('codeForIssue handles object with missing code', () => {
      const result = codeForIssue({ path: ['field'] });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('codeForIssue handles malformed origin', () => {
      const result = codeForIssue({ code: 'too_big', origin: 'invalid_type' });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('codeForIssue handles array path', () => {
      const result = codeForIssue({ code: 'invalid_type', path: ['operations', '0', 'userId'] });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });

    test('codeForIssue handles empty path', () => {
      const result = codeForIssue({ code: 'invalid_type', path: [] });
      expect(Object.values(METRICS_VALIDATION_CODES)).toContain(result);
    });
  });
});
