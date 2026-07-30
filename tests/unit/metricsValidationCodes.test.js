/**
 * Unit tests for the metrics validation error-code taxonomy.
 *
 * These tests exercise `codeForIssue` against hand-built Zod issue objects so
 * the mapping is pinned independently of any particular Zod version's issue
 * wording. Both the Zod 4 (`origin`) and Zod 3 (`type`) spellings of size
 * issues are covered, because `codeForIssue` supports both.
 */

'use strict';

const {
  METRICS_VALIDATION_CODES,
  METRICS_VALIDATION_ERROR_CODE,
  METRICS_VALIDATION_PROBLEM_TYPE,
  codeForIssue,
} = require('../../src/constants/metricsValidationCodes');

describe('METRICS_VALIDATION_CODES', () => {
  it('is frozen so codes cannot drift at runtime', () => {
    expect(Object.isFrozen(METRICS_VALIDATION_CODES)).toBe(true);
  });

  it('maps every key to itself so codes are self-describing on the wire', () => {
    for (const [key, value] of Object.entries(METRICS_VALIDATION_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('exposes the documented code set', () => {
    expect(Object.keys(METRICS_VALIDATION_CODES).sort()).toEqual(
      [
        'ARRAY_TOO_LARGE',
        'ARRAY_TOO_SMALL',
        'FIELD_FORMAT_INVALID',
        'FIELD_INVALID',
        'FIELD_REQUIRED',
        'FIELD_TOO_LONG',
        'FIELD_TOO_SHORT',
        'FIELD_TYPE_INVALID',
        'UNKNOWN_FIELD',
        'VALUE_ABOVE_MAXIMUM',
        'VALUE_BELOW_MINIMUM',
        'VALUE_NOT_INTEGER',
      ].sort()
    );
  });

  it('exposes a stable top-level code and problem type', () => {
    expect(METRICS_VALIDATION_ERROR_CODE).toBe('METRICS_VALIDATION_ERROR');
    // Unchanged from the pre-hardening wire format.
    expect(METRICS_VALIDATION_PROBLEM_TYPE).toBe(
      'https://liquifact.io/problems/validation-error'
    );
  });
});

describe('codeForIssue', () => {
  describe('missing vs wrongly-typed fields', () => {
    it('maps an absent field to FIELD_REQUIRED via `received`', () => {
      expect(
        codeForIssue({ code: 'invalid_type', received: 'undefined', path: ['userId'] })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_REQUIRED);
    });

    it('maps an absent field to FIELD_REQUIRED via `input` (Zod 4)', () => {
      expect(
        codeForIssue({ code: 'invalid_type', input: undefined, path: ['userId'] })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_REQUIRED);
    });

    it('distinguishes a present-but-wrong-type field as FIELD_TYPE_INVALID', () => {
      expect(
        codeForIssue({ code: 'invalid_type', received: 'number', input: 42, path: ['userId'] })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID);
    });
  });

  describe('unknown fields', () => {
    it('maps unrecognized_keys to UNKNOWN_FIELD', () => {
      expect(
        codeForIssue({ code: 'unrecognized_keys', keys: ['extra'], path: [] })
      ).toBe(METRICS_VALIDATION_CODES.UNKNOWN_FIELD);
    });
  });

  describe('string bounds', () => {
    it('maps a too-short string to FIELD_TOO_SHORT', () => {
      expect(codeForIssue({ code: 'too_small', origin: 'string', path: ['userId'] })).toBe(
        METRICS_VALIDATION_CODES.FIELD_TOO_SHORT
      );
    });

    it('maps an oversized string to FIELD_TOO_LONG', () => {
      expect(codeForIssue({ code: 'too_big', origin: 'string', path: ['userId'] })).toBe(
        METRICS_VALIDATION_CODES.FIELD_TOO_LONG
      );
    });

    it('honours the Zod 3 `type` spelling for strings', () => {
      expect(codeForIssue({ code: 'too_big', type: 'string', path: ['userId'] })).toBe(
        METRICS_VALIDATION_CODES.FIELD_TOO_LONG
      );
    });
  });

  describe('array bounds', () => {
    it('maps an empty array to ARRAY_TOO_SMALL, not FIELD_TOO_SHORT', () => {
      expect(
        codeForIssue({ code: 'too_small', origin: 'array', path: ['operations'] })
      ).toBe(METRICS_VALIDATION_CODES.ARRAY_TOO_SMALL);
    });

    it('maps an over-cap array to ARRAY_TOO_LARGE, not FIELD_TOO_LONG', () => {
      expect(
        codeForIssue({ code: 'too_big', origin: 'array', path: ['operations'] })
      ).toBe(METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE);
    });

    it('honours the Zod 3 `type` spelling for arrays', () => {
      expect(codeForIssue({ code: 'too_big', type: 'array', path: ['operations'] })).toBe(
        METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE
      );
    });

    it('treats sets like arrays', () => {
      expect(codeForIssue({ code: 'too_small', origin: 'set', path: ['x'] })).toBe(
        METRICS_VALIDATION_CODES.ARRAY_TOO_SMALL
      );
    });
  });

  describe('numeric bounds', () => {
    it('maps a below-minimum number to VALUE_BELOW_MINIMUM', () => {
      expect(codeForIssue({ code: 'too_small', origin: 'number', path: ['limit'] })).toBe(
        METRICS_VALIDATION_CODES.VALUE_BELOW_MINIMUM
      );
    });

    it('maps an above-maximum number to VALUE_ABOVE_MAXIMUM', () => {
      expect(codeForIssue({ code: 'too_big', origin: 'number', path: ['limit'] })).toBe(
        METRICS_VALIDATION_CODES.VALUE_ABOVE_MAXIMUM
      );
    });

    it('treats int and bigint origins as numeric', () => {
      expect(codeForIssue({ code: 'too_big', origin: 'int', path: ['limit'] })).toBe(
        METRICS_VALIDATION_CODES.VALUE_ABOVE_MAXIMUM
      );
      expect(codeForIssue({ code: 'too_small', origin: 'bigint', path: ['limit'] })).toBe(
        METRICS_VALIDATION_CODES.VALUE_BELOW_MINIMUM
      );
    });

    it('maps not_multiple_of to VALUE_NOT_INTEGER', () => {
      expect(codeForIssue({ code: 'not_multiple_of', path: ['limit'] })).toBe(
        METRICS_VALIDATION_CODES.VALUE_NOT_INTEGER
      );
    });
  });

  describe('format issues', () => {
    it('maps invalid_format to FIELD_FORMAT_INVALID', () => {
      expect(
        codeForIssue({ code: 'invalid_format', format: 'integer', path: ['limit'] })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID);
    });

    it('maps the Zod 3 invalid_string code to FIELD_FORMAT_INVALID', () => {
      expect(codeForIssue({ code: 'invalid_string', path: ['cursor'] })).toBe(
        METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID
      );
    });
  });

  describe('schema-declared codes', () => {
    it('honours a known code declared via params.metricsCode', () => {
      expect(
        codeForIssue({
          code: 'custom',
          params: { metricsCode: METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID },
          path: ['limit'],
        })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID);
    });

    it('ignores an unknown declared code so typos never reach the wire', () => {
      expect(
        codeForIssue({ code: 'custom', params: { metricsCode: 'NOT_A_REAL_CODE' }, path: ['x'] })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_INVALID);
    });

    it('ignores a non-string declared code', () => {
      expect(
        codeForIssue({ code: 'custom', params: { metricsCode: 42 }, path: ['x'] })
      ).toBe(METRICS_VALIDATION_CODES.FIELD_INVALID);
    });

    it('does not let a declared code mask a genuine size classification', () => {
      expect(
        codeForIssue({ code: 'too_big', origin: 'array', path: ['operations'] })
      ).toBe(METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE);
    });
  });

  describe('fallbacks', () => {
    it('falls back to FIELD_INVALID for an unrecognised issue code', () => {
      expect(codeForIssue({ code: 'some_future_zod_code', path: ['x'] })).toBe(
        METRICS_VALIDATION_CODES.FIELD_INVALID
      );
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'nope'],
      ['a number', 7],
    ])('falls back to FIELD_INVALID for %s', (_label, input) => {
      expect(codeForIssue(input)).toBe(METRICS_VALIDATION_CODES.FIELD_INVALID);
    });

    it('falls back when size origin is unrecognised', () => {
      expect(codeForIssue({ code: 'too_big', origin: 'date', path: ['x'] })).toBe(
        METRICS_VALIDATION_CODES.FIELD_TOO_LONG
      );
    });
  });
});
