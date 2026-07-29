'use strict';

/**
 * @fileoverview Tests for the unified escrow-read validation helper.
 *
 * Issue #646 — Extracts and deduplicates escrow-read validation into a single
 * shared helper.  This test suite verifies that:
 *
 *  1. `validateInvoiceId` (services/escrowRead.js) delegates to the canonical
 *     Zod schema in `schemas/escrowRead.js` and preserves the `{ valid, reason }`
 *     contract.
 *
 *  2. `validateEscrowReadParams` (schemas/escrowRead.js) is the single source
 *     of truth — the Zod `escrowReadParamsSchema` — and returns
 *     `{ success, data, fieldErrors }`.
 *
 *  3. Both functions agree on validity for every significant input, so no
 *     path drifts.
 *
 *  4. Error reason messages are human-readable and non-empty on failure.
 */

const {
  validateInvoiceId,
} = require('../../src/services/escrowRead');

const {
  escrowReadParamsSchema,
  validateEscrowReadParams,
} = require('../../src/schemas/escrowRead');

// ── Helper: converts validateInvoiceId-style result to a boolean ──────────────
const isValid = (result) => result.valid === true;

// ── Helper: converts validateEscrowReadParams-style result to a boolean ───────
const paramsSuccess = (result) => result.success === true;

// ──────────────────────────────────────────────────────────────────────────────
// 1.  Shared behaviour:  validateInvoiceId ↔ validateEscrowReadParams
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — cross-check', () => {
  const validIds = [
    'inv_123',
    'INV-001',
    'inv.001:v2',
    'a',
    'Z',
    '9',
    'inv-001-abc',
    'InV001ABC',
    'a' + 'b'.repeat(126),   // 127 chars
    'a' + 'b'.repeat(127),   // 128 chars (max allowed)
  ];

  const invalidIds = [
    '',
    '   ',
    ' ',
    '-inv123',
    '_inv123',
    '.inv123',
    ':inv123',
    'inv 123',
    'inv@123',
    'inv/123',
    'a' + 'b'.repeat(128),   // 129 chars
  ];

  describe.each(validIds)('valid input: %j', (invoiceId) => {
    it('validateInvoiceId reports valid', () => {
      expect(validateInvoiceId(invoiceId).valid).toBe(true);
    });

    it('validateEscrowReadParams reports success', () => {
      const result = validateEscrowReadParams({ invoiceId });
      expect(result.success).toBe(true);
      expect(result.data.invoiceId).toBe(invoiceId);
    });

    it('escrowReadParamsSchema accepts directly', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId });
      expect(result.success).toBe(true);
    });
  });

  describe.each(invalidIds)('invalid input: %j', (invoiceId) => {
    it('validateInvoiceId reports invalid', () => {
      expect(validateInvoiceId(invoiceId).valid).toBe(false);
    });

    it('validateEscrowReadParams reports failure', () => {
      const result = validateEscrowReadParams({ invoiceId });
      expect(result.success).toBe(false);
      expect(result.fieldErrors).toBeDefined();
    });

    it('escrowReadParamsSchema rejects directly', () => {
      const result = escrowReadParamsSchema.safeParse({ invoiceId });
      expect(result.success).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2.  Non-string types — both validation paths reject identically
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — non-string inputs', () => {
  const nonStringValues = [
    [null, 'null'],
    [undefined, 'undefined'],
    [12345, 'number'],
    [{ id: 'inv_001' }, 'object'],
    [[], 'array'],
    [true, 'boolean true'],
  ];

  describe.each(nonStringValues)('%s (%s)', (value) => {
    it('validateInvoiceId rejects non-string', () => {
      expect(validateInvoiceId(value).valid).toBe(false);
    });

    it('validateEscrowReadParams rejects non-string object shape', () => {
      const result = validateEscrowReadParams({ invoiceId: value });
      expect(result.success).toBe(false);
    });
  });

  it('validateEscrowReadParams rejects missing invoiceId key', () => {
    const result = validateEscrowReadParams({});
    expect(result.success).toBe(false);
  });

  it('validateEscrowReadParams rejects extra keys (strict)', () => {
    const result = validateEscrowReadParams({ invoiceId: 'inv_123', extra: true });
    expect(result.success).toBe(false);
    // The schema is strict — unrecognized keys cause failure
    expect(result.fieldErrors).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3.  Error reason messages are present and human-readable
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — error messages', () => {
  it('validateInvoiceId includes non-empty reason on failure', () => {
    const r1 = validateInvoiceId('');
    expect(r1.valid).toBe(false);
    expect(typeof r1.reason).toBe('string');
    expect(r1.reason.length).toBeGreaterThan(0);

    const r2 = validateInvoiceId('inv@123');
    expect(r2.valid).toBe(false);
    expect(typeof r2.reason).toBe('string');
    expect(r2.reason.length).toBeGreaterThan(0);
  });

  it('validateInvoiceId has no reason on success', () => {
    const r = validateInvoiceId('inv_123');
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('validateEscrowReadParams returns fieldErrors on failure', () => {
    const r = validateEscrowReadParams({ invoiceId: '' });
    expect(r.success).toBe(false);
    expect(r.fieldErrors).toBeDefined();
    expect(typeof r.fieldErrors).toBe('object');
    expect(Object.keys(r.fieldErrors).length).toBeGreaterThan(0);
  });

  it('validateEscrowReadParams fieldErrors includes invoiceId', () => {
    const r = validateEscrowReadParams({ invoiceId: '' });
    expect(r.fieldErrors.invoiceId).toBeDefined();
    expect(typeof r.fieldErrors.invoiceId).toBe('string');
    expect(r.fieldErrors.invoiceId.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4.  Boundary length 128 (edge case — exactly at max)
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — boundary lengths', () => {
  it('accepts exactly 128-character valid ID', () => {
    const id = 'a' + 'b'.repeat(127); // 128 chars
    expect(id).toHaveLength(128);

    expect(validateInvoiceId(id).valid).toBe(true);
    expect(validateEscrowReadParams({ invoiceId: id }).success).toBe(true);
  });

  it('accepts exactly 1-character valid ID', () => {
    expect(validateInvoiceId('a').valid).toBe(true);
    expect(validateEscrowReadParams({ invoiceId: 'a' }).success).toBe(true);
  });

  it('rejects 0-character (empty) ID', () => {
    expect(validateInvoiceId('').valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: '' }).success).toBe(false);
  });

  it('rejects 129-character ID (overflow)', () => {
    const id = 'a' + 'b'.repeat(128); // 129 chars
    expect(id).toHaveLength(129);

    expect(validateInvoiceId(id).valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: id }).success).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5.  Leading-character rules — must start with alphanumeric
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — leading character rules', () => {
  const leadingSpecialIds = ['-', '_', '.', ':'].map((ch) => ch + 'abc123');

  describe.each(leadingSpecialIds)('ID starting with %s', (id) => {
    it('validateInvoiceId rejects', () => {
      expect(validateInvoiceId(id).valid).toBe(false);
    });

    it('validateEscrowReadParams rejects', () => {
      expect(validateEscrowReadParams({ invoiceId: id }).success).toBe(false);
    });
  });

  const leadingValidIds = ['a', 'Z', '0', '9'].map((ch) => ch);

  describe.each(leadingValidIds)('single-char valid ID: %s', (id) => {
    it('both validators accept', () => {
      expect(validateInvoiceId(id).valid).toBe(true);
      expect(validateEscrowReadParams({ invoiceId: id }).success).toBe(true);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6.  Regression guards — scenarios from the existing regression suite that
//     must still reject identically after the refactor
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — regression guards', () => {
  // Whitespace-only — must reject (old code trimmed and checked empty;
  // new Zod schema rejects via regex)
  it('rejects whitespace-only string', () => {
    expect(validateInvoiceId('   ').valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: '   ' }).success).toBe(false);
  });

  // Single space (simulates URL-encoded space %20 decoded by Express)
  it('rejects single-space string', () => {
    expect(validateInvoiceId(' ').valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: ' ' }).success).toBe(false);
  });

  // Internal space — must reject
  it('rejects ID containing internal space', () => {
    expect(validateInvoiceId('inv 123').valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: 'inv 123' }).success).toBe(false);
  });

  // Forward slash — must reject (old rejection: "contains invalid characters")
  it('rejects ID with forward slash', () => {
    expect(validateInvoiceId('inv/123').valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: 'inv/123' }).success).toBe(false);
  });

  // At-sign — must reject
  it('rejects ID with @ character', () => {
    expect(validateInvoiceId('inv@123').valid).toBe(false);
    expect(validateEscrowReadParams({ invoiceId: 'inv@123' }).success).toBe(false);
  });

  // Mixed case — must accept
  it('accepts mixed-case alphanumeric ID', () => {
    expect(validateInvoiceId('InV001ABC').valid).toBe(true);
    expect(validateEscrowReadParams({ invoiceId: 'InV001ABC' }).success).toBe(true);
  });

  // Allowed special chars mid-string: hyphen, dot, colon, underscore
  it('accepts IDs with mid-string special chars', () => {
    const ids = ['inv-001-abc', 'inv.001:v2', 'inv_001'];
    for (const id of ids) {
      expect(validateInvoiceId(id).valid).toBe(true);
      expect(validateEscrowReadParams({ invoiceId: id }).success).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 7.  Contract: `validateInvoiceId` return shape is stable
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — return shape contract', () => {
  it('success shape: { valid: true } only', () => {
    const r = validateInvoiceId('inv_123');
    expect(r).toEqual({ valid: true });
  });

  it('failure shape: { valid: false, reason: string }', () => {
    const r = validateInvoiceId('');
    expect(r).toHaveProperty('valid', false);
    expect(r).toHaveProperty('reason');
    expect(typeof r.reason).toBe('string');
    // No extra properties leaked
    expect(Object.keys(r).sort()).toEqual(['reason', 'valid']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 8.  Contract: `validateEscrowReadParams` return shape is stable
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — params return shape contract', () => {
  it('success shape: { success: true, data: { invoiceId } }', () => {
    const r = validateEscrowReadParams({ invoiceId: 'inv_123' });
    expect(r).toHaveProperty('success', true);
    expect(r).toHaveProperty('data');
    expect(r.data).toEqual({ invoiceId: 'inv_123' });
    // No extra properties
    expect(Object.keys(r).sort()).toEqual(['data', 'success']);
  });

  it('failure shape: { success: false, fieldErrors: object }', () => {
    const r = validateEscrowReadParams({ invoiceId: '' });
    expect(r).toHaveProperty('success', false);
    expect(r).toHaveProperty('fieldErrors');
    expect(typeof r.fieldErrors).toBe('object');
    expect(Object.keys(r).sort()).toEqual(['fieldErrors', 'success']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 9.  Zod schema is the single source of truth
// ──────────────────────────────────────────────────────────────────────────────

describe('unified escrow-read validation — Zod schema is canonical', () => {
  it('escrowReadParamsSchema is strict (rejects unknown keys)', () => {
    const r = escrowReadParamsSchema.safeParse({ invoiceId: 'inv_123', unknown: true });
    expect(r.success).toBe(false);
  });

  it('escrowReadParamsSchema returns trimmed invoiceId (no Zod transform)', () => {
    // The schema does NOT apply .transform((v) => v.trim());
    // It validates the raw value as-is via regex.
    const r = escrowReadParamsSchema.safeParse({ invoiceId: 'inv_123' });
    expect(r.success).toBe(true);
    expect(r.data.invoiceId).toBe('inv_123');
  });
});
