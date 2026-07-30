'use strict';

/**
 * PATCH Invoice Strict Field Rejection — Comprehensive Tests
 *
 * Task #614: Reject unknown PATCH invoice fields with 422 instead of
 * silently stripping them.
 *
 * Covers:
 *   - Unknown / non-mutable field rejection → 422 with RFC 7807 problem
 *     detail and per-field `fieldErrors` map
 *   - Empty payload rejection → 422
 *   - Mixed valid + unknown fields → 422 (rejects entire request)
 *   - Financial / system field names (status, yieldBps, id, tenantId)
 *   - Typo'd field names (amountt, custmer)
 *   - Problem detail envelope structure validation
 *   - Happy-path pass-through still works
 *   - Edge cases (numeric keys, nested objects, large key counts)
 *
 * Pure unit tests — no HTTP server, no supertest.
 * Mock req/res/next helpers keep each test self-contained.
 */

const {
  MUTABLE_FIELDS,
  validatePatchFields,
} = require('../src/middleware/patchInvoice');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal Express-like mock response. */
function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

/** Build a minimal Express-like mock request with the given body. */
function mockReq(body) {
  return { body, originalUrl: '/v1/invoices/inv_test' };
}

// ---------------------------------------------------------------------------
// Expected constants
// ---------------------------------------------------------------------------

const PROBLEM_TYPE = 'https://liquifact.com/probs/validation-error';
const PROBLEM_TITLE = 'Validation Error';
const PROBLEM_CODE = 'VALIDATION_ERROR';

// ---------------------------------------------------------------------------
// Section 1: Unknown field rejection → 422
// ---------------------------------------------------------------------------

describe('validatePatchFields — strict unknown field rejection', () => {
  describe('rejects single unknown field with 422 and fieldErrors', () => {
    it('unknown field "foo" → 422 with fieldErrors.foo', () => {
      const req = mockReq({ foo: 'bar' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPE,
          title: PROBLEM_TITLE,
          status: 422,
          code: PROBLEM_CODE,
          fieldErrors: { foo: 'Field is not mutable' },
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('financial field "status" → 422', () => {
      const req = mockReq({ status: 'funded' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.fieldErrors).toEqual({ status: 'Field is not mutable' });
      expect(next).not.toHaveBeenCalled();
    });

    it('financial field "yieldBps" → 422', () => {
      const req = mockReq({ yieldBps: 500 });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.fieldErrors).toEqual({ yieldBps: 'Field is not mutable' });
    });

    it('system field "id" → 422', () => {
      const req = mockReq({ id: 'inv_spoofed' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0].fieldErrors).toEqual({
        id: 'Field is not mutable',
      });
    });

    it('system field "tenantId" → 422', () => {
      const req = mockReq({ tenantId: 'tenant-evil' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0].fieldErrors).toEqual({
        tenantId: 'Field is not mutable',
      });
    });
  });

  describe('rejects typo field names with 422', () => {
    it('"amountt" (typo) → 422', () => {
      const req = mockReq({ amountt: 100 });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0].fieldErrors).toEqual({
        amountt: 'Field is not mutable',
      });
    });

    it('"custmer" (typo) → 422', () => {
      const req = mockReq({ custmer: 'Acme' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0].fieldErrors).toEqual({
        custmer: 'Field is not mutable',
      });
    });
  });

  describe('rejects multiple unknown fields with all keys in fieldErrors', () => {
    it('two unknown fields → both appear in fieldErrors', () => {
      const req = mockReq({ status: 'pending', id: '123' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.fieldErrors).toEqual({
        status: 'Field is not mutable',
        id: 'Field is not mutable',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('three unknown fields → all three in fieldErrors', () => {
      const req = mockReq({ foo: 1, bar: 2, baz: 3 });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body.fieldErrors)).toHaveLength(3);
      expect(body.fieldErrors.foo).toBe('Field is not mutable');
      expect(body.fieldErrors.bar).toBe('Field is not mutable');
      expect(body.fieldErrors.baz).toBe('Field is not mutable');
    });
  });

  describe('rejects mix of valid + unknown fields (no silent stripping)', () => {
    it('amount (valid) + status (unknown) → 422', () => {
      const req = mockReq({ amount: 100, status: 'funded' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.fieldErrors).toEqual({ status: 'Field is not mutable' });
      expect(next).not.toHaveBeenCalled();
    });

    it('amount + customer (valid) + extraField (unknown) → 422', () => {
      const req = mockReq({ amount: 100, customer: 'ACME', extraField: 'x' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0].fieldErrors).toEqual({
        extraField: 'Field is not mutable',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('notes (valid) + yieldBps + createdAt (unknown) → 422 with both unknowns', () => {
      const req = mockReq({ notes: 'hi', yieldBps: 100, createdAt: '2024-01-01' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.fieldErrors.yieldBps).toBe('Field is not mutable');
      expect(body.fieldErrors.createdAt).toBe('Field is not mutable');
      expect(body.fieldErrors.notes).toBeUndefined(); // notes is valid
    });
  });
});

// ---------------------------------------------------------------------------
// Section 2: Empty payload rejection → 422
// ---------------------------------------------------------------------------

describe('validatePatchFields — empty payload rejection', () => {
  it('empty object {} → 422 with _root fieldError', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    const body = res.json.mock.calls[0][0];
    expect(body.type).toBe(PROBLEM_TYPE);
    expect(body.status).toBe(422);
    expect(body.detail).toMatch(/No valid fields/);
    expect(body.fieldErrors._root).toMatch(/No valid fields/);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section 3: Problem detail envelope validation
// ---------------------------------------------------------------------------

describe('validatePatchFields — RFC 7807 problem detail envelope', () => {
  it('422 response contains all required problem detail fields', () => {
    const req = mockReq({ unknownField: 'val' });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    const body = res.json.mock.calls[0][0];
    expect(body).toHaveProperty('type', PROBLEM_TYPE);
    expect(body).toHaveProperty('title', PROBLEM_TITLE);
    expect(body).toHaveProperty('status', 422);
    expect(body).toHaveProperty('detail');
    expect(body).toHaveProperty('code', PROBLEM_CODE);
    expect(body).toHaveProperty('fieldErrors');
    expect(typeof body.fieldErrors).toBe('object');
  });

  it('detail message describes the rejection reason', () => {
    const req = mockReq({ badKey: 42 });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.detail).toBe('Request body contains unrecognized or forbidden fields.');
  });

  it('instance is set from req.originalUrl', () => {
    const req = mockReq({ badKey: 42 });
    req.originalUrl = '/v1/invoices/inv_42';
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.instance).toBe('/v1/invoices/inv_42');
  });
});

// ---------------------------------------------------------------------------
// Section 4: Happy path — valid bodies still pass through
// ---------------------------------------------------------------------------

describe('validatePatchFields — happy path (strict mode)', () => {
  it('body with only amount → passes through', () => {
    const req = mockReq({ amount: 500 });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sanitizedUpdate).toEqual({ amount: 500 });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('body with only customer → passes through', () => {
    const req = mockReq({ customer: 'Acme Corp' });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sanitizedUpdate).toEqual({ customer: 'Acme Corp' });
  });

  it('body with only notes → passes through', () => {
    const req = mockReq({ notes: 'Net 30 terms' });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sanitizedUpdate).toEqual({ notes: 'Net 30 terms' });
  });

  it('body with all three mutable fields → passes through', () => {
    const req = mockReq({ amount: 100, customer: 'Corp', notes: 'memo' });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sanitizedUpdate).toEqual({ amount: 100, customer: 'Corp', notes: 'memo' });
  });

  it('amount: 0 (falsy but valid) → passes through', () => {
    const req = mockReq({ amount: 0 });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sanitizedUpdate).toEqual({ amount: 0 });
  });

  it('notes: "" (empty string) → passes through', () => {
    const req = mockReq({ notes: '' });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sanitizedUpdate).toEqual({ notes: '' });
  });
});

// ---------------------------------------------------------------------------
// Section 5: Edge cases
// ---------------------------------------------------------------------------

describe('validatePatchFields — edge cases', () => {
  it('body with numeric-string key → 422', () => {
    const req = mockReq({ 0: 'value' });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].fieldErrors['0']).toBe('Field is not mutable');
  });

  it('body with nested object in unknown field → 422', () => {
    const req = mockReq({ metadata: { nested: true } });
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].fieldErrors.metadata).toBe('Field is not mutable');
  });

  it('body with many unknown fields → all listed in fieldErrors', () => {
    const body = {};
    for (let i = 0; i < 20; i++) {
      body[`unknown_${i}`] = i;
    }
    const req = mockReq(body);
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    const fieldErrors = res.json.mock.calls[0][0].fieldErrors;
    expect(Object.keys(fieldErrors)).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(fieldErrors[`unknown_${i}`]).toBe('Field is not mutable');
    }
  });

  it('prototype pollution attempt still returns 400 (not 422)', () => {
    const body = {};
    Object.defineProperty(body, '__proto__', {
      value: { admin: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    body.notes = 'ok';

    const req = mockReq(body);
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request body must be a JSON object.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('non-object body still returns 400 (not 422)', () => {
    const req = mockReq('a string');
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('null body still returns 400 (not 422)', () => {
    const req = mockReq(null);
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('array body still returns 400 (not 422)', () => {
    const req = mockReq([{ amount: 100 }]);
    const res = mockRes();
    const next = jest.fn();

    validatePatchFields(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section 6: Consistency — MUTABLE_FIELDS drives the allowlist
// ---------------------------------------------------------------------------

describe('MUTABLE_FIELDS consistency', () => {
  it('every key in MUTABLE_FIELDS passes validation when sent alone', () => {
    for (const field of MUTABLE_FIELDS) {
      const req = mockReq({ [field]: 'test-value' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.sanitizedUpdate).toHaveProperty(field, 'test-value');
    }
  });

  it('a key NOT in MUTABLE_FIELDS is always rejected', () => {
    const nonMutableFields = ['id', 'status', 'tenantId', 'createdAt', 'updatedAt', 'deleted_at'];
    for (const field of nonMutableFields) {
      const req = mockReq({ [field]: 'test' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0].fieldErrors[field]).toBe('Field is not mutable');
      expect(next).not.toHaveBeenCalled();
    }
  });
});
