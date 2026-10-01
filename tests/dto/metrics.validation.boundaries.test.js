'use strict';

/**
 * @fileoverview Focused validation-boundary tests for src/dto/metrics.js (#1352).
 *
 * Covers:
 *  - validateSmeMetricsInput — hard-rejection at trust boundaries
 *  - toSmeMetricsResponse    — soft-boundary coercion (negatives, floats, max)
 *  - detectDuplicateBulkOperations — duplicate pair detection
 *  - toPersistenceRecordParams — statusCode & durationSeconds clamping
 *  - Boundary constants exported from the module
 *
 * These tests are additive — they do not replace the existing suite in
 * tests/dto/metrics.test.js; they add the rejection, duplicate, and
 * boundary-case scenarios required by issue #1352.
 */

const {
  toSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,
  toPersistenceRecordParams,
  isValidSmeMetricsResponse,
  isValidPersistenceRecordParams,
  validateSmeMetricsInput,
  detectDuplicateBulkOperations,
  MAX_COUNT_VALUE,
  MAX_DURATION_SECONDS,
  HTTP_STATUS_MIN,
  HTTP_STATUS_MAX,
} = require('../../src/dto/metrics');

// ---------------------------------------------------------------------------
// Boundary constants
// ---------------------------------------------------------------------------
describe('boundary constants', () => {
  it('MAX_COUNT_VALUE is a positive integer', () => {
    expect(typeof MAX_COUNT_VALUE).toBe('number');
    expect(Number.isInteger(MAX_COUNT_VALUE)).toBe(true);
    expect(MAX_COUNT_VALUE).toBeGreaterThan(0);
  });

  it('MAX_DURATION_SECONDS is a positive number', () => {
    expect(typeof MAX_DURATION_SECONDS).toBe('number');
    expect(MAX_DURATION_SECONDS).toBeGreaterThan(0);
  });

  it('HTTP_STATUS_MIN is 100', () => {
    expect(HTTP_STATUS_MIN).toBe(100);
  });

  it('HTTP_STATUS_MAX is 599', () => {
    expect(HTTP_STATUS_MAX).toBe(599);
  });
});

// ---------------------------------------------------------------------------
// validateSmeMetricsInput — hard rejection boundary
// ---------------------------------------------------------------------------
describe('validateSmeMetricsInput — valid inputs', () => {
  it('accepts all-zero counts', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: 0, defaulted: 0 })
    ).not.toThrow();
  });

  it('accepts typical positive integer counts', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 10, funded: 5, settled: 3, defaulted: 1 })
    ).not.toThrow();
  });

  it('accepts counts at MAX_COUNT_VALUE boundary', () => {
    expect(() =>
      validateSmeMetricsInput({
        open: MAX_COUNT_VALUE,
        funded: MAX_COUNT_VALUE,
        settled: MAX_COUNT_VALUE,
        defaulted: MAX_COUNT_VALUE,
      })
    ).not.toThrow();
  });

  it('accepts count of exactly 1 for each field', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 1, funded: 1, settled: 1, defaulted: 1 })
    ).not.toThrow();
  });
});

describe('validateSmeMetricsInput — invalid input type', () => {
  it('throws TypeError for null input', () => {
    expect(() => validateSmeMetricsInput(null)).toThrow(TypeError);
  });

  it('throws TypeError for undefined input', () => {
    expect(() => validateSmeMetricsInput(undefined)).toThrow(TypeError);
  });

  it('throws TypeError for a string input', () => {
    expect(() => validateSmeMetricsInput('not-an-object')).toThrow(TypeError);
  });

  it('throws TypeError for an array input', () => {
    expect(() => validateSmeMetricsInput([1, 2, 3])).toThrow(TypeError);
  });

  it('throws TypeError for a number input', () => {
    expect(() => validateSmeMetricsInput(42)).toThrow(TypeError);
  });

  it('throws TypeError error message that mentions "plain object"', () => {
    expect(() => validateSmeMetricsInput(null)).toThrow(/plain object/i);
  });
});

describe('validateSmeMetricsInput — negative values rejected', () => {
  it('throws RangeError when "open" is negative', () => {
    expect(() =>
      validateSmeMetricsInput({ open: -1, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "funded" is negative', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: -5, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "settled" is negative', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: -100, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "defaulted" is negative', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: 0, defaulted: -1 })
    ).toThrow(RangeError);
  });

  it('error message names the offending field and the value for "open"', () => {
    expect(() =>
      validateSmeMetricsInput({ open: -42, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(/"open"/);
  });

  it('error message names the offending field and the value for "defaulted"', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: 0, defaulted: -99 })
    ).toThrow(/"defaulted"/);
  });
});

describe('validateSmeMetricsInput — non-integer values rejected', () => {
  it('throws RangeError when "open" is a float', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 1.5, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "funded" is a float', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0.1, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "settled" is a float', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: 99.9, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "defaulted" is a very small float', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: 0, defaulted: 0.0001 })
    ).toThrow(RangeError);
  });

  it('error message mentions "integer" for float input', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 2.7, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(/integer/i);
  });
});

describe('validateSmeMetricsInput — non-finite values rejected', () => {
  it('throws RangeError when "open" is Infinity', () => {
    expect(() =>
      validateSmeMetricsInput({ open: Infinity, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "funded" is -Infinity', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: -Infinity, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "settled" is NaN', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 0, funded: 0, settled: NaN, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "open" is a non-numeric string', () => {
    expect(() =>
      validateSmeMetricsInput({ open: 'abc', funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "open" is undefined', () => {
    expect(() =>
      validateSmeMetricsInput({ open: undefined, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "open" is null', () => {
    expect(() =>
      validateSmeMetricsInput({ open: null, funded: 0, settled: 0, defaulted: 0 })
    ).toThrow(RangeError);
  });
});

describe('validateSmeMetricsInput — above MAX_COUNT_VALUE rejected', () => {
  it('throws RangeError when "open" exceeds MAX_COUNT_VALUE', () => {
    expect(() =>
      validateSmeMetricsInput({
        open: MAX_COUNT_VALUE + 1,
        funded: 0,
        settled: 0,
        defaulted: 0,
      })
    ).toThrow(RangeError);
  });

  it('throws RangeError when "defaulted" exceeds MAX_COUNT_VALUE', () => {
    expect(() =>
      validateSmeMetricsInput({
        open: 0,
        funded: 0,
        settled: 0,
        defaulted: MAX_COUNT_VALUE + 100,
      })
    ).toThrow(RangeError);
  });

  it('error message mentions MAX_COUNT_VALUE in the message', () => {
    expect(() =>
      validateSmeMetricsInput({
        open: MAX_COUNT_VALUE + 1,
        funded: 0,
        settled: 0,
        defaulted: 0,
      })
    ).toThrow(new RegExp(String(MAX_COUNT_VALUE)));
  });
});

// ---------------------------------------------------------------------------
// toSmeMetricsResponse — soft-boundary coercion
// ---------------------------------------------------------------------------
describe('toSmeMetricsResponse — negative values clamped to 0', () => {
  it('clamps negative "open" to 0', () => {
    const result = toSmeMetricsResponse({ open: -5, funded: 1, settled: 1, defaulted: 1 });
    expect(result.open).toBe(0);
  });

  it('clamps negative "funded" to 0', () => {
    const result = toSmeMetricsResponse({ open: 1, funded: -100, settled: 1, defaulted: 1 });
    expect(result.funded).toBe(0);
  });

  it('clamps negative "settled" to 0', () => {
    const result = toSmeMetricsResponse({ open: 1, funded: 1, settled: -1, defaulted: 1 });
    expect(result.settled).toBe(0);
  });

  it('clamps negative "defaulted" to 0', () => {
    const result = toSmeMetricsResponse({ open: 1, funded: 1, settled: 1, defaulted: -999 });
    expect(result.defaulted).toBe(0);
  });

  it('clamps all-negative input to all zeros', () => {
    const result = toSmeMetricsResponse({ open: -1, funded: -2, settled: -3, defaulted: -4 });
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });
});

describe('toSmeMetricsResponse — float values floored to integer', () => {
  it('floors "open" from 2.9 to 2', () => {
    const result = toSmeMetricsResponse({ open: 2.9, funded: 0, settled: 0, defaulted: 0 });
    expect(result.open).toBe(2);
  });

  it('floors "funded" from 5.1 to 5', () => {
    const result = toSmeMetricsResponse({ open: 0, funded: 5.1, settled: 0, defaulted: 0 });
    expect(result.funded).toBe(5);
  });

  it('floors "settled" from 99.99 to 99', () => {
    const result = toSmeMetricsResponse({ open: 0, funded: 0, settled: 99.99, defaulted: 0 });
    expect(result.settled).toBe(99);
  });

  it('floors "defaulted" from 0.9 to 0', () => {
    const result = toSmeMetricsResponse({ open: 0, funded: 0, settled: 0, defaulted: 0.9 });
    expect(result.defaulted).toBe(0);
  });

  it('floors all-float input', () => {
    const result = toSmeMetricsResponse({ open: 1.1, funded: 2.5, settled: 3.7, defaulted: 4.9 });
    expect(result).toEqual({ open: 1, funded: 2, settled: 3, defaulted: 4 });
  });
});

describe('toSmeMetricsResponse — MAX_COUNT_VALUE boundary', () => {
  it('passes through exactly MAX_COUNT_VALUE', () => {
    const result = toSmeMetricsResponse({
      open: MAX_COUNT_VALUE,
      funded: 0,
      settled: 0,
      defaulted: 0,
    });
    expect(result.open).toBe(MAX_COUNT_VALUE);
  });

  it('clamps "open" above MAX_COUNT_VALUE to MAX_COUNT_VALUE', () => {
    const result = toSmeMetricsResponse({
      open: MAX_COUNT_VALUE + 1,
      funded: 0,
      settled: 0,
      defaulted: 0,
    });
    expect(result.open).toBe(MAX_COUNT_VALUE);
  });

  it('clamps all fields above MAX_COUNT_VALUE to MAX_COUNT_VALUE', () => {
    const huge = MAX_COUNT_VALUE + 999;
    const result = toSmeMetricsResponse({
      open: huge,
      funded: huge,
      settled: huge,
      defaulted: huge,
    });
    expect(result).toEqual({
      open: MAX_COUNT_VALUE,
      funded: MAX_COUNT_VALUE,
      settled: MAX_COUNT_VALUE,
      defaulted: MAX_COUNT_VALUE,
    });
  });

  it('MAX_COUNT_VALUE - 1 passes through unchanged', () => {
    const result = toSmeMetricsResponse({
      open: MAX_COUNT_VALUE - 1,
      funded: 0,
      settled: 0,
      defaulted: 0,
    });
    expect(result.open).toBe(MAX_COUNT_VALUE - 1);
  });
});

describe('toSmeMetricsResponse — non-finite values become 0', () => {
  it('treats Infinity as 0', () => {
    const result = toSmeMetricsResponse({ open: Infinity, funded: 0, settled: 0, defaulted: 0 });
    expect(result.open).toBe(0);
  });

  it('treats -Infinity as 0', () => {
    const result = toSmeMetricsResponse({ open: -Infinity, funded: 0, settled: 0, defaulted: 0 });
    expect(result.open).toBe(0);
  });

  it('treats NaN as 0', () => {
    const result = toSmeMetricsResponse({ open: NaN, funded: 0, settled: 0, defaulted: 0 });
    expect(result.open).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectDuplicateBulkOperations
// ---------------------------------------------------------------------------
describe('detectDuplicateBulkOperations — no duplicates', () => {
  it('returns empty array for an empty operations list', () => {
    expect(detectDuplicateBulkOperations([])).toEqual([]);
  });

  it('returns empty array for a single operation', () => {
    const ops = [{ tenantId: 'T1', userId: 'U1' }];
    expect(detectDuplicateBulkOperations(ops)).toEqual([]);
  });

  it('returns empty array when all operations are unique', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T1', userId: 'U2' }, // same tenant, different user
      { tenantId: 'T2', userId: 'U1' }, // different tenant, same user
      { tenantId: 'T2', userId: 'U2' },
    ];
    expect(detectDuplicateBulkOperations(ops)).toEqual([]);
  });
});

describe('detectDuplicateBulkOperations — duplicates detected', () => {
  it('detects a single duplicate pair', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T1', userId: 'U1' },
    ];
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tenantId: 'T1', userId: 'U1', index: 1 });
  });

  it('reports the correct index for the duplicate', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T2', userId: 'U2' },
      { tenantId: 'T1', userId: 'U1' }, // duplicate at index 2
    ];
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(2);
  });

  it('detects multiple duplicate pairs', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T2', userId: 'U2' },
      { tenantId: 'T1', userId: 'U1' }, // dup at index 2
      { tenantId: 'T2', userId: 'U2' }, // dup at index 3
    ];
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(2);
    expect(result[1].index).toBe(3);
  });

  it('detects triple occurrence — only indices 1 and 2 are duplicates', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T1', userId: 'U1' }, // dup at index 1
      { tenantId: 'T1', userId: 'U1' }, // dup at index 2
    ];
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(1);
    expect(result[1].index).toBe(2);
  });

  it('does NOT treat same tenantId + different userId as duplicate', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T1', userId: 'U2' },
    ];
    expect(detectDuplicateBulkOperations(ops)).toEqual([]);
  });

  it('does NOT treat different tenantId + same userId as duplicate', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T2', userId: 'U1' },
    ];
    expect(detectDuplicateBulkOperations(ops)).toEqual([]);
  });
});

describe('detectDuplicateBulkOperations — invalid / adversarial input', () => {
  it('returns empty array for non-array input', () => {
    expect(detectDuplicateBulkOperations(null)).toEqual([]);
    expect(detectDuplicateBulkOperations(undefined)).toEqual([]);
    expect(detectDuplicateBulkOperations('string')).toEqual([]);
    expect(detectDuplicateBulkOperations(42)).toEqual([]);
    expect(detectDuplicateBulkOperations({})).toEqual([]);
  });

  it('skips non-object entries in the array', () => {
    const ops = [
      null,
      { tenantId: 'T1', userId: 'U1' },
      undefined,
      { tenantId: 'T1', userId: 'U1' }, // duplicate
    ];
    // The null and undefined at index 0/2 are skipped; dup is at index 3
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(3);
  });

  it('handles operations with undefined tenantId or userId via string coercion', () => {
    const ops = [
      { tenantId: undefined, userId: undefined },
      { tenantId: undefined, userId: undefined }, // same coerced key
    ];
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(1);
  });

  it('treats empty-string tenantId+userId as a valid key', () => {
    const ops = [
      { tenantId: '', userId: '' },
      { tenantId: '', userId: '' },
    ];
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(1);
  });

  it('returns up to MAX_BULK_OPERATIONS duplicates gracefully', () => {
    // Build 26 identical entries — only index 0 is "first"; 1–25 are duplicates
    const ops = Array.from({ length: 26 }, () => ({ tenantId: 'T1', userId: 'U1' }));
    const result = detectDuplicateBulkOperations(ops);
    expect(result).toHaveLength(25);
    expect(result.every(d => d.tenantId === 'T1' && d.userId === 'U1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toPersistenceRecordParams — boundary clamping
// ---------------------------------------------------------------------------
describe('toPersistenceRecordParams — statusCode boundary', () => {
  it('accepts 200 (valid HTTP code)', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });

  it('accepts 100 (HTTP_STATUS_MIN)', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 100, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(100);
  });

  it('accepts 599 (HTTP_STATUS_MAX)', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 599, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(599);
  });

  it('normalises statusCode 99 (below HTTP_STATUS_MIN) to 200', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 99, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });

  it('normalises statusCode 600 (above HTTP_STATUS_MAX) to 200', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 600, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });

  it('normalises negative statusCode to 200', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: -1, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });

  it('normalises NaN statusCode to 200', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: NaN, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });

  it('normalises non-numeric string statusCode to 200', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 'abc', durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });

  it('floors float statusCode within valid range', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200.9, durationSeconds: 0, cause: 'none' });
    expect(result.statusCode).toBe(200);
  });
});

describe('toPersistenceRecordParams — durationSeconds boundary', () => {
  it('accepts a valid duration of 0.05', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: 0.05, cause: 'none' });
    expect(result.durationSeconds).toBe(0.05);
  });

  it('accepts a duration of 0', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: 0, cause: 'none' });
    expect(result.durationSeconds).toBe(0);
  });

  it('accepts a duration at MAX_DURATION_SECONDS', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: MAX_DURATION_SECONDS, cause: 'none' });
    expect(result.durationSeconds).toBe(MAX_DURATION_SECONDS);
  });

  it('clamps negative durationSeconds to 0', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: -1, cause: 'none' });
    expect(result.durationSeconds).toBe(0);
  });

  it('clamps durationSeconds above MAX_DURATION_SECONDS to MAX_DURATION_SECONDS', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: MAX_DURATION_SECONDS + 1, cause: 'none' });
    expect(result.durationSeconds).toBe(MAX_DURATION_SECONDS);
  });

  it('clamps very large durationSeconds to MAX_DURATION_SECONDS', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: 999999, cause: 'none' });
    expect(result.durationSeconds).toBe(MAX_DURATION_SECONDS);
  });

  it('clamps NaN durationSeconds to 0', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: NaN, cause: 'none' });
    expect(result.durationSeconds).toBe(0);
  });

  it('clamps Infinity durationSeconds to MAX_DURATION_SECONDS', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: Infinity, cause: 'none' });
    expect(result.durationSeconds).toBe(MAX_DURATION_SECONDS);
  });

  it('clamps -Infinity durationSeconds to 0', () => {
    const result = toPersistenceRecordParams({ endpoint: 'x', statusCode: 200, durationSeconds: -Infinity, cause: 'none' });
    expect(result.durationSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent / retry safety: idempotent mapping under repeated calls
// ---------------------------------------------------------------------------
describe('idempotency and concurrent safety', () => {
  it('toSmeMetricsResponse is safe to call concurrently with the same input', () => {
    const raw = { open: 5, funded: 3, settled: 2, defaulted: 0 };
    const results = Array.from({ length: 10 }, () => toSmeMetricsResponse(raw));
    // All results should be identical
    for (const result of results) {
      expect(result).toEqual({ open: 5, funded: 3, settled: 2, defaulted: 0 });
    }
  });

  it('validateSmeMetricsInput does not mutate its input', () => {
    const raw = { open: 1, funded: 2, settled: 3, defaulted: 4 };
    const copy = { ...raw };
    validateSmeMetricsInput(raw);
    expect(raw).toEqual(copy);
  });

  it('toSmeMetricsResponse does not mutate its input', () => {
    const raw = { open: 1, funded: 2, settled: 3, defaulted: 4, extra: 'x' };
    const copy = { ...raw };
    toSmeMetricsResponse(raw);
    expect(raw).toEqual(copy);
  });

  it('detectDuplicateBulkOperations does not mutate its input array', () => {
    const ops = [
      { tenantId: 'T1', userId: 'U1' },
      { tenantId: 'T1', userId: 'U1' },
    ];
    const originalLength = ops.length;
    detectDuplicateBulkOperations(ops);
    expect(ops).toHaveLength(originalLength);
    expect(ops[0]).toEqual({ tenantId: 'T1', userId: 'U1' });
  });

  it('toPersistenceRecordParams does not mutate its input', () => {
    const raw = { endpoint: 'sme_invoice_upload', statusCode: 200, durationSeconds: 0.05, cause: 'none' };
    const copy = { ...raw };
    toPersistenceRecordParams(raw);
    expect(raw).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Regression: partial failure and consistent state
// ---------------------------------------------------------------------------
describe('regression — consistent state across partial failure inputs', () => {
  it('validateSmeMetricsInput throws on first bad field, not silently continuing', () => {
    // "open" is negative AND "funded" is a float — only the first error should throw
    let thrown = false;
    try {
      validateSmeMetricsInput({ open: -1, funded: 1.5, settled: 0, defaulted: 0 });
    } catch (err) {
      thrown = true;
      expect(err).toBeInstanceOf(RangeError);
      expect(err.message).toMatch(/"open"/);
    }
    expect(thrown).toBe(true);
  });

  it('toSmeMetricsResponse handles a mix of valid and invalid fields gracefully', () => {
    const result = toSmeMetricsResponse({ open: 3, funded: -2, settled: 'abc', defaulted: 1.7 });
    expect(result).toEqual({ open: 3, funded: 0, settled: 0, defaulted: 1 });
  });

  it('toSmeMetricsApiResponse retains the data shape for invalid inputs after coercion', () => {
    const rawCounts = { open: -10, funded: NaN, settled: 3.5, defaulted: Infinity };
    const data = toSmeMetricsResponse(rawCounts);
    const meta = toSmeMetricsMeta({ timestamp: '2026-01-01T00:00:00.000Z', version: '1.0.0' });
    const response = toSmeMetricsApiResponse(data, meta);

    expect(isValidSmeMetricsResponse(response.data)).toBe(true);
    expect(response.data.open).toBe(0);
    expect(response.data.funded).toBe(0);
    expect(response.data.settled).toBe(3);
    expect(response.data.defaulted).toBe(0);
    expect(response.error).toBeNull();
  });

  it('detectDuplicateBulkOperations on a large deduplicated batch returns empty', () => {
    // 25 unique operations (max bulk)
    const ops = Array.from({ length: 25 }, (_, i) => ({
      tenantId: `T${i}`,
      userId: `U${i}`,
    }));
    expect(detectDuplicateBulkOperations(ops)).toEqual([]);
  });

  it('all valid operations pass validateSmeMetricsInput individually', () => {
    const validInputs = [
      { open: 0, funded: 0, settled: 0, defaulted: 0 },
      { open: 1000, funded: 500, settled: 300, defaulted: 10 },
      { open: MAX_COUNT_VALUE, funded: 0, settled: 0, defaulted: 0 },
    ];
    for (const input of validInputs) {
      expect(() => validateSmeMetricsInput(input)).not.toThrow();
    }
  });

  it('no valid input after coercion should fail isValidSmeMetricsResponse', () => {
    const inputs = [
      { open: -5, funded: -3, settled: 1.7, defaulted: Infinity },
      { open: 'abc', funded: null, settled: undefined, defaulted: {} },
      {},
    ];
    for (const input of inputs) {
      const result = toSmeMetricsResponse(input);
      expect(isValidSmeMetricsResponse(result)).toBe(true);
    }
  });
});
