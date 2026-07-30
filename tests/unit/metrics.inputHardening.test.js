'use strict';

/**
 * @fileoverview Input-hardening tests for the metrics request schemas.
 *
 * Complements `tests/unit/metrics.schema.test.js` (which covers the general
 * schema surface) by focusing specifically on the hardening guarantees:
 *
 *  1. Unknown fields are rejected on bodies and stripped on query params.
 *  2. Wrong JSON types are rejected rather than coerced.
 *  3. Strings are length-bounded and numbers range-bounded, including at the
 *     exact boundary values on both sides.
 *  4. Every failure carries a machine-readable top-level `code` and a
 *     per-field `fieldCodes` map.
 */

const {
  getMetricsQuerySchema,
  bulkMetricsSchema,
  bulkMetricsOperationSchema,
  validateBulkMetricsBody,
  validateGetMetricsQuery,
  parseValidationFieldCodes,
  MAX_BULK_OPERATIONS,
  GET_METRICS_LIMIT_MIN,
  GET_METRICS_LIMIT_MAX,
  GET_METRICS_CURSOR_MAX_LENGTH,
  BULK_METRICS_ID_MAX_LENGTH,
  METRICS_VALIDATION_CODES,
  METRICS_VALIDATION_ERROR_CODE,
  METRICS_VALIDATION_PROBLEM_TYPE,
} = require('../../src/schemas/metrics');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _statusCode: null,
    _body: undefined,
    status: jest.fn(function (code) { this._statusCode = code; return this; }),
    json: jest.fn(function (body) { this._body = body; return this; }),
  };
  return res;
}

const makeNext = () => jest.fn();

/** Runs the bulk body middleware and returns the rejection body. */
function rejectBulk(body) {
  const res = makeRes();
  const next = makeNext();
  validateBulkMetricsBody({ body }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res._statusCode).toBe(400);
  return res._body;
}

const str = (n) => 'a'.repeat(n);
const validOp = { tenantId: 't1', userId: 'u1' };

// ── Exported bounds ──────────────────────────────────────────────────────────

describe('exported bounds', () => {
  it('exposes the documented numeric values', () => {
    expect(MAX_BULK_OPERATIONS).toBe(25);
    expect(GET_METRICS_LIMIT_MIN).toBe(1);
    expect(GET_METRICS_LIMIT_MAX).toBe(100);
    expect(GET_METRICS_CURSOR_MAX_LENGTH).toBe(512);
    expect(BULK_METRICS_ID_MAX_LENGTH).toBe(128);
  });
});

// ── Structured 400 contract ──────────────────────────────────────────────────

describe('structured 400 contract', () => {
  it('includes a machine-readable top-level code', () => {
    const body = rejectBulk({});
    expect(body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
    expect(body.code).toBe('METRICS_VALIDATION_ERROR');
  });

  it('preserves the pre-existing RFC 7807 fields unchanged', () => {
    const body = rejectBulk({});
    expect(body.type).toBe(METRICS_VALIDATION_PROBLEM_TYPE);
    expect(body.title).toBe('Validation Error');
    expect(body.status).toBe(400);
    expect(body.detail).toBe('Request body contains invalid or missing fields.');
    expect(body.fieldErrors).toBeDefined();
  });

  it('reports fieldErrors and fieldCodes under the same keys', () => {
    const body = rejectBulk({ operations: [{ userId: 'u1' }] });
    expect(Object.keys(body.fieldCodes)).toEqual(
      expect.arrayContaining(Object.keys(body.fieldErrors))
    );
  });

  it('emits only codes drawn from the bounded taxonomy', () => {
    const body = rejectBulk({ operations: [{ tenantId: 42, userId: str(200), bogus: 1 }] });
    const known = Object.values(METRICS_VALIDATION_CODES);
    for (const codes of Object.values(body.fieldCodes)) {
      for (const code of codes) {
        expect(known).toContain(code);
      }
    }
  });

  it('does not leak a stack trace', () => {
    const body = rejectBulk({});
    expect(body.stack).toBeUndefined();
  });
});

// ── Missing fields ───────────────────────────────────────────────────────────

describe('missing fields', () => {
  it('flags an absent operations array as FIELD_REQUIRED', () => {
    const body = rejectBulk({});
    expect(body.fieldCodes.operations).toContain(METRICS_VALIDATION_CODES.FIELD_REQUIRED);
  });

  it('flags an absent tenantId at its exact path', () => {
    const body = rejectBulk({ operations: [{ userId: 'u1' }] });
    expect(body.fieldCodes['operations.0.tenantId']).toContain(
      METRICS_VALIDATION_CODES.FIELD_REQUIRED
    );
  });

  it('flags an absent userId at its exact path', () => {
    const body = rejectBulk({ operations: [{ tenantId: 't1' }] });
    expect(body.fieldCodes['operations.0.userId']).toContain(
      METRICS_VALIDATION_CODES.FIELD_REQUIRED
    );
  });

  it('reports the correct index when a later item is incomplete', () => {
    const body = rejectBulk({ operations: [validOp, validOp, { tenantId: 't1' }] });
    expect(body.fieldCodes['operations.2.userId']).toContain(
      METRICS_VALIDATION_CODES.FIELD_REQUIRED
    );
    expect(body.fieldCodes['operations.0.userId']).toBeUndefined();
  });

  it('reports every missing field across multiple items at once', () => {
    const body = rejectBulk({ operations: [{ userId: 'u1' }, { tenantId: 't2' }] });
    expect(body.fieldCodes['operations.0.tenantId']).toBeDefined();
    expect(body.fieldCodes['operations.1.userId']).toBeDefined();
  });
});

// ── Wrong types ──────────────────────────────────────────────────────────────

describe('wrong types', () => {
  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an object', { nested: 'x' }],
    ['an array', ['x']],
    ['null', null],
  ])('rejects tenantId given %s as FIELD_TYPE_INVALID', (_label, value) => {
    const body = rejectBulk({ operations: [{ tenantId: value, userId: 'u1' }] });
    expect(body.fieldCodes['operations.0.tenantId']).toContain(
      METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID
    );
  });

  it('does not coerce a numeric-looking string id into a number', () => {
    const result = bulkMetricsOperationSchema.safeParse({ tenantId: '123', userId: '456' });
    expect(result.success).toBe(true);
    expect(result.data.tenantId).toBe('123');
    expect(typeof result.data.tenantId).toBe('string');
  });

  it.each([
    ['a string', 'not-an-array'],
    ['a number', 7],
    ['an object', { 0: validOp }],
    ['null', null],
  ])('rejects operations given %s', (_label, value) => {
    const body = rejectBulk({ operations: value });
    expect(body.fieldCodes.operations).toBeDefined();
  });

  it.each([
    ['null', null],
    ['an array', [validOp]],
    ['a string', 'payload'],
    ['a number', 5],
  ])('rejects a non-object body (%s)', (_label, value) => {
    const body = rejectBulk(value);
    expect(body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
  });

  it('rejects a non-object item inside operations', () => {
    const body = rejectBulk({ operations: ['just-a-string'] });
    expect(body.fieldCodes['operations.0']).toBeDefined();
  });
});

// ── Unknown fields ───────────────────────────────────────────────────────────

describe('unknown fields', () => {
  it('rejects an unknown top-level key as UNKNOWN_FIELD', () => {
    const body = rejectBulk({ operations: [validOp], rogue: true });
    const codes = Object.values(body.fieldCodes).flat();
    expect(codes).toContain(METRICS_VALIDATION_CODES.UNKNOWN_FIELD);
  });

  it('names the offending top-level key in fieldCodes', () => {
    const body = rejectBulk({ operations: [validOp], rogue: true });
    expect(body.fieldCodes.rogue).toEqual([METRICS_VALIDATION_CODES.UNKNOWN_FIELD]);
  });

  it('names the offending per-item key with its full path', () => {
    const body = rejectBulk({ operations: [{ ...validOp, isAdmin: true }] });
    expect(body.fieldCodes['operations.0.isAdmin']).toEqual([
      METRICS_VALIDATION_CODES.UNKNOWN_FIELD,
    ]);
  });

  it('names every unknown key when several are present', () => {
    const body = rejectBulk({ operations: [validOp], a: 1, b: 2 });
    expect(body.fieldCodes.a).toBeDefined();
    expect(body.fieldCodes.b).toBeDefined();
  });

  it('rejects a prototype-pollution-shaped key rather than applying it', () => {
    const body = rejectBulk({
      operations: [validOp],
      constructor: { prototype: { polluted: true } },
    });
    expect(body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
    expect({}.polluted).toBeUndefined();
  });
});

// ── String length bounds ─────────────────────────────────────────────────────

describe('string length bounds', () => {
  describe('tenantId / userId', () => {
    it.each(['tenantId', 'userId'])('accepts %s at exactly 128 characters', (field) => {
      const op = { ...validOp, [field]: str(BULK_METRICS_ID_MAX_LENGTH) };
      expect(bulkMetricsOperationSchema.safeParse(op).success).toBe(true);
    });

    it.each(['tenantId', 'userId'])('rejects %s at 129 characters as FIELD_TOO_LONG', (field) => {
      const op = { ...validOp, [field]: str(BULK_METRICS_ID_MAX_LENGTH + 1) };
      const body = rejectBulk({ operations: [op] });
      expect(body.fieldCodes[`operations.0.${field}`]).toContain(
        METRICS_VALIDATION_CODES.FIELD_TOO_LONG
      );
    });

    it('rejects a grossly oversized id', () => {
      const body = rejectBulk({ operations: [{ ...validOp, userId: str(100000) }] });
      expect(body.fieldCodes['operations.0.userId']).toContain(
        METRICS_VALIDATION_CODES.FIELD_TOO_LONG
      );
    });

    it.each(['tenantId', 'userId'])('accepts %s at the 1-character minimum', (field) => {
      const op = { ...validOp, [field]: 'x' };
      expect(bulkMetricsOperationSchema.safeParse(op).success).toBe(true);
    });

    it.each(['tenantId', 'userId'])('rejects an empty %s as FIELD_TOO_SHORT', (field) => {
      const body = rejectBulk({ operations: [{ ...validOp, [field]: '' }] });
      expect(body.fieldCodes[`operations.0.${field}`]).toContain(
        METRICS_VALIDATION_CODES.FIELD_TOO_SHORT
      );
    });

    it.each(['tenantId', 'userId'])('rejects a whitespace-only %s', (field) => {
      const body = rejectBulk({ operations: [{ ...validOp, [field]: '   ' }] });
      expect(body.fieldCodes[`operations.0.${field}`]).toContain(
        METRICS_VALIDATION_CODES.FIELD_TOO_SHORT
      );
    });

    it('measures length after trimming, so padding does not consume the budget', () => {
      const padded = `  ${str(BULK_METRICS_ID_MAX_LENGTH)}  `;
      const result = bulkMetricsOperationSchema.safeParse({ ...validOp, userId: padded });
      expect(result.success).toBe(true);
      expect(result.data.userId).toHaveLength(BULK_METRICS_ID_MAX_LENGTH);
    });
  });

  describe('cursor', () => {
    it('accepts a cursor at exactly 512 characters', () => {
      const result = getMetricsQuerySchema.safeParse({
        cursor: str(GET_METRICS_CURSOR_MAX_LENGTH),
      });
      expect(result.success).toBe(true);
    });

    it('rejects a cursor at 513 characters', () => {
      const result = getMetricsQuerySchema.safeParse({
        cursor: str(GET_METRICS_CURSOR_MAX_LENGTH + 1),
      });
      expect(result.success).toBe(false);
    });

    it('rejects a grossly oversized cursor', () => {
      const result = getMetricsQuerySchema.safeParse({ cursor: str(50000) });
      expect(result.success).toBe(false);
    });

    it('reports an oversized cursor as FIELD_TOO_LONG', () => {
      const result = getMetricsQuerySchema.safeParse({
        cursor: str(GET_METRICS_CURSOR_MAX_LENGTH + 1),
      });
      expect(parseValidationFieldCodes(result.error).cursor).toContain(
        METRICS_VALIDATION_CODES.FIELD_TOO_LONG
      );
    });

    it('rejects a non-string cursor', () => {
      expect(getMetricsQuerySchema.safeParse({ cursor: 42 }).success).toBe(false);
    });
  });
});

// ── Numeric range bounds ─────────────────────────────────────────────────────

describe('limit range bounds', () => {
  it.each(['1', '2', '50', '99', '100'])('accepts in-range limit %s', (value) => {
    const result = getMetricsQuerySchema.safeParse({ limit: value });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(Number(value));
  });

  it('accepts the exact lower boundary', () => {
    const result = getMetricsQuerySchema.safeParse({ limit: String(GET_METRICS_LIMIT_MIN) });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(GET_METRICS_LIMIT_MIN);
  });

  it('accepts the exact upper boundary', () => {
    const result = getMetricsQuerySchema.safeParse({ limit: String(GET_METRICS_LIMIT_MAX) });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(GET_METRICS_LIMIT_MAX);
  });

  it('rejects one below the lower boundary as VALUE_BELOW_MINIMUM', () => {
    const result = getMetricsQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
    expect(parseValidationFieldCodes(result.error).limit).toContain(
      METRICS_VALIDATION_CODES.VALUE_BELOW_MINIMUM
    );
  });

  it('rejects one above the upper boundary as VALUE_ABOVE_MAXIMUM', () => {
    const result = getMetricsQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
    expect(parseValidationFieldCodes(result.error).limit).toContain(
      METRICS_VALIDATION_CODES.VALUE_ABOVE_MAXIMUM
    );
  });

  it.each(['-1', '-5', '-100'])('rejects negative limit %s', (value) => {
    expect(getMetricsQuerySchema.safeParse({ limit: value }).success).toBe(false);
  });

  it.each([
    ['non-numeric text', 'abc'],
    ['trailing garbage', '20abc'],
    ['leading garbage', 'abc20'],
    ['exponent notation', '1e5'],
    ['a float', '10.5'],
    ['hex notation', '0x10'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a separator', '1,2'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('rejects malformed limit (%s)', (_label, value) => {
    expect(getMetricsQuerySchema.safeParse({ limit: value }).success).toBe(false);
  });

  it('reports a malformed limit as FIELD_FORMAT_INVALID', () => {
    const result = getMetricsQuerySchema.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
    expect(parseValidationFieldCodes(result.error).limit).toContain(
      METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID
    );
  });

  it('rejects an absurdly large integer rather than clamping it', () => {
    expect(getMetricsQuerySchema.safeParse({ limit: '999999999999999999999' }).success).toBe(
      false
    );
  });

  it('tolerates surrounding whitespace around a valid integer', () => {
    const result = getMetricsQuerySchema.safeParse({ limit: ' 20 ' });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(20);
  });

  it('treats an omitted limit as undefined without error', () => {
    const result = getMetricsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.limit).toBeUndefined();
  });
});

// ── Array bounds ─────────────────────────────────────────────────────────────

describe('operations array bounds', () => {
  it('rejects an empty array as ARRAY_TOO_SMALL', () => {
    const body = rejectBulk({ operations: [] });
    expect(body.fieldCodes.operations).toContain(METRICS_VALIDATION_CODES.ARRAY_TOO_SMALL);
  });

  it('accepts exactly one item', () => {
    expect(bulkMetricsSchema.safeParse({ operations: [validOp] }).success).toBe(true);
  });

  it('accepts exactly MAX_BULK_OPERATIONS items', () => {
    const operations = Array.from({ length: MAX_BULK_OPERATIONS }, () => ({ ...validOp }));
    expect(bulkMetricsSchema.safeParse({ operations }).success).toBe(true);
  });

  it('rejects MAX_BULK_OPERATIONS + 1 items as ARRAY_TOO_LARGE', () => {
    const operations = Array.from({ length: MAX_BULK_OPERATIONS + 1 }, () => ({ ...validOp }));
    const body = rejectBulk({ operations });
    expect(body.fieldCodes.operations).toContain(METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE);
  });

  it('rejects a grossly oversized array', () => {
    const operations = Array.from({ length: 5000 }, () => ({ ...validOp }));
    const body = rejectBulk({ operations });
    expect(body.fieldCodes.operations).toContain(METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE);
  });
});

// ── Query middleware ─────────────────────────────────────────────────────────

describe('validateGetMetricsQuery middleware', () => {
  it('passes a valid query through and exposes coerced values', () => {
    const req = { query: { limit: '20' }, originalUrl: '/api/sme/metrics?limit=20' };
    const next = makeNext();
    validateGetMetricsQuery(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.validatedQuery.limit).toBe(20);
  });

  it('forwards an AppError carrying the metrics validation code', () => {
    const req = { query: { limit: '999' }, originalUrl: '/api/sme/metrics?limit=999' };
    const next = makeNext();
    validateGetMetricsQuery(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe(METRICS_VALIDATION_ERROR_CODE);
    expect(err.fieldErrors).toBeDefined();
  });

  it('strips unknown query params instead of rejecting them', () => {
    const req = { query: { limit: '5', utm_source: 'email' }, originalUrl: '/x' };
    const next = makeNext();
    validateGetMetricsQuery(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.validatedQuery.utm_source).toBeUndefined();
    expect(req.validatedQuery.limit).toBe(5);
  });
});

// ── parseValidationFieldCodes ────────────────────────────────────────────────

describe('parseValidationFieldCodes', () => {
  it('returns an empty object when there are no issues', () => {
    expect(parseValidationFieldCodes({ issues: [] })).toEqual({});
  });

  it('groups codes by joined field path', () => {
    const codes = parseValidationFieldCodes({
      issues: [
        { code: 'invalid_type', received: 'undefined', path: ['operations', 0, 'userId'] },
      ],
    });
    expect(codes['operations.0.userId']).toEqual([
      METRICS_VALIDATION_CODES.FIELD_REQUIRED,
    ]);
  });

  it('deduplicates a repeated code on the same path', () => {
    const issue = { code: 'too_big', origin: 'string', path: ['userId'] };
    const codes = parseValidationFieldCodes({ issues: [issue, issue] });
    expect(codes.userId).toEqual([METRICS_VALIDATION_CODES.FIELD_TOO_LONG]);
  });

  it('keeps distinct codes on the same path', () => {
    const codes = parseValidationFieldCodes({
      issues: [
        { code: 'too_big', origin: 'string', path: ['userId'] },
        { code: 'invalid_format', path: ['userId'] },
      ],
    });
    expect(codes.userId).toHaveLength(2);
  });

  it('uses an empty-string key for root-level issues', () => {
    const codes = parseValidationFieldCodes({
      issues: [{ code: 'invalid_type', received: 'array', input: [], path: [] }],
    });
    expect(codes['']).toContain(METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID);
  });

  it('expands unrecognized_keys into one entry per offending key', () => {
    const codes = parseValidationFieldCodes({
      issues: [{ code: 'unrecognized_keys', keys: ['a', 'b'], path: [] }],
    });
    expect(codes.a).toEqual([METRICS_VALIDATION_CODES.UNKNOWN_FIELD]);
    expect(codes.b).toEqual([METRICS_VALIDATION_CODES.UNKNOWN_FIELD]);
  });

  it('prefixes expanded unknown keys with their parent path', () => {
    const codes = parseValidationFieldCodes({
      issues: [{ code: 'unrecognized_keys', keys: ['extra'], path: ['operations', 0] }],
    });
    expect(codes['operations.0.extra']).toEqual([
      METRICS_VALIDATION_CODES.UNKNOWN_FIELD,
    ]);
  });

  it('tolerates an unrecognized_keys issue with no keys array', () => {
    const codes = parseValidationFieldCodes({
      issues: [{ code: 'unrecognized_keys', path: [] }],
    });
    expect(codes['']).toContain(METRICS_VALIDATION_CODES.UNKNOWN_FIELD);
  });
});
