'use strict';

/**
 * Regression tests: codeForIssue against issues produced by the installed Zod,
 * not hand-built objects. Real Zod 4 issues carry neither `received` nor
 * `input`, which previously made every invalid_type look like FIELD_REQUIRED.
 */

const { z } = require('zod');
const {
  METRICS_VALIDATION_CODES: CODES,
  codeForIssue,
} = require('../../src/constants/metricsValidationCodes');

/**
 * Parses a value and returns the code for the first issue.
 *
 * @param {import('zod').ZodTypeAny} schema - Schema under test.
 * @param {unknown} value - Value to parse.
 * @returns {string} The mapped validation code.
 */
function firstCode(schema, value) {
  const result = schema.safeParse(value);
  return codeForIssue(result.error.issues[0], value);
}

describe('codeForIssue with real Zod issues', () => {
  const schema = z.object({ a: z.string() });

  it('reports an absent field as FIELD_REQUIRED', () => {
    expect(firstCode(schema, {})).toBe(CODES.FIELD_REQUIRED);
  });

  it('reports an explicit undefined as FIELD_REQUIRED', () => {
    expect(firstCode(schema, { a: undefined })).toBe(CODES.FIELD_REQUIRED);
  });

  it('reports a wrong-type value as FIELD_TYPE_INVALID', () => {
    expect(firstCode(schema, { a: 1 })).toBe(CODES.FIELD_TYPE_INVALID);
  });

  it('reports null as FIELD_TYPE_INVALID, not FIELD_REQUIRED', () => {
    expect(firstCode(schema, { a: null })).toBe(CODES.FIELD_TYPE_INVALID);
  });
});
