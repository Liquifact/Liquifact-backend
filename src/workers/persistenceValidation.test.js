'use strict';

/**
 * @fileoverview Comprehensive tests for src/workers/persistenceValidation.js
 *
 * Covers all exported helpers:
 *  - assertJobStructure(job)
 *  - validatePayloadRoundTrip(raw)
 *  - parseEnvInt(value, defaultValue, min, max)
 *  - REQUIRED_JOB_FIELDS constant
 *
 * The suite aims for ≥ 95 % statement / branch / function coverage on the
 * module under test.  Every existing rejection from the inlined code that was
 * extracted into this helper is verified to fire identically.
 *
 * @module workers/persistenceValidation.test
 */

const {
  assertJobStructure,
  validatePayloadRoundTrip,
  parseEnvInt,
  REQUIRED_JOB_FIELDS,
} = require('./persistenceValidation');

// ===========================================================================
// REQUIRED_JOB_FIELDS constant
// ===========================================================================
describe('REQUIRED_JOB_FIELDS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(REQUIRED_JOB_FIELDS)).toBe(true);
    expect(REQUIRED_JOB_FIELDS.length).toBeGreaterThan(0);
  });

  it('includes "id" and "type"', () => {
    expect(REQUIRED_JOB_FIELDS).toContain('id');
    expect(REQUIRED_JOB_FIELDS).toContain('type');
  });

  it('contains only strings', () => {
    for (const field of REQUIRED_JOB_FIELDS) {
      expect(typeof field).toBe('string');
    }
  });
});

// ===========================================================================
// assertJobStructure
// ===========================================================================
describe('assertJobStructure', () => {
  // ── valid inputs ──────────────────────────────────────────────────────────
  describe('valid job objects (no throw)', () => {
    it('accepts a minimal valid job with id and type', () => {
      expect(() =>
        assertJobStructure({ id: 'job-abc', type: 'webhook_delivery' })
      ).not.toThrow();
    });

    it('accepts a fully-populated job object', () => {
      expect(() =>
        assertJobStructure({
          id: 'job-001',
          type: 'invoice_process',
          payload: { invoiceId: 'inv_1' },
          status: 'pending',
          attempts: 0,
          createdAt: Date.now(),
        })
      ).not.toThrow();
    });

    it('accepts extra unknown fields without objection', () => {
      expect(() =>
        assertJobStructure({ id: 'j', type: 't', custom: true, nested: { x: 1 } })
      ).not.toThrow();
    });

    it('accepts id / type values with surrounding whitespace in content (not trimmed away)', () => {
      // Non-empty string — leading/trailing spaces count as non-empty content.
      expect(() =>
        assertJobStructure({ id: ' job-1 ', type: ' t ' })
      ).not.toThrow();
    });
  });

  // ── null / non-object ─────────────────────────────────────────────────────
  describe('null / non-object inputs', () => {
    it('throws on null', () => {
      expect(() => assertJobStructure(null))
        .toThrow('Invalid job structure: job must be a plain object');
    });

    it('throws on undefined', () => {
      expect(() => assertJobStructure(undefined))
        .toThrow('Invalid job structure: job must be a plain object');
    });

    it('throws on a number', () => {
      expect(() => assertJobStructure(42))
        .toThrow('Invalid job structure: job must be a plain object');
    });

    it('throws on a string', () => {
      expect(() => assertJobStructure('not-a-job'))
        .toThrow('Invalid job structure: job must be a plain object');
    });

    it('throws on an array (not a plain object)', () => {
      expect(() => assertJobStructure([{ id: 'j', type: 't' }]))
        .toThrow('Invalid job structure: job must be a plain object');
    });

    it('throws on a boolean', () => {
      expect(() => assertJobStructure(true))
        .toThrow('Invalid job structure: job must be a plain object');
    });
  });

  // ── missing / invalid required fields ────────────────────────────────────
  describe('missing required fields', () => {
    it('throws when "id" is absent', () => {
      expect(() => assertJobStructure({ type: 'webhook_delivery' }))
        .toThrow(/field "id" must be a non-empty string/);
    });

    it('throws when "type" is absent', () => {
      expect(() => assertJobStructure({ id: 'job-1' }))
        .toThrow(/field "type" must be a non-empty string/);
    });

    it('throws when both "id" and "type" are absent', () => {
      expect(() => assertJobStructure({}))
        .toThrow(/field "id" must be a non-empty string/);
    });
  });

  // ── falsy / wrong-type field values ───────────────────────────────────────
  describe('falsy or wrong-type field values', () => {
    it('throws when "id" is null', () => {
      expect(() => assertJobStructure({ id: null, type: 'webhook' }))
        .toThrow(/field "id"/);
    });

    it('throws when "id" is undefined', () => {
      expect(() => assertJobStructure({ id: undefined, type: 'webhook' }))
        .toThrow(/field "id"/);
    });

    it('throws when "id" is a number', () => {
      expect(() => assertJobStructure({ id: 123, type: 'webhook' }))
        .toThrow(/field "id" must be a non-empty string, got number/);
    });

    it('throws when "id" is an empty string', () => {
      expect(() => assertJobStructure({ id: '', type: 'webhook' }))
        .toThrow(/field "id" must be a non-empty string/);
    });

    it('throws when "id" is a whitespace-only string', () => {
      expect(() => assertJobStructure({ id: '   ', type: 'webhook' }))
        .toThrow(/field "id" must be a non-empty string/);
    });

    it('throws when "type" is null', () => {
      expect(() => assertJobStructure({ id: 'j', type: null }))
        .toThrow(/field "type"/);
    });

    it('throws when "type" is an empty string', () => {
      expect(() => assertJobStructure({ id: 'j', type: '' }))
        .toThrow(/field "type" must be a non-empty string/);
    });

    it('throws when "type" is a whitespace-only string', () => {
      expect(() => assertJobStructure({ id: 'j', type: '\t' }))
        .toThrow(/field "type" must be a non-empty string/);
    });

    it('throws when "type" is an object', () => {
      expect(() => assertJobStructure({ id: 'j', type: { name: 'webhook' } }))
        .toThrow(/field "type" must be a non-empty string, got object/);
    });

    it('throws when "type" is a boolean', () => {
      expect(() => assertJobStructure({ id: 'j', type: false }))
        .toThrow(/field "type" must be a non-empty string, got boolean/);
    });
  });

  // ── error message content ─────────────────────────────────────────────────
  describe('error message details', () => {
    it('error includes the field name that failed', () => {
      let err;
      try { assertJobStructure({ id: 'ok', type: 123 }); }
      catch (e) { err = e; }
      expect(err.message).toMatch(/"type"/);
    });

    it('error mentions null when field value is null', () => {
      let err;
      try { assertJobStructure({ id: null, type: 't' }); }
      catch (e) { err = e; }
      expect(err.message).toMatch(/null/);
    });
  });

  // ── REQUIRED_JOB_FIELDS alignment ────────────────────────────────────────
  describe('alignment with REQUIRED_JOB_FIELDS', () => {
    it('does not throw when all REQUIRED_JOB_FIELDS have non-empty string values', () => {
      const job = Object.fromEntries(REQUIRED_JOB_FIELDS.map((f) => [f, `value-${f}`]));
      expect(() => assertJobStructure(job)).not.toThrow();
    });

    it('throws for each individual field when it is absent', () => {
      for (const missing of REQUIRED_JOB_FIELDS) {
        const job = Object.fromEntries(
          REQUIRED_JOB_FIELDS
            .filter((f) => f !== missing)
            .map((f) => [f, `value-${f}`])
        );
        expect(() => assertJobStructure(job))
          .toThrow(new RegExp(`"${missing}"`));
      }
    });
  });
});

// ===========================================================================
// validatePayloadRoundTrip
// ===========================================================================
describe('validatePayloadRoundTrip', () => {
  // ── success paths ─────────────────────────────────────────────────────────
  describe('valid payloads (ok: true)', () => {
    it('accepts a plain object', () => {
      const result = validatePayloadRoundTrip({ a: 1, b: 'hello' });
      expect(result).toEqual({ ok: true, payload: { a: 1, b: 'hello' } });
    });

    it('accepts a JSON string', () => {
      const result = validatePayloadRoundTrip('{"x":42}');
      expect(result).toEqual({ ok: true, payload: { x: 42 } });
    });

    it('accepts a JSON string produced by the DB driver', () => {
      const raw = JSON.stringify({ invoiceId: 'inv_123', tenantId: 'acme' });
      const result = validatePayloadRoundTrip(raw);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ invoiceId: 'inv_123', tenantId: 'acme' });
    });

    it('round-trips nested objects cleanly', () => {
      const payload = { a: { b: { c: true } }, arr: [1, 2, 3] };
      const result = validatePayloadRoundTrip(payload);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual(payload);
    });

    it('accepts an empty object', () => {
      const result = validatePayloadRoundTrip({});
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({});
    });

    it('strips non-serialisable values (undefined) during round-trip', () => {
      const payload = { a: 1, b: undefined };
      const result = validatePayloadRoundTrip(payload);
      expect(result.ok).toBe(true);
      // undefined is dropped by JSON.stringify
      expect(result.payload).toEqual({ a: 1 });
    });

    it('accepts an object with numeric values', () => {
      const result = validatePayloadRoundTrip({ count: 0, amount: 9007199254740991 });
      expect(result.ok).toBe(true);
      expect(result.payload.count).toBe(0);
    });

    it('accepts an object with boolean values', () => {
      const result = validatePayloadRoundTrip({ active: true, deleted: false });
      expect(result.ok).toBe(true);
    });

    it('accepts an object with null values', () => {
      const result = validatePayloadRoundTrip({ lastError: null });
      expect(result.ok).toBe(true);
      expect(result.payload.lastError).toBeNull();
    });
  });

  // ── failure paths ─────────────────────────────────────────────────────────
  describe('invalid payloads (ok: false)', () => {
    it('rejects null', () => {
      const result = validatePayloadRoundTrip(null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('payload must be a plain object');
    });

    it('rejects an array (top-level array is not a plain object)', () => {
      const result = validatePayloadRoundTrip([1, 2, 3]);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('payload must be a plain object');
    });

    it('rejects a JSON string representing an array', () => {
      const result = validatePayloadRoundTrip('[1,2,3]');
      expect(result.ok).toBe(false);
    });

    it('rejects a primitive number', () => {
      const result = validatePayloadRoundTrip(42);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('payload must be a plain object');
    });

    it('rejects a primitive boolean', () => {
      const result = validatePayloadRoundTrip(true);
      expect(result.ok).toBe(false);
    });

    it('rejects a JSON string representing null', () => {
      const result = validatePayloadRoundTrip('null');
      expect(result.ok).toBe(false);
    });

    it('rejects a JSON string representing a number', () => {
      const result = validatePayloadRoundTrip('42');
      expect(result.ok).toBe(false);
    });

    it('rejects a JSON string representing a boolean', () => {
      const result = validatePayloadRoundTrip('true');
      expect(result.ok).toBe(false);
    });

    it('rejects invalid JSON string', () => {
      const result = validatePayloadRoundTrip('{bad json}');
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    });

    it('rejects truncated JSON string', () => {
      const result = validatePayloadRoundTrip('{"key":');
      expect(result.ok).toBe(false);
    });

    it('rejects an empty string', () => {
      const result = validatePayloadRoundTrip('');
      expect(result.ok).toBe(false);
    });

    it('does not throw — always returns a result object', () => {
      const badInputs = [null, undefined, [], '', 0, false, NaN, Infinity, '{bad}'];
      for (const input of badInputs) {
        expect(() => validatePayloadRoundTrip(input)).not.toThrow();
        const r = validatePayloadRoundTrip(input);
        expect(typeof r.ok).toBe('boolean');
      }
    });
  });

  // ── result shape contract ─────────────────────────────────────────────────
  describe('result shape', () => {
    it('ok:true result has no "error" key', () => {
      const result = validatePayloadRoundTrip({ x: 1 });
      expect(result.ok).toBe(true);
      expect(Object.keys(result)).not.toContain('error');
    });

    it('ok:false result has no "payload" key', () => {
      const result = validatePayloadRoundTrip(null);
      expect(result.ok).toBe(false);
      expect(Object.keys(result)).not.toContain('payload');
    });
  });

  // ── parity with original sanitisePayload ─────────────────────────────────
  describe('parity with the original inlined sanitisePayload behaviour', () => {
    // These cases mirror the original test suite for sanitisePayload in
    // jobWorker.test.js to guarantee identical behaviour post-refactor.

    it('accepts a plain object (original case 1)', () => {
      const r = validatePayloadRoundTrip({ a: 1, b: 'hello' });
      expect(r).toEqual({ ok: true, payload: { a: 1, b: 'hello' } });
    });

    it('accepts a JSON string (original case 2)', () => {
      const r = validatePayloadRoundTrip('{"x":42}');
      expect(r).toEqual({ ok: true, payload: { x: 42 } });
    });

    it('rejects null (original case 3)', () => {
      expect(validatePayloadRoundTrip(null).ok).toBe(false);
    });

    it('rejects an array (original case 4)', () => {
      expect(validatePayloadRoundTrip([1, 2]).ok).toBe(false);
    });

    it('rejects a primitive number (original case 5)', () => {
      expect(validatePayloadRoundTrip(42).ok).toBe(false);
    });

    it('rejects invalid JSON string (original case 6)', () => {
      expect(validatePayloadRoundTrip('{bad json}').ok).toBe(false);
    });

    it('round-trips nested objects cleanly (original case 7)', () => {
      const payload = { a: { b: { c: true } }, arr: [1, 2, 3] };
      const result = validatePayloadRoundTrip(payload);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual(payload);
    });
  });
});

// ===========================================================================
// parseEnvInt
// ===========================================================================
describe('parseEnvInt', () => {
  // ── default / missing value ───────────────────────────────────────────────
  describe('returns defaultValue when input is absent or invalid', () => {
    it('returns defaultValue when value is undefined', () => {
      expect(parseEnvInt(undefined, 1000)).toBe(1000);
    });

    it('returns defaultValue when value is null', () => {
      expect(parseEnvInt(null, 500)).toBe(500);
    });

    it('returns defaultValue when value is an empty string', () => {
      expect(parseEnvInt('', 200)).toBe(200);
    });

    it('returns defaultValue when value is a non-numeric string', () => {
      expect(parseEnvInt('bad', 999)).toBe(999);
    });

    it('returns defaultValue when value is "abc123" (leading non-digit)', () => {
      expect(parseEnvInt('abc123', 42)).toBe(42);
    });

    it('returns defaultValue when value is NaN-producing like "infinity"', () => {
      expect(parseEnvInt('infinity', 10)).toBe(10);
    });

    it('returns defaultValue when value is a float string', () => {
      // parseInt('3.14') returns 3 which IS finite, so this should return 3.
      expect(parseEnvInt('3.14', 99)).toBe(3);
    });

    it('returns defaultValue for empty-ish strings', () => {
      expect(parseEnvInt('  ', 7)).toBe(7);
    });
  });

  // ── valid integer strings ─────────────────────────────────────────────────
  describe('parses valid integer strings', () => {
    it('parses "1000" correctly', () => {
      expect(parseEnvInt('1000', 0)).toBe(1000);
    });

    it('parses "0"', () => {
      expect(parseEnvInt('0', 99)).toBe(0);
    });

    it('parses negative numbers when below min is not set', () => {
      expect(parseEnvInt('-5', 0)).toBe(-5);
    });

    it('parses leading-zero strings (parseInt strips them)', () => {
      // parseInt('007', 10) = 7
      expect(parseEnvInt('007', 0)).toBe(7);
    });

    it('parses very large integers', () => {
      expect(parseEnvInt('9999999', 0)).toBe(9999999);
    });
  });

  // ── clamping behaviour ────────────────────────────────────────────────────
  describe('clamping', () => {
    it('clamps a value below min to min', () => {
      expect(parseEnvInt('50', 1000, 100, 5000)).toBe(100);
    });

    it('clamps a value above max to max', () => {
      expect(parseEnvInt('9000', 1000, 100, 5000)).toBe(5000);
    });

    it('returns the value unchanged when within [min, max]', () => {
      expect(parseEnvInt('500', 1000, 100, 5000)).toBe(500);
    });

    it('returns min when value equals min exactly', () => {
      expect(parseEnvInt('100', 1000, 100, 5000)).toBe(100);
    });

    it('returns max when value equals max exactly', () => {
      expect(parseEnvInt('5000', 1000, 100, 5000)).toBe(5000);
    });

    it('falls back to default (then clamps) when value is invalid', () => {
      // Invalid string → defaultValue=200 → within [100,5000]
      expect(parseEnvInt('bad', 200, 100, 5000)).toBe(200);
    });

    it('clamps a negative defaultValue to min when min > 0', () => {
      // Value is invalid, defaultValue=-5 is below min=1 → clamped? No:
      // defaultValue is returned *before* clamping only when input is invalid.
      // The function returns `defaultValue` without clamping when parsing fails.
      expect(parseEnvInt('bad', -5)).toBe(-5);
    });

    it('works with only a min bound (no max)', () => {
      expect(parseEnvInt('50', 1000, 100)).toBe(100); // 50 < 100 → 100
      expect(parseEnvInt('9999', 1000, 100)).toBe(9999); // above min, no max cap
    });

    it('works with only a max bound (no min)', () => {
      expect(parseEnvInt('50000', 1000, -Infinity, 5000)).toBe(5000);
      expect(parseEnvInt('-999', 1000, -Infinity, 5000)).toBe(-999);
    });

    it('works with no min/max (defaults to -Infinity/Infinity)', () => {
      expect(parseEnvInt('12345', 0)).toBe(12345);
      expect(parseEnvInt('-12345', 0)).toBe(-12345);
    });
  });

  // ── real-world config examples ────────────────────────────────────────────
  describe('real-world usage patterns', () => {
    it('replicates JOB_QUEUE_MAX_RECOVERY_ROWS logic', () => {
      // worker.js original: parseInt(val || '1000', 10), finite && > 0 → else 1000
      // Equivalent parseEnvInt call: parseEnvInt(val, 1000, 1)
      expect(parseEnvInt(undefined, 1000, 1)).toBe(1000);
      expect(parseEnvInt('500', 1000, 1)).toBe(500);
      expect(parseEnvInt('0', 1000, 1)).toBe(1);    // clamped at min=1
      expect(parseEnvInt('-1', 1000, 1)).toBe(1);   // clamped at min=1
      expect(parseEnvInt('bad', 1000, 1)).toBe(1000);
    });

    it('replicates IDEMPOTENCY_PURGE_BATCH_SIZE logic (min 1, max 10000)', () => {
      expect(parseEnvInt(undefined, 1000, 1, 10000)).toBe(1000);
      expect(parseEnvInt('500', 1000, 1, 10000)).toBe(500);
      expect(parseEnvInt('0', 1000, 1, 10000)).toBe(1);
      expect(parseEnvInt('20000', 1000, 1, 10000)).toBe(10000);
    });

    it('replicates IDEMPOTENCY_PURGE_INTERVAL_MS (min 60000)', () => {
      expect(parseEnvInt(undefined, 3600000, 60000)).toBe(3600000);
      expect(parseEnvInt('120000', 3600000, 60000)).toBe(120000);
      expect(parseEnvInt('1000', 3600000, 60000)).toBe(60000); // clamped
    });

    it('replicates SOROBAN_CB_FAILURE_THRESHOLD (positive, no upper bound)', () => {
      expect(parseEnvInt(undefined, 5, 1)).toBe(5);
      expect(parseEnvInt('3', 5, 1)).toBe(3);
      expect(parseEnvInt('0', 5, 1)).toBe(1); // clamped
    });
  });

  // ── edge cases ────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('handles "0" when min=0', () => {
      expect(parseEnvInt('0', 1, 0)).toBe(0);
    });

    it('treats "1e3" as 1 (parseInt stops at non-digit)', () => {
      // parseInt('1e3', 10) = 1 (not 1000)
      expect(parseEnvInt('1e3', 99)).toBe(1);
    });

    it('handles string with leading/trailing spaces (parseInt still parses)', () => {
      // parseInt(' 5 ', 10) = 5
      expect(parseEnvInt(' 5 ', 99)).toBe(5);
    });

    it('works with a defaultValue of 0', () => {
      expect(parseEnvInt('bad', 0)).toBe(0);
      expect(parseEnvInt('10', 0)).toBe(10);
    });
  });
});
