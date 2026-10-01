'use strict';

/**
 * Boundary tests for the bulk metrics request schema and its machine-readable
 * validation codes: accepted extremes, rejected extremes, missing vs wrong-type
 * fields, unknown keys, non-object bodies and determinism.
 */

const {
  bulkMetricsSchema,
  parseValidationFieldCodes,
  MAX_BULK_OPERATIONS,
} = require('../../src/schemas/metrics');
const { METRICS_VALIDATION_CODES: CODES } = require('../../src/constants/metricsValidationCodes');

/** Mirrors BULK_METRICS_ID_MAX_LENGTH in src/schemas/metrics.js (not exported). */
const ID_MAX = 128;

/**
 * Builds one valid bulk operation, with optional field overrides.
 *
 * @param {object} [overrides] - Fields to replace on the valid operation.
 * @returns {object} An operation payload.
 */
function op(overrides = {}) {
  return { tenantId: 't1', userId: 'u1', ...overrides };
}

/**
 * Validates a body and returns its field codes, or null when it is valid.
 *
 * @param {unknown} body - Candidate request body.
 * @returns {Object<string, string[]>|null} Field-keyed codes, or null on success.
 */
function codesFor(body) {
  const result = bulkMetricsSchema.safeParse(body);
  if (result.success) {
    return null;
  }
  return parseValidationFieldCodes(result.error, body);
}

describe('operations array bounds', () => {
  it('accepts exactly MAX_BULK_OPERATIONS operations', () => {
    const body = { operations: Array.from({ length: MAX_BULK_OPERATIONS }, () => op()) };
    expect(codesFor(body)).toBeNull();
  });

  it('rejects one more than the cap as ARRAY_TOO_LARGE', () => {
    const body = { operations: Array.from({ length: MAX_BULK_OPERATIONS + 1 }, () => op()) };
    expect(codesFor(body).operations).toEqual([CODES.ARRAY_TOO_LARGE]);
  });

  it('rejects an empty array as ARRAY_TOO_SMALL', () => {
    expect(codesFor({ operations: [] }).operations).toEqual([CODES.ARRAY_TOO_SMALL]);
  });

  it('rejects a missing operations field as FIELD_REQUIRED', () => {
    expect(codesFor({}).operations).toEqual([CODES.FIELD_REQUIRED]);
  });

  it.each([
    ['a string', 'x'],
    ['null', null],
    ['an object', {}],
  ])('rejects operations given as %s as FIELD_TYPE_INVALID', (_label, value) => {
    expect(codesFor({ operations: value }).operations).toEqual([CODES.FIELD_TYPE_INVALID]);
  });
});

describe('tenantId / userId string bounds', () => {
  it.each(['tenantId', 'userId'])('accepts %s at 1 and at the maximum length', (field) => {
    expect(codesFor({ operations: [op({ [field]: 'a' })] })).toBeNull();
    expect(codesFor({ operations: [op({ [field]: 'a'.repeat(ID_MAX) })] })).toBeNull();
  });

  it.each(['tenantId', 'userId'])('rejects %s one over the maximum as FIELD_TOO_LONG', (field) => {
    const codes = codesFor({ operations: [op({ [field]: 'a'.repeat(ID_MAX + 1) })] });
    expect(codes[`operations.0.${field}`]).toEqual([CODES.FIELD_TOO_LONG]);
  });

  it.each(['tenantId', 'userId'])('rejects an empty %s as FIELD_TOO_SHORT', (field) => {
    const codes = codesFor({ operations: [op({ [field]: '' })] });
    expect(codes[`operations.0.${field}`]).toEqual([CODES.FIELD_TOO_SHORT]);
  });

  it.each(['tenantId', 'userId'])('rejects a whitespace-only %s as FIELD_TOO_SHORT', (field) => {
    const codes = codesFor({ operations: [op({ [field]: '   ' })] });
    expect(codes[`operations.0.${field}`]).toEqual([CODES.FIELD_TOO_SHORT]);
  });
});

describe('missing vs wrong-type ids', () => {
  it.each([
    ['a number', 42],
    ['null', null],
    ['a boolean', true],
    ['an array', []],
  ])('rejects tenantId given as %s as FIELD_TYPE_INVALID', (_label, value) => {
    const codes = codesFor({ operations: [op({ tenantId: value })] });
    expect(codes['operations.0.tenantId']).toEqual([CODES.FIELD_TYPE_INVALID]);
  });

  it('rejects an absent userId as FIELD_REQUIRED', () => {
    const codes = codesFor({ operations: [{ tenantId: 't1' }] });
    expect(codes['operations.0.userId']).toEqual([CODES.FIELD_REQUIRED]);
  });

  it('reports each failing field and operation independently', () => {
    const codes = codesFor({
      operations: [op({ tenantId: '' }), op({ userId: 'x'.repeat(ID_MAX + 1) })],
    });
    expect(codes['operations.0.tenantId']).toEqual([CODES.FIELD_TOO_SHORT]);
    expect(codes['operations.1.userId']).toEqual([CODES.FIELD_TOO_LONG]);
  });
});

describe('unknown keys', () => {
  it('flags an unknown key on an operation, by name', () => {
    const codes = codesFor({ operations: [op({ extra: 1 })] });
    expect(codes['operations.0.extra']).toEqual([CODES.UNKNOWN_FIELD]);
  });

  it('flags an unknown top-level key, by name', () => {
    const codes = codesFor({ operations: [op()], extra: 1 });
    expect(codes.extra).toEqual([CODES.UNKNOWN_FIELD]);
  });
});

describe('non-object bodies and determinism', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'nope'],
    ['a number', 42],
  ])('rejects %s as FIELD_TYPE_INVALID', (_label, body) => {
    expect(codesFor(body)['']).toEqual([CODES.FIELD_TYPE_INVALID]);
  });

  it('rejects an undefined body as FIELD_REQUIRED', () => {
    expect(codesFor(undefined)['']).toEqual([CODES.FIELD_REQUIRED]);
  });

  it('returns identical codes for the same invalid payload every time', () => {
    const body = { operations: [op({ tenantId: 7 }), op({ userId: '' })], extra: true };
    expect(codesFor(body)).toEqual(codesFor(body));
  });
});

describe('duplicate submissions', () => {
  it('accepts identical operations repeated in one request (compatibility)', () => {
    expect(codesFor({ operations: [op(), op(), op()] })).toBeNull();
  });

  it('reports the same failure once per offending operation, not merged', () => {
    const codes = codesFor({ operations: [op({ tenantId: '' }), op({ tenantId: '' })] });
    expect(codes['operations.0.tenantId']).toEqual([CODES.FIELD_TOO_SHORT]);
    expect(codes['operations.1.tenantId']).toEqual([CODES.FIELD_TOO_SHORT]);
  });

  it('never lists the same code twice for one field', () => {
    const codes = codesFor({ operations: [op({ tenantId: '   ' })] });
    const list = codes['operations.0.tenantId'];
    expect(new Set(list).size).toBe(list.length);
  });
});
