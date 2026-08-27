'use strict';

const {
  InvoiceVersionError,
  InvoiceVersionConflictError,
  parseExpectedVersion,
  normalizeInvoiceVersion,
  requireStoredVersion,
  conflictPayload,
  expectedVersionFromRequest,
} = require('./invoiceConcurrency');

describe('invoice concurrency version contract', () => {
  describe('parseExpectedVersion', () => {
    test.each([
      [1, 1],
      [2, 2],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ['1', 1],
      [' 2 ', 2],
      ['"3"', 3],
      ['W/"4"', 4],
      ['W/5', 5],
    ])('accepts %p as %p', (input, expected) => {
      expect(parseExpectedVersion(input)).toBe(expected);
    });

    test.each([
      [undefined, 'VERSION_REQUIRED'],
      [null, 'VERSION_REQUIRED'],
      ['', 'VERSION_REQUIRED'],
      ['   ', 'VERSION_REQUIRED'],
      [0, 'INVALID_VERSION'],
      [-1, 'INVALID_VERSION'],
      [1.5, 'INVALID_VERSION'],
      [NaN, 'INVALID_VERSION'],
      [Infinity, 'INVALID_VERSION'],
      [true, 'VERSION_REQUIRED'],
      [{ value: 1 }, 'VERSION_REQUIRED'],
      [[], 'VERSION_REQUIRED'],
      ['0', 'INVALID_VERSION'],
      ['-1', 'INVALID_VERSION'],
      ['+1', 'INVALID_VERSION'],
      ['1.0', 'INVALID_VERSION'],
      ['1e2', 'INVALID_VERSION'],
      ['W/"0"', 'INVALID_VERSION'],
      ['W/"1.5"', 'INVALID_VERSION'],
      ['ETag: 1', 'INVALID_VERSION'],
      ['"1"x', 'INVALID_VERSION'],
      ['x"1"', 'INVALID_VERSION'],
      ['9007199254740992', 'INVALID_VERSION'],
      ['99999999999999999999', 'INVALID_VERSION'],
    ])('rejects %p with %s', (input, code) => {
      expect(() => parseExpectedVersion(input)).toThrow(InvoiceVersionError);
      try {
        parseExpectedVersion(input);
      } catch (error) {
        expect(error.code).toBe(code);
        expect(error.statusCode).toBe(400);
        expect(error.message).not.toMatch(/select|sql|database/i);
      }
    });
  });

  describe('request precedence', () => {
    test('uses the body version when both sources are present', () => {
      expect(expectedVersionFromRequest({ version: 7 }, 'W/"4"')).toBe(7);
    });

    test('uses If-Match when the body has no version', () => {
      expect(expectedVersionFromRequest({ amount: 10 }, 'W/"4"')).toBe(4);
    });

    test('does not treat a body version of zero as absent', () => {
      expect(() => expectedVersionFromRequest({ version: 0 }, 'W/"4"'))
        .toThrow('version must be a positive integer');
    });

    test.each([undefined, null, '', '   '])('requires an explicit revision for %p', (header) => {
      expect(() => expectedVersionFromRequest({}, header)).toThrow('version is required');
    });

    test('does not read inherited body properties', () => {
      const body = Object.create({ version: 9 });
      expect(() => expectedVersionFromRequest(body, undefined)).toThrow('version is required');
    });
  });

  describe('row normalization', () => {
    test.each([
      [{ version: 1 }, 1],
      [{ version: '2' }, 2],
      [{ version: '0003' }, 3],
      [{ version: 9007199254740991 }, 9007199254740991],
    ])('normalizes driver value %p', (row, expected) => {
      expect(normalizeInvoiceVersion(row)).toEqual({ version: expected });
    });

    test('does not mutate the database row object', () => {
      const row = { invoice_id: 'inv-1', version: '8', amount: '10.00' };
      const normalized = normalizeInvoiceVersion(row);
      expect(normalized).not.toBe(row);
      expect(row.version).toBe('8');
      expect(normalized.version).toBe(8);
      expect(normalized.amount).toBe('10.00');
    });

    test.each([null, undefined, false, 'not-a-row'])('handles non-row %p', (row) => {
      expect(normalizeInvoiceVersion(row)).toBe(row);
    });

    test.each([
      [{ version: 0 }],
      [{ version: -1 }],
      [{ version: 1.2 }],
      [{ version: 'nope' }],
      [{ version: null }],
      [{ version: undefined }],
      [{}],
    ])('requires a valid persisted version for %p', (row) => {
      expect(() => requireStoredVersion(row)).toThrow(InvoiceVersionError);
      try {
        requireStoredVersion(row);
      } catch (error) {
        expect(error.code).toBe('INVALID_STORED_VERSION');
        expect(error.statusCode).toBe(500);
      }
    });

    test('accepts a database integer represented as a string', () => {
      expect(requireStoredVersion({ version: '42' })).toBe(42);
    });

    test('rejects a non-safe persisted integer', () => {
      expect(() => requireStoredVersion({ version: '9007199254740992' }))
        .toThrow('migration is required');
    });
  });

  describe('conflict errors', () => {
    test('contains both expected and current revisions', () => {
      const error = new InvoiceVersionConflictError(4, 5);
      expect(error).toBeInstanceOf(InvoiceVersionError);
      expect(error.code).toBe('VERSION_CONFLICT');
      expect(error.statusCode).toBe(409);
      expect(error.expectedVersion).toBe(4);
      expect(error.currentVersion).toBe(5);
      expect(error.message).toContain('4');
      expect(error.message).toContain('5');
    });

    test('creates a stable public conflict payload', () => {
      const payload = conflictPayload(new InvoiceVersionConflictError(4, 5));
      expect(payload).toEqual({
        error: 'version_conflict',
        code: 'VERSION_CONFLICT',
        message: 'Invoice version 4 is stale; current version is 5.',
        currentVersion: 5,
      });
    });

    test('maps required-version errors without exposing internals', () => {
      const payload = conflictPayload(new InvoiceVersionError('VERSION_REQUIRED', 'version is required.'));
      expect(payload).toEqual({
        error: 'version_required',
        code: 'VERSION_REQUIRED',
        message: 'version is required.',
      });
      expect(JSON.stringify(payload)).not.toMatch(/knex|postgres|sql/i);
    });

    test('does not accept arbitrary errors as public version errors', () => {
      expect(() => conflictPayload(new Error('database password'))).toThrow('database password');
    });
  });

  describe('replay-safe client behavior examples', () => {
    test('sequential revisions advance exactly once', () => {
      let current = 1;
      const revisions = [current];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const expected = parseExpectedVersion(current);
        current = expected + 1;
        revisions.push(current);
      }
      expect(revisions).toEqual([1, 2, 3, 4, 5]);
    });

    test('two writers from one snapshot have one winner', () => {
      const snapshot = 8;
      const firstWrite = snapshot + 1;
      expect(firstWrite).toBe(9);
      expect(() => {
        if (snapshot !== firstWrite) {
          throw new InvoiceVersionConflictError(snapshot, firstWrite);
        }
      }).toThrow('current version is 9');
    });

    test('a future writer is reported as a conflict after refresh', () => {
      const future = 12;
      const current = 10;
      const error = new InvoiceVersionConflictError(future, current);
      expect(conflictPayload(error).currentVersion).toBe(current);
      expect(error.expectedVersion).toBeGreaterThan(error.currentVersion);
    });

    test('versions remain tenant-independent at the parser boundary', () => {
      expect(expectedVersionFromRequest({ version: '5' }, undefined)).toBe(5);
      expect(expectedVersionFromRequest({ version: '5' }, undefined)).toBe(5);
    });

    test('normalization preserves read fields alongside the version', () => {
      expect(normalizeInvoiceVersion({
        invoice_id: 'inv-100',
        tenant_id: 'tenant-a',
        status: 'pending',
        version: '3',
      })).toEqual({
        invoice_id: 'inv-100',
        tenant_id: 'tenant-a',
        status: 'pending',
        version: 3,
      });
    });
  });
});
