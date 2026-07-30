'use strict';

/**
 * PATCH Invoice Field Guard — Comprehensive Unit Tests
 *
 * Covers:
 *   - extractAllowedFields: allowlist filtering + DANGEROUS_KEYS exclusion
 *   - detectLockedFieldChange: full field × status matrix
 *   - validatePatchFields: non-object bodies, prototype pollution payloads,
 *     no-valid-fields rejections, and happy-path sanitization
 *   - LOCKED_STATUSES / MUTABLE_FIELDS / PENDING_ONLY_FIELDS constant integrity
 *
 * Pure unit tests — no HTTP server, no supertest.
 * Mock req/res/next helpers keep each test self-contained.
 */

const {
  MUTABLE_FIELDS,
  PENDING_ONLY_FIELDS,
  LOCKED_STATUSES,
  DANGEROUS_KEYS,
  extractAllowedFields,
  detectLockedFieldChange,
  validatePatchFields,
} = require('../src/middleware/patchInvoice');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Express-like mock response.
 *
 * @returns {{ status: jest.Mock, json: jest.Mock }}
 */
function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

/**
 * Build a minimal Express-like mock request with the given body.
 *
 * @param {unknown} body
 * @returns {{ body: unknown, sanitizedUpdate?: unknown }}
 */
function mockReq(body) {
  return { body };
}

// ---------------------------------------------------------------------------
// Section 1: extractAllowedFields
// ---------------------------------------------------------------------------

describe('extractAllowedFields', () => {
  it('returns only MUTABLE_FIELDS keys from the body', () => {
    const result = extractAllowedFields({ amount: 100, customer: 'ACME', notes: 'hi' });
    expect(result).toEqual({ amount: 100, customer: 'ACME', notes: 'hi' });
  });

  it('strips unknown keys silently', () => {
    const result = extractAllowedFields({ amount: 50, status: 'pending', id: 'inv_1' });
    expect(result).toEqual({ amount: 50 });
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('id');
  });

  it('returns an empty object when body has no MUTABLE_FIELDS keys', () => {
    const result = extractAllowedFields({ foo: 'bar', baz: 42 });
    expect(result).toEqual({});
  });

  it('does not include __proto__ even when it appears as an own-enumerable property', () => {
    const body = Object.create(null);
    body.notes = 'ok';
    Object.defineProperty(body, '__proto__', {
      value: { admin: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = extractAllowedFields(body);
    expect(result).toEqual({ notes: 'ok' });
    // Use hasOwnProperty to check for own key — toHaveProperty traverses the prototype chain
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
  });

  it('does not include constructor even when it appears as an own-enumerable property', () => {
    const body = {};
    Object.defineProperty(body, 'constructor', {
      value: () => {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    body.amount = 200;
    const result = extractAllowedFields(body);
    expect(result).toEqual({ amount: 200 });
    // Use hasOwnProperty to check for own key — toHaveProperty traverses the prototype chain
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
  });

  it('does not include prototype even when it appears as an own-enumerable property', () => {
    const body = {};
    Object.defineProperty(body, 'prototype', {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    body.customer = 'Initech';
    const result = extractAllowedFields(body);
    expect(result).toEqual({ customer: 'Initech' });
    expect(result).not.toHaveProperty('prototype');
  });

  it('handles a body with only unrecognized dangerous keys', () => {
    const body = Object.create(null);
    Object.defineProperty(body, '__proto__', {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = extractAllowedFields(body);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Section 2: detectLockedFieldChange
// ---------------------------------------------------------------------------

describe('detectLockedFieldChange', () => {
  describe('non-locked statuses always return { locked: false }', () => {
    const openStatuses = ['draft', 'pending', 'review', 'unknown_status', ''];

    it.each(openStatuses)('status "%s" → { locked: false }', (status) => {
      expect(detectLockedFieldChange({ amount: 100 }, status)).toEqual({ locked: false });
      expect(detectLockedFieldChange({ customer: 'X' }, status)).toEqual({ locked: false });
      expect(detectLockedFieldChange({ notes: 'hi' }, status)).toEqual({ locked: false });
      expect(detectLockedFieldChange({}, status)).toEqual({ locked: false });
    });
  });

  describe('amount in payload with locked status → locked: true, field: "amount"', () => {
    it.each(['verified', 'funded', 'settled', 'cancelled'])(
      'status "%s" with amount → locked',
      (status) => {
        expect(detectLockedFieldChange({ amount: 500 }, status)).toEqual({
          locked: true,
          field: 'amount',
        });
      }
    );
  });

  describe('customer in payload (no amount) with locked status → locked: true, field: "customer"', () => {
    it.each(['verified', 'funded', 'settled', 'cancelled'])(
      'status "%s" with customer only → locked',
      (status) => {
        expect(detectLockedFieldChange({ customer: 'Acme' }, status)).toEqual({
          locked: true,
          field: 'customer',
        });
      }
    );
  });

  describe('notes in payload with locked status → { locked: false }', () => {
    it.each(['verified', 'funded', 'settled', 'cancelled'])(
      'status "%s" with notes only → not locked',
      (status) => {
        expect(detectLockedFieldChange({ notes: 'update' }, status)).toEqual({ locked: false });
      }
    );
  });

  it('returns { locked: false } when payload is empty and status is locked', () => {
    for (const status of ['verified', 'funded', 'settled', 'cancelled']) {
      expect(detectLockedFieldChange({}, status)).toEqual({ locked: false });
    }
  });

  it('stops on the first locked field — amount is checked before customer', () => {
    // PENDING_ONLY_FIELDS iteration order: amount then customer
    const result = detectLockedFieldChange({ amount: 100, customer: 'X' }, 'verified');
    expect(result).toEqual({ locked: true, field: 'amount' });
  });

  it('returns locked for amount+notes combined payload with locked status', () => {
    expect(detectLockedFieldChange({ amount: 99, notes: 'memo' }, 'funded')).toEqual({
      locked: true,
      field: 'amount',
    });
  });

  it('returns locked for customer+notes combined payload with locked status', () => {
    expect(detectLockedFieldChange({ customer: 'Corp', notes: 'memo' }, 'settled')).toEqual({
      locked: true,
      field: 'customer',
    });
  });
});

// ---------------------------------------------------------------------------
// Section 3: validatePatchFields middleware — mock req/res/next
// ---------------------------------------------------------------------------

describe('validatePatchFields', () => {
  // ── Non-object bodies → 400 ──────────────────────────────────────────────
  describe('rejects non-object bodies with 400', () => {
    const nonObjects = [
      ['string', 'a string'],
      ['number', 42],
      ['boolean', true],
      ['null', null],
      ['undefined', undefined],
      ['array with items', ['item1', 'item2']],
      ['empty array', []],
    ];

    it.each(nonObjects)('%s body → 400 JSON object error', (_label, body) => {
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
  });

  // ── Prototype pollution payloads → 400 ───────────────────────────────────
  describe('rejects prototype pollution payloads with 400', () => {
    it('body with own __proto__ key (via Object.defineProperty) → 400', () => {
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

    it('body with own constructor key (via Object.defineProperty) → 400', () => {
      const body = {};
      Object.defineProperty(body, 'constructor', {
        value: () => {},
        enumerable: true,
        configurable: true,
        writable: true,
      });
      body.amount = 100;

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

    it('body with own prototype key (via Object.defineProperty) → 400', () => {
      const body = {};
      Object.defineProperty(body, 'prototype', {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      });
      body.customer = 'Acme';

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

    it('body constructed with Object.create(null) and __proto__ as own-enumerable key → 400', () => {
      const body = Object.create(null);
      Object.defineProperty(body, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      body.notes = 'sneaky';

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
  });

  // ── No valid fields → 422 ────────────────────────────────────────────────
  describe('rejects bodies with no valid MUTABLE_FIELDS keys', () => {
    it('body with only unknown fields → 422 validation error with fieldErrors', () => {
      const req = mockReq({ unknownField: 'val' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 422,
        detail: 'Request body contains unrecognized or forbidden fields.',
        code: 'VALIDATION_ERROR',
        fieldErrors: {
          unknownField: 'Field is not mutable',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('body with status and id (non-mutable system fields) → 422', () => {
      const req = mockReq({ status: 'pending', id: '123' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 422,
        detail: 'Request body contains unrecognized or forbidden fields.',
        code: 'VALIDATION_ERROR',
        fieldErrors: {
          status: 'Field is not mutable',
          id: 'Field is not mutable',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('empty body object → 422', () => {
      const req = mockReq({});
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 422,
        detail: 'No valid fields provided. Allowed fields: amount, customer, notes.',
        code: 'VALIDATION_ERROR',
        fieldErrors: {
          _root: 'No valid fields provided. Allowed fields: amount, customer, notes.',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── Valid bodies → next() called ─────────────────────────────────────────
  describe('accepts valid bodies, sets req.sanitizedUpdate, calls next()', () => {
    it('body with only notes → sanitizedUpdate = { notes }', () => {
      const req = mockReq({ notes: 'hello' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.sanitizedUpdate).toEqual({ notes: 'hello' });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('body with amount and notes → sanitizedUpdate contains both', () => {
      const req = mockReq({ amount: 100, notes: 'x' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.sanitizedUpdate).toEqual({ amount: 100, notes: 'x' });
    });

    it('body with amount, customer, and an extra field → rejected with 422', () => {
      const req = mockReq({ amount: 100, customer: 'ACME', extraField: 'ignored' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 422,
        detail: 'Request body contains unrecognized or forbidden fields.',
        code: 'VALIDATION_ERROR',
        fieldErrors: {
          extraField: 'Field is not mutable',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('body with all three mutable fields → sanitizedUpdate has all three', () => {
      const req = mockReq({ amount: 500, customer: 'Corp', notes: 'memo' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.sanitizedUpdate).toEqual({ amount: 500, customer: 'Corp', notes: 'memo' });
    });

    it('body with amount: 0 (falsy but valid) → sanitizedUpdate includes amount: 0', () => {
      const req = mockReq({ amount: 0 });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.sanitizedUpdate).toEqual({ amount: 0 });
    });

    it('body with notes: "" (empty string) → sanitizedUpdate includes notes: ""', () => {
      const req = mockReq({ notes: '' });
      const res = mockRes();
      const next = jest.fn();

      validatePatchFields(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.sanitizedUpdate).toEqual({ notes: '' });
    });
  });
});

// ---------------------------------------------------------------------------
// Section 4: Full field × status matrix (data-driven with it.each)
// ---------------------------------------------------------------------------

describe('detectLockedFieldChange — full field × status matrix', () => {
  const lockedStatuses = ['verified', 'funded', 'settled', 'cancelled'];
  const openStatuses = ['draft', 'pending'];

  const fieldCases = [
    // [description, payload, expectedLockedWhenLocked, expectedFieldWhenLocked]
    [
      '{ amount }',
      { amount: 100 },
      true,
      'amount',
    ],
    [
      '{ customer }',
      { customer: 'Acme' },
      true,
      'customer',
    ],
    [
      '{ notes }',
      { notes: 'memo' },
      false,
      undefined,
    ],
    [
      '{ amount, customer }',
      { amount: 200, customer: 'Corp' },
      true,
      'amount', // amount is iterated first
    ],
    [
      '{ notes, amount }',
      { notes: 'note', amount: 50 },
      true,
      'amount',
    ],
  ];

  describe('locked statuses reject PENDING_ONLY_FIELDS', () => {
    for (const [fieldDesc, payload, shouldLock, expectedField] of fieldCases) {
      for (const status of lockedStatuses) {
        it(`payload ${fieldDesc} + status "${status}" → locked=${shouldLock}${shouldLock ? `, field="${expectedField}"` : ''}`, () => {
          const result = detectLockedFieldChange(payload, status);
          if (shouldLock) {
            expect(result).toEqual({ locked: true, field: expectedField });
          } else {
            expect(result).toEqual({ locked: false });
          }
        });
      }
    }
  });

  describe('open statuses never lock any field', () => {
    for (const [fieldDesc, payload] of fieldCases) {
      for (const status of openStatuses) {
        it(`payload ${fieldDesc} + status "${status}" → locked=false`, () => {
          expect(detectLockedFieldChange(payload, status)).toEqual({ locked: false });
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Section 5: Exported constants integrity
// ---------------------------------------------------------------------------

describe('Exported constants integrity', () => {
  it('LOCKED_STATUSES contains exactly: verified, funded, settled, cancelled', () => {
    expect(LOCKED_STATUSES.size).toBe(4);
    expect(LOCKED_STATUSES.has('verified')).toBe(true);
    expect(LOCKED_STATUSES.has('funded')).toBe(true);
    expect(LOCKED_STATUSES.has('settled')).toBe(true);
    expect(LOCKED_STATUSES.has('cancelled')).toBe(true);
  });

  it('MUTABLE_FIELDS contains exactly: amount, customer, notes', () => {
    expect(MUTABLE_FIELDS.size).toBe(3);
    expect(MUTABLE_FIELDS.has('amount')).toBe(true);
    expect(MUTABLE_FIELDS.has('customer')).toBe(true);
    expect(MUTABLE_FIELDS.has('notes')).toBe(true);
  });

  it('PENDING_ONLY_FIELDS contains exactly: amount, customer', () => {
    expect(PENDING_ONLY_FIELDS.size).toBe(2);
    expect(PENDING_ONLY_FIELDS.has('amount')).toBe(true);
    expect(PENDING_ONLY_FIELDS.has('customer')).toBe(true);
  });

  it('PENDING_ONLY_FIELDS is a strict subset of MUTABLE_FIELDS', () => {
    for (const field of PENDING_ONLY_FIELDS) {
      expect(MUTABLE_FIELDS.has(field)).toBe(true);
    }
    expect(PENDING_ONLY_FIELDS.size).toBeLessThan(MUTABLE_FIELDS.size);
  });

  it('DANGEROUS_KEYS contains exactly: __proto__, constructor, prototype', () => {
    expect(DANGEROUS_KEYS.has('__proto__')).toBe(true);
    expect(DANGEROUS_KEYS.has('constructor')).toBe(true);
    expect(DANGEROUS_KEYS.has('prototype')).toBe(true);
    expect(DANGEROUS_KEYS.size).toBe(3);
  });

  it('DANGEROUS_KEYS has no overlap with MUTABLE_FIELDS (belt-and-suspenders invariant)', () => {
    for (const key of DANGEROUS_KEYS) {
      expect(MUTABLE_FIELDS.has(key)).toBe(false);
    }
  });
});
