'use strict';

/**
 * @fileoverview Comprehensive tests for the shared validation helper.
 *
 * Covers:
 *  - createBodyValidator middleware factory
 *  - createQueryValidator middleware factory
 *  - RFC 7807 problem+json response structure
 *  - Field error mapping
 *  - Custom options (problemType, title, code, detail)
 *  - Edge cases (empty body, null values, arrays, primitives)
 */

const { z } = require('zod');
const {
  createBodyValidator,
  createQueryValidator,
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
  DEFAULT_PROBLEM_TYPE,
  DEFAULT_ERROR_CODE,
} = require('../../src/schemas/validationHelper');

// ── Mock Express objects ───────────────────────────────────────────────────────

function createMockReq(body = {}, query = {}) {
  return {
    body,
    query,
    validated: undefined,
    validatedQuery: undefined,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    jsonData: null,
    status: jest.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function (data) {
      this.jsonData = data;
      return this;
    }),
  };
  return res;
}

function createMockNext() {
  return jest.fn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validationHelper', () => {
  describe('constants', () => {
    it('exports DEFAULT_PROBLEM_TYPE', () => {
      expect(DEFAULT_PROBLEM_TYPE).toBe('https://liquifact.io/problems/validation-error');
    });

    it('exports DEFAULT_ERROR_CODE', () => {
      expect(DEFAULT_ERROR_CODE).toBe('VALIDATION_ERROR');
    });
  });

  describe('INVOICE_ID_REGEX', () => {
    it('matches valid invoice IDs', () => {
      expect(INVOICE_ID_REGEX.test('inv_123')).toBe(true);
      expect(INVOICE_ID_REGEX.test('a')).toBe(true);
      expect(INVOICE_ID_REGEX.test('A'.repeat(128))).toBe(true);
      expect(INVOICE_ID_REGEX.test('my-invoice-001')).toBe(true);
      expect(INVOICE_ID_REGEX.test('test_id')).toBe(true);
    });

    it('rejects invalid invoice IDs', () => {
      expect(INVOICE_ID_REGEX.test('')).toBe(false);
      expect(INVOICE_ID_REGEX.test('has spaces')).toBe(false);
      expect(INVOICE_ID_REGEX.test('a'.repeat(129))).toBe(false);
      expect(INVOICE_ID_REGEX.test('special!chars')).toBe(false);
      expect(INVOICE_ID_REGEX.test('inv@lid')).toBe(false);
    });
  });

  describe('CONTRACT_ID_REGEX', () => {
    const VALID_CONTRACT_ID = 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI';

    it('matches valid Stellar contract IDs', () => {
      expect(CONTRACT_ID_REGEX.test(VALID_CONTRACT_ID)).toBe(true);
    });

    it('rejects invalid contract IDs', () => {
      expect(CONTRACT_ID_REGEX.test('BADADDR')).toBe(false);
      expect(CONTRACT_ID_REGEX.test('')).toBe(false);
      expect(CONTRACT_ID_REGEX.test('D' + 'A'.repeat(55))).toBe(false);
      expect(CONTRACT_ID_REGEX.test('C' + 'A'.repeat(54))).toBe(false);
      expect(CONTRACT_ID_REGEX.test('C' + 'A'.repeat(56))).toBe(false);
      expect(CONTRACT_ID_REGEX.test(123)).toBe(false);
    });
  });

  describe('TX_HASH_REGEX', () => {
    it('matches valid 64-char hex transaction hashes', () => {
      expect(TX_HASH_REGEX.test('a'.repeat(64))).toBe(true);
      expect(TX_HASH_REGEX.test('A'.repeat(64))).toBe(true);
      expect(TX_HASH_REGEX.test('0'.repeat(64))).toBe(true);
      expect(TX_HASH_REGEX.test('abcdef0123456789'.repeat(4))).toBe(true);
    });

    it('rejects invalid transaction hashes', () => {
      expect(TX_HASH_REGEX.test('')).toBe(false);
      expect(TX_HASH_REGEX.test('abc')).toBe(false);
      expect(TX_HASH_REGEX.test('a'.repeat(63))).toBe(false);
      expect(TX_HASH_REGEX.test('z'.repeat(64))).toBe(false);
      expect(TX_HASH_REGEX.test('a'.repeat(65))).toBe(false);
      expect(TX_HASH_REGEX.test(123)).toBe(false);
    });
  });

  describe('parseValidationErrors', () => {
    it('returns empty object for empty issues array', () => {
      const result = parseValidationErrors({ issues: [] });
      expect(result).toEqual({});
    });

    it('returns empty object for missing issues', () => {
      const result = parseValidationErrors({});
      expect(result).toEqual({});
    });

    it('formats a single field error', () => {
      const zodError = {
        issues: [{ path: ['name'], message: 'name is required' }],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({ name: 'name is required' });
    });

    it('formats multiple field errors', () => {
      const zodError = {
        issues: [
          { path: ['name'], message: 'name is required' },
          { path: ['age'], message: 'age must be positive' },
        ],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({
        name: 'name is required',
        age: 'age must be positive',
      });
    });

    it('uses _root for empty path', () => {
      const zodError = {
        issues: [{ path: [], message: 'Invalid payload' }],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({ _root: 'Invalid payload' });
    });

    it('keeps first error per field when multiple issues exist for same path', () => {
      const zodError = {
        issues: [
          { path: ['limit'], message: 'limit must be an integer' },
          { path: ['limit'], message: 'limit must be between 1 and 100' },
        ],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({ limit: 'limit must be an integer' });
    });

    it('handles nested paths by joining with dots', () => {
      const zodError = {
        issues: [{ path: ['user', 'address', 'city'], message: 'city is required' }],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({ 'user.address.city': 'city is required' });
    });

    it('handles array indices in paths', () => {
      const zodError = {
        issues: [{ path: ['items', 0, 'name'], message: 'name is required' }],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({ 'items.0.name': 'name is required' });
    });

    it('falls back to zodError.errors when issues is missing', () => {
      const zodError = {
        errors: [{ path: ['field'], message: 'field is invalid' }],
      };
      const result = parseValidationErrors(zodError);
      expect(result).toEqual({ field: 'field is invalid' });
    });
  });

  describe('createBodyValidator', () => {
    describe('successful validation', () => {
      it('calls next() and attaches validated data to req.validated', () => {
        const schema = z.object({
          name: z.string(),
          age: z.number().optional(),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ name: 'Alice', age: 30 });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.validated).toEqual({ name: 'Alice', age: 30 });
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
      });

      it('applies schema transformations', () => {
        const schema = z.object({
          email: z.string().transform((v) => v.toLowerCase()),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ email: 'ALICE@EXAMPLE.COM' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(req.validated.email).toBe('alice@example.com');
      });

      it('handles optional fields correctly', () => {
        const schema = z.object({
          required: z.string(),
          optional: z.string().optional(),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ required: 'value' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(req.validated).toEqual({ required: 'value' });
      });
    });

    describe('validation failure', () => {
      it('returns 400 with RFC 7807 problem structure', () => {
        const schema = z.object({
          name: z.string(),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalled();

        const response = res.jsonData;
        expect(response.type).toBe(DEFAULT_PROBLEM_TYPE);
        expect(response.title).toBe('Validation Error');
        expect(response.status).toBe(400);
        expect(response.detail).toBe('Request body contains invalid or missing fields.');
        expect(response.code).toBe(DEFAULT_ERROR_CODE);
        expect(response.fieldErrors).toBeDefined();
      });

      it('includes field-level errors in fieldErrors map', () => {
        const schema = z.object({
          name: z.string().min(1),
          age: z.number().positive(),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ name: '', age: -5 });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        const response = res.jsonData;
        expect(response.fieldErrors.name).toBeDefined();
        expect(response.fieldErrors.age).toBeDefined();
      });

      it('maps missing required fields', () => {
        const schema = z.object({
          required: z.string(),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.fieldErrors.required).toBeDefined();
      });

      it('maps wrong type errors', () => {
        const schema = z.object({
          count: z.number(),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ count: 'not-a-number' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.fieldErrors.count).toBeDefined();
      });

      it('rejects unknown keys when schema uses .strict()', () => {
        const schema = z.object({ name: z.string() }).strict();

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ name: 'Alice', extra: 'field' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('handles nested object validation', () => {
        const schema = z.object({
          user: z.object({
            email: z.string().email(),
          }),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ user: { email: 'invalid' } });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.fieldErrors['user.email']).toBeDefined();
      });

      it('handles array validation', () => {
        const schema = z.object({
          items: z.array(z.string()),
        });

        const middleware = createBodyValidator(schema);
        const req = createMockReq({ items: [1, 2, 3] });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });
    });

    describe('custom options', () => {
      it('accepts custom problemType', () => {
        const schema = z.object({ name: z.string() });
        const middleware = createBodyValidator(schema, {
          problemType: 'https://example.com/custom-error',
        });

        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.type).toBe('https://example.com/custom-error');
      });

      it('accepts custom title', () => {
        const schema = z.object({ name: z.string() });
        const middleware = createBodyValidator(schema, {
          title: 'Custom Title',
        });

        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.title).toBe('Custom Title');
      });

      it('accepts custom code', () => {
        const schema = z.object({ name: z.string() });
        const middleware = createBodyValidator(schema, {
          code: 'CUSTOM_ERROR_CODE',
        });

        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.code).toBe('CUSTOM_ERROR_CODE');
      });

      it('accepts custom detail message', () => {
        const schema = z.object({ name: z.string() });
        const middleware = createBodyValidator(schema, {
          detail: 'Custom detail message.',
        });

        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.detail).toBe('Custom detail message.');
      });

      it('accepts all custom options together', () => {
        const schema = z.object({ name: z.string() });
        const middleware = createBodyValidator(schema, {
          problemType: 'https://example.com/probs/custom',
          title: 'Custom Validation Error',
          code: 'CUSTOM_VALIDATION_FAILED',
          detail: 'The request did not meet the required criteria.',
        });

        const req = createMockReq({});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.type).toBe('https://example.com/probs/custom');
        expect(res.jsonData.title).toBe('Custom Validation Error');
        expect(res.jsonData.code).toBe('CUSTOM_VALIDATION_FAILED');
        expect(res.jsonData.detail).toBe('The request did not meet the required criteria.');
      });
    });
  });

  describe('createQueryValidator', () => {
    describe('successful validation', () => {
      it('calls next() and attaches validated data to req.validatedQuery', () => {
        const schema = z.object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        });

        const middleware = createQueryValidator(schema);
        const req = createMockReq({}, { page: '2', limit: '50' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.validatedQuery.page).toBe(2);
        expect(req.validatedQuery.limit).toBe(50);
      });

      it('applies default values', () => {
        const schema = z.object({
          page: z.coerce.number().default(1),
        });

        const middleware = createQueryValidator(schema);
        const req = createMockReq({}, {});
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(req.validatedQuery.page).toBe(1);
      });
    });

    describe('validation failure', () => {
      it('returns 400 with RFC 7807 problem structure', () => {
        const schema = z.object({
          status: z.enum(['active', 'inactive']),
        });

        const middleware = createQueryValidator(schema);
        const req = createMockReq({}, { status: 'invalid' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalled();

        const response = res.jsonData;
        expect(response.type).toBe(DEFAULT_PROBLEM_TYPE);
        expect(response.title).toBe('Validation Error');
        expect(response.status).toBe(400);
        expect(response.detail).toBe('Query parameters contain invalid values.');
        expect(response.code).toBe(DEFAULT_ERROR_CODE);
        expect(response.fieldErrors).toBeDefined();
      });

      it('includes field-level errors for query params', () => {
        const schema = z.object({
          page: z.coerce.number().int().positive(),
        });

        const middleware = createQueryValidator(schema);
        const req = createMockReq({}, { page: '-1' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.fieldErrors.page).toBeDefined();
      });
    });

    describe('custom options', () => {
      it('accepts custom options for query validation', () => {
        const schema = z.object({ status: z.enum(['active', 'inactive']) });
        const middleware = createQueryValidator(schema, {
          code: 'INVALID_QUERY_PARAMS',
          detail: 'Query parameters must be valid.',
        });

        const req = createMockReq({}, { status: 'invalid' });
        const res = createMockRes();
        const next = createMockNext();

        middleware(req, res, next);

        expect(res.jsonData.code).toBe('INVALID_QUERY_PARAMS');
        expect(res.jsonData.detail).toBe('Query parameters must be valid.');
      });
    });
  });

  describe('integration with existing schemas', () => {
    it('works with runtimeConfigSchema structure', () => {
      const runtimeConfigSchema = z.object({
        section: z.enum(['webhook', 'reconciliation', 'kyc']),
        config: z.record(z.unknown()),
      });

      const middleware = createBodyValidator(runtimeConfigSchema);
      const req = createMockReq({
        section: 'webhook',
        config: { url: 'https://example.com' },
      });
      const res = createMockRes();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.validated.section).toBe('webhook');
    });

    it('rejects invalid enum values', () => {
      const runtimeConfigSchema = z.object({
        section: z.enum(['webhook', 'reconciliation', 'kyc']),
        config: z.record(z.unknown()),
      });

      const middleware = createBodyValidator(runtimeConfigSchema);
      const req = createMockReq({
        section: 'invalid',
        config: {},
      });
      const res = createMockRes();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.jsonData.fieldErrors.section).toBeDefined();
    });
  });
});
