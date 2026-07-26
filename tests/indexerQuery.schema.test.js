'use strict';

/**
 * @fileoverview Comprehensive tests for indexer query validation schemas (#930).
 *
 * Covers:
 *  - indexerQuerySchema: valid passes, invalid rejected with details
 *  - validateIndexerQuery: integration helper producing field-level errors
 *  - parseValidationErrors: Zod error formatting
 *  - Edge cases: unknown params, boundary values, type coercion
 */

const {
  indexerQuerySchema,
  validateIndexerQuery,
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  MAX_LIMIT,
} = require('../src/schemas/indexerQuery');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CONTRACT_ID = 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI';

// ─────────────────────────────────────────────────────────────────────────────
// Regex exports
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema constants', () => {
  test('INVOICE_ID_REGEX matches valid invoice IDs', () => {
    expect(INVOICE_ID_REGEX.test('inv_123')).toBe(true);
    expect(INVOICE_ID_REGEX.test('a')).toBe(true);
    expect(INVOICE_ID_REGEX.test('A'.repeat(128))).toBe(true);
    expect(INVOICE_ID_REGEX.test('my-invoice-001')).toBe(true);
  });

  test('INVOICE_ID_REGEX rejects invalid invoice IDs', () => {
    expect(INVOICE_ID_REGEX.test('')).toBe(false);
    expect(INVOICE_ID_REGEX.test('has spaces')).toBe(false);
    expect(INVOICE_ID_REGEX.test('a'.repeat(129))).toBe(false);
    expect(INVOICE_ID_REGEX.test('special!chars')).toBe(false);
  });

  test('CONTRACT_ID_REGEX matches valid Stellar contract IDs', () => {
    expect(CONTRACT_ID_REGEX.test(VALID_CONTRACT_ID)).toBe(true);
  });

  test('CONTRACT_ID_REGEX rejects invalid contract IDs', () => {
    expect(CONTRACT_ID_REGEX.test('BADADDR')).toBe(false);
    expect(CONTRACT_ID_REGEX.test('')).toBe(false);
    expect(CONTRACT_ID_REGEX.test('D' + 'A'.repeat(55))).toBe(false); // Wrong prefix
    expect(CONTRACT_ID_REGEX.test('C' + 'A'.repeat(54))).toBe(false); // Too short
  });

  test('MAX_LIMIT is 100', () => {
    expect(MAX_LIMIT).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// indexerQuerySchema
// ─────────────────────────────────────────────────────────────────────────────

describe('indexerQuerySchema', () => {
  describe('valid payloads', () => {
    test('empty object (all fields optional)', () => {
      const result = indexerQuerySchema.safeParse({});
      expect(result.success).toBe(true);
    });

    test('all valid filter params', () => {
      const result = indexerQuerySchema.safeParse({
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        contractId: VALID_CONTRACT_ID,
      });
      expect(result.success).toBe(true);
      expect(result.data.invoiceId).toBe('inv_001');
      expect(result.data.eventType).toBe('escrow_created');
      expect(result.data.contractId).toBe(VALID_CONTRACT_ID);
    });

    test('valid sorting params', () => {
      const result = indexerQuerySchema.safeParse({
        sortBy: 'observed_at',
        order: 'asc',
      });
      expect(result.success).toBe(true);
      expect(result.data.sortBy).toBe('observed_at');
      // Order is lowercased by transform
      expect(result.data.order).toBe('asc');
    });

    test('order is case-insensitive', () => {
      const asc = indexerQuerySchema.safeParse({ order: 'ASC' });
      expect(asc.success).toBe(true);
      expect(asc.data.order).toBe('asc');

      const desc = indexerQuerySchema.safeParse({ order: 'DESC' });
      expect(desc.success).toBe(true);
      expect(desc.data.order).toBe('desc');

      const mixed = indexerQuerySchema.safeParse({ order: 'Desc' });
      expect(mixed.success).toBe(true);
      expect(mixed.data.order).toBe('desc');
    });

    test('valid pagination params (offset mode)', () => {
      const result = indexerQuerySchema.safeParse({
        page: '3',
        limit: '20',
      });
      expect(result.success).toBe(true);
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(20);
    });

    test('valid cursor pagination', () => {
      const cursor = 'someValidCursor.abc123';
      const result = indexerQuerySchema.safeParse({ cursor });
      expect(result.success).toBe(true);
      expect(result.data.cursor).toBe(cursor);
    });

    test('all valid params together', () => {
      const result = indexerQuerySchema.safeParse({
        invoiceId: 'inv_001',
        eventType: 'escrow_funded',
        sortBy: 'ledger_sequence',
        order: 'desc',
        page: '1',
        limit: '50',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid payloads', () => {
    test('invalid invoiceId (contains space)', () => {
      const result = indexerQuerySchema.safeParse({
        invoiceId: 'has spaces',
      });
      expect(result.success).toBe(false);
    });

    test('invoiceId too long (>128 chars)', () => {
      const result = indexerQuerySchema.safeParse({
        invoiceId: 'a'.repeat(129),
      });
      expect(result.success).toBe(false);
    });

    test('eventType too long (>128 chars)', () => {
      const result = indexerQuerySchema.safeParse({
        eventType: 'a'.repeat(129),
      });
      expect(result.success).toBe(false);
    });

    test('eventType empty string', () => {
      const result = indexerQuerySchema.safeParse({
        eventType: '',
      });
      expect(result.success).toBe(false);
    });

    test('invalid contractId format', () => {
      const result = indexerQuerySchema.safeParse({
        contractId: 'BADADDR',
      });
      expect(result.success).toBe(false);
    });

    test('invalid sortBy', () => {
      const result = indexerQuerySchema.safeParse({
        sortBy: 'yield_bps',
      });
      expect(result.success).toBe(false);
    });

    test('invalid order', () => {
      const result = indexerQuerySchema.safeParse({
        order: 'sideways',
      });
      expect(result.success).toBe(false);
    });

    test('page = 0 (below minimum)', () => {
      const result = indexerQuerySchema.safeParse({ page: '0' });
      expect(result.success).toBe(false);
    });

    test('page = negative', () => {
      const result = indexerQuerySchema.safeParse({ page: '-5' });
      expect(result.success).toBe(false);
    });

    test('page = non-numeric string', () => {
      const result = indexerQuerySchema.safeParse({ page: 'abc' });
      expect(result.success).toBe(false);
    });

    test('limit = 0 (below minimum)', () => {
      const result = indexerQuerySchema.safeParse({ limit: '0' });
      expect(result.success).toBe(false);
    });

    test('limit > 100 (above maximum)', () => {
      const result = indexerQuerySchema.safeParse({ limit: '101' });
      expect(result.success).toBe(false);
    });

    test('limit = negative', () => {
      const result = indexerQuerySchema.safeParse({ limit: '-1' });
      expect(result.success).toBe(false);
    });

    test('limit = non-numeric string', () => {
      const result = indexerQuerySchema.safeParse({ limit: 'abc' });
      expect(result.success).toBe(false);
    });

    test('cursor = empty string', () => {
      const result = indexerQuerySchema.safeParse({ cursor: '' });
      expect(result.success).toBe(false);
    });

    test('cursor > 2048 chars', () => {
      const result = indexerQuerySchema.safeParse({ cursor: 'a'.repeat(2049) });
      expect(result.success).toBe(false);
    });
  });

  describe('boundary values', () => {
    test('invoiceId = 1 char (min)', () => {
      const result = indexerQuerySchema.safeParse({ invoiceId: 'a' });
      expect(result.success).toBe(true);
    });

    test('invoiceId = 128 chars (max)', () => {
      const result = indexerQuerySchema.safeParse({ invoiceId: 'a'.repeat(128) });
      expect(result.success).toBe(true);
    });

    test('eventType = 1 char (min)', () => {
      const result = indexerQuerySchema.safeParse({ eventType: 'x' });
      expect(result.success).toBe(true);
    });

    test('eventType = 128 chars (max)', () => {
      const result = indexerQuerySchema.safeParse({ eventType: 'x'.repeat(128) });
      expect(result.success).toBe(true);
    });

    test('page = 1 (min)', () => {
      const result = indexerQuerySchema.safeParse({ page: '1' });
      expect(result.success).toBe(true);
      expect(result.data.page).toBe(1);
    });

    test('page = 999999 (large valid)', () => {
      const result = indexerQuerySchema.safeParse({ page: '999999' });
      expect(result.success).toBe(true);
      expect(result.data.page).toBe(999999);
    });

    test('limit = 1 (min)', () => {
      const result = indexerQuerySchema.safeParse({ limit: '1' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(1);
    });

    test('limit = 100 (max)', () => {
      const result = indexerQuerySchema.safeParse({ limit: '100' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(100);
    });

    test('cursor = 2048 chars (max)', () => {
      const result = indexerQuerySchema.safeParse({ cursor: 'a'.repeat(2048) });
      expect(result.success).toBe(true);
    });

    test('sortBy = ledger_sequence (valid alternative)', () => {
      const result = indexerQuerySchema.safeParse({ sortBy: 'ledger_sequence' });
      expect(result.success).toBe(true);
      expect(result.data.sortBy).toBe('ledger_sequence');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseValidationErrors
// ─────────────────────────────────────────────────────────────────────────────

describe('parseValidationErrors', () => {
  test('formats a single Zod error', () => {
    const result = indexerQuerySchema.safeParse({ invoiceId: 'bad id' });
    expect(result.success).toBe(false);
    const fieldErrors = parseValidationErrors(result.error);
    expect(fieldErrors).toHaveProperty('invoiceId');
    expect(typeof fieldErrors.invoiceId).toBe('string');
  });

  test('formats multiple Zod errors', () => {
    const result = indexerQuerySchema.safeParse({
      invoiceId: 'bad id',
      eventType: '',
      sortBy: 'invalid',
    });
    expect(result.success).toBe(false);
    const fieldErrors = parseValidationErrors(result.error);
    expect(Object.keys(fieldErrors).length).toBeGreaterThanOrEqual(3);
    expect(fieldErrors).toHaveProperty('invoiceId');
    expect(fieldErrors).toHaveProperty('eventType');
    expect(fieldErrors).toHaveProperty('sortBy');
  });

  test('uses first error per field', () => {
    // Limit has both min and max — only first issue is kept
    const result = indexerQuerySchema.safeParse({ limit: '-5' });
    expect(result.success).toBe(false);
    const fieldErrors = parseValidationErrors(result.error);
    expect(fieldErrors).toHaveProperty('limit');
    expect(typeof fieldErrors.limit).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateIndexerQuery (integration helper)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateIndexerQuery', () => {
  describe('valid queries', () => {
    test('empty query → valid with empty params', () => {
      const result = validateIndexerQuery({});
      expect(result.isValid).toBe(true);
      expect(result.fieldErrors).toEqual({});
      expect(result.params).toEqual({
        filters: {},
        sorting: {},
        pagination: {},
      });
    });

    test('valid invoiceId filter', () => {
      const result = validateIndexerQuery({ invoiceId: 'inv_001' });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.invoiceId).toBe('inv_001');
    });

    test('valid eventType filter', () => {
      const result = validateIndexerQuery({ eventType: 'escrow_created' });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.eventType).toBe('escrow_created');
    });

    test('valid contractId filter', () => {
      const result = validateIndexerQuery({ contractId: VALID_CONTRACT_ID });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.contractId).toBe(VALID_CONTRACT_ID);
    });

    test('valid sortBy', () => {
      const result = validateIndexerQuery({ sortBy: 'observed_at' });
      expect(result.isValid).toBe(true);
      expect(result.params.sorting.sortBy).toBe('observed_at');
    });

    test('valid order', () => {
      const result = validateIndexerQuery({ order: 'ASC' });
      expect(result.isValid).toBe(true);
      expect(result.params.sorting.order).toBe('asc');
    });

    test('valid cursor', () => {
      const cursor = 'testCursorValue.sig';
      const result = validateIndexerQuery({ cursor });
      expect(result.isValid).toBe(true);
      expect(result.params.pagination.cursor).toBe(cursor);
    });

    test('valid page', () => {
      const result = validateIndexerQuery({ page: '5' });
      expect(result.isValid).toBe(true);
      expect(result.params.pagination.page).toBe(5);
    });

    test('valid limit', () => {
      const result = validateIndexerQuery({ limit: '25' });
      expect(result.isValid).toBe(true);
      expect(result.params.pagination.limit).toBe(25);
    });

    test('all valid params combined', () => {
      const result = validateIndexerQuery({
        invoiceId: 'inv_001',
        eventType: 'escrow_funded',
        sortBy: 'ledger_sequence',
        order: 'desc',
        limit: '10',
      });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.invoiceId).toBe('inv_001');
      expect(result.params.filters.eventType).toBe('escrow_funded');
      expect(result.params.sorting.sortBy).toBe('ledger_sequence');
      expect(result.params.sorting.order).toBe('desc');
      expect(result.params.pagination.limit).toBe(10);
    });
  });

  describe('invalid queries', () => {
    test('unknown parameters → rejected', () => {
      const result = validateIndexerQuery({ foo: 'bar', baz: 1 });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors._unknown).toMatch(/Unknown query parameters/);
      expect(result.fieldErrors._unknown).toMatch(/foo/);
      expect(result.fieldErrors._unknown).toMatch(/baz/);
    });

    test('invalid invoiceId → field error', () => {
      const result = validateIndexerQuery({ invoiceId: 'has spaces' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('invoiceId');
    });

    test('invalid eventType → field error', () => {
      const result = validateIndexerQuery({ eventType: '' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('eventType');
    });

    test('invalid contractId → field error', () => {
      const result = validateIndexerQuery({ contractId: 'BADADDR' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('contractId');
    });

    test('invalid sortBy → field error', () => {
      const result = validateIndexerQuery({ sortBy: 'yield_bps' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('sortBy');
    });

    test('invalid order → field error', () => {
      const result = validateIndexerQuery({ order: 'sideways' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('order');
    });

    test('invalid limit (0) → field error', () => {
      const result = validateIndexerQuery({ limit: '0' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('limit');
    });

    test('invalid limit (>100) → field error', () => {
      const result = validateIndexerQuery({ limit: '101' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('limit');
    });

    test('invalid page (0) → field error', () => {
      const result = validateIndexerQuery({ page: '0' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('page');
    });

    test('invalid cursor (empty) → field error', () => {
      const result = validateIndexerQuery({ cursor: '' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('cursor');
    });

    test('multiple invalid fields → multiple errors', () => {
      const result = validateIndexerQuery({
        invoiceId: 'bad id',
        sortBy: 'invalid',
        limit: '200',
      });
      expect(result.isValid).toBe(false);
      expect(Object.keys(result.fieldErrors).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('edge cases', () => {
    test('invoiceId with underscores and hyphens', () => {
      const result = validateIndexerQuery({ invoiceId: 'inv_001-test' });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.invoiceId).toBe('inv_001-test');
    });

    test('invoiceId whitespace is trimmed', () => {
      const result = validateIndexerQuery({ invoiceId: '  inv_001  ' });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.invoiceId).toBe('inv_001');
    });

    test('eventType with valid special chars', () => {
      const result = validateIndexerQuery({ eventType: 'escrow.created.v2' });
      expect(result.isValid).toBe(true);
      expect(result.params.filters.eventType).toBe('escrow.created.v2');
    });

    test('limit = "1" (string) converts to number 1', () => {
      const result = validateIndexerQuery({ limit: '1' });
      expect(result.isValid).toBe(true);
      expect(result.params.pagination.limit).toBe(1);
      expect(typeof result.params.pagination.limit).toBe('number');
    });

    test('page = "100" (string) converts to number 100', () => {
      const result = validateIndexerQuery({ page: '100' });
      expect(result.isValid).toBe(true);
      expect(result.params.pagination.page).toBe(100);
      expect(typeof result.params.pagination.page).toBe('number');
    });

    test('page = non-numeric string → rejected', () => {
      const result = validateIndexerQuery({ page: 'abc' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('page');
    });

    test('limit = non-numeric string → rejected', () => {
      const result = validateIndexerQuery({ limit: 'abc' });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('limit');
    });

    test('contractId validation rejects non-Stellar addresses', () => {
      // Valid length but wrong prefix
      const result = validateIndexerQuery({ contractId: 'D' + 'A'.repeat(55) });
      expect(result.isValid).toBe(false);
      expect(result.fieldErrors).toHaveProperty('contractId');
    });

    test('sortBy = ledger_sequence is accepted', () => {
      const result = validateIndexerQuery({ sortBy: 'ledger_sequence' });
      expect(result.isValid).toBe(true);
      expect(result.params.sorting.sortBy).toBe('ledger_sequence');
    });

    test('sortBy = observed_at is accepted', () => {
      const result = validateIndexerQuery({ sortBy: 'observed_at' });
      expect(result.isValid).toBe(true);
      expect(result.params.sorting.sortBy).toBe('observed_at');
    });

    test('returns empty params on invalid input', () => {
      const result = validateIndexerQuery({ sortBy: 'invalid' });
      expect(result.isValid).toBe(false);
      expect(result.params).toEqual({});
    });
  });
});
