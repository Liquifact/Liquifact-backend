'use strict';

/**
 * Regression tests: parseValidationFieldCodes classifies missing vs wrong-type
 * fields correctly when given the original payload. Real Zod 4 issues carry no
 * `received`/`input`, so the payload is the only reliable "was it absent" signal.
 */

const { z } = require('zod');
const { parseValidationFieldCodes } = require('../../src/schemas/metrics');
const { METRICS_VALIDATION_CODES: CODES } = require('../../src/constants/metricsValidationCodes');

/**
 * Runs a schema over a payload and returns the mapped field codes.
 *
 * @param {import('zod').ZodTypeAny} schema - Schema under test.
 * @param {unknown} payload - Payload to validate.
 * @returns {Object<string, string[]>} Field-keyed validation codes.
 */
function fieldCodesFor(schema, payload) {
  const result = schema.safeParse(payload);
  return parseValidationFieldCodes(result.error, payload);
}

describe('parseValidationFieldCodes: flat fields', () => {
  const flat = z.object({ limit: z.number(), name: z.string() });

  it('reports a wrong-type value as FIELD_TYPE_INVALID', () => {
    expect(fieldCodesFor(flat, { limit: 'abc', name: 'x' }).limit).toEqual([
      CODES.FIELD_TYPE_INVALID,
    ]);
  });

  it('reports an absent field as FIELD_REQUIRED', () => {
    expect(fieldCodesFor(flat, { name: 'x' }).limit).toEqual([CODES.FIELD_REQUIRED]);
  });

  it('reports null as FIELD_TYPE_INVALID', () => {
    expect(fieldCodesFor(flat, { limit: null, name: 'x' }).limit).toEqual([
      CODES.FIELD_TYPE_INVALID,
    ]);
  });

  it('classifies each field independently in one payload', () => {
    expect(fieldCodesFor(flat, { limit: 'abc' })).toEqual({
      limit: [CODES.FIELD_TYPE_INVALID],
      name: [CODES.FIELD_REQUIRED],
    });
  });
});

describe('parseValidationFieldCodes: nested and non-object payloads', () => {
  it('resolves nested array paths against the payload', () => {
    const nested = z.object({ operations: z.array(z.object({ userId: z.string() })) });
    expect(fieldCodesFor(nested, { operations: [{ userId: 1 }, {}] })).toEqual({
      'operations.0.userId': [CODES.FIELD_TYPE_INVALID],
      'operations.1.userId': [CODES.FIELD_REQUIRED],
    });
  });

  it('treats a non-object payload as a type error, not a missing field', () => {
    const schema = z.object({ a: z.string() });
    expect(fieldCodesFor(schema, 'nope')['']).toEqual([CODES.FIELD_TYPE_INVALID]);
  });
});
