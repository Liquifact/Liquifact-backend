'use strict';

/**
 * Unit tests for src/utils/metricsValidation.js
 *
 * These tests cover every branch of validateMetricsRequest:
 *   - Happy path: valid userId + tenantId combinations
 *   - userId resolution: req.user.id, req.user.sub, both present, neither present
 *   - tenantId guard: missing / falsy values trigger a 400 with the correct body
 *   - Return value shape: { userId, tenantId } on success, null on rejection
 *   - Response contract: exact status code and JSON body on failure
 *   - Side-effect guarantee: res.status/json called only on failure, not on success
 */

const { validateMetricsRequest } = require('../../src/utils/metricsValidation');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal mock Express response that records what was sent.
 *
 * @returns {{ status: jest.Mock, json: jest.Mock, _statusCode: number|null, _body: any }}
 */
function makeRes() {
  const res = {
    _statusCode: null,
    _body: undefined,
    status: jest.fn(function (code) {
      this._statusCode = code;
      return this;           // chainable: res.status(400).json(...)
    }),
    json: jest.fn(function (body) {
      this._body = body;
      return this;
    }),
  };
  return res;
}

/**
 * Builds a minimal mock Express request.
 *
 * @param {{ user?: object, tenantId?: string }} opts
 * @returns {object}
 */
function makeReq({ user = { id: 'u1' }, tenantId = 'tenant-abc' } = {}) {
  return { user, tenantId };
}

// ---------------------------------------------------------------------------
// Happy-path: validation passes
// ---------------------------------------------------------------------------

describe('validateMetricsRequest — success cases', () => {
  it('returns { userId, tenantId } when req.user.id and req.tenantId are present', () => {
    const req = makeReq({ user: { id: 'user-1' }, tenantId: 'tenant-1' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toEqual({ userId: 'user-1', tenantId: 'tenant-1' });
  });

  it('returns { userId, tenantId } when req.user.sub is used (no .id)', () => {
    const req = makeReq({ user: { sub: 'sub-user-42' }, tenantId: 'tenant-x' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toEqual({ userId: 'sub-user-42', tenantId: 'tenant-x' });
  });

  it('prefers req.user.id over req.user.sub when both present', () => {
    const req = makeReq({ user: { id: 'id-wins', sub: 'sub-loses' }, tenantId: 'tenant-y' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toEqual({ userId: 'id-wins', tenantId: 'tenant-y' });
  });

  it('returns userId as empty string when req.user has neither id nor sub', () => {
    const req = makeReq({ user: {}, tenantId: 'tenant-z' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).not.toBeNull();
    expect(result.userId).toBe('');
    expect(result.tenantId).toBe('tenant-z');
  });

  it('returns userId as empty string when req.user is undefined', () => {
    const req = { user: undefined, tenantId: 'tenant-z' };
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).not.toBeNull();
    expect(result.userId).toBe('');
  });

  it('returns null and sends 403 when req.tenantId differs from req.user.tenantId (cross-tenant spoofing)', () => {
    const req = makeReq({ user: { id: 'u1', tenantId: 'tenant-a' }, tenantId: 'tenant-b' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: 'Cross-tenant access denied',
    });
  });

  it('does NOT call res.status or res.json on the success path', () => {
    const req = makeReq();
    const res = makeRes();

    validateMetricsRequest(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure path: missing tenantId → 400
// ---------------------------------------------------------------------------

describe('validateMetricsRequest — missing tenant context', () => {
  it('returns null when req.tenantId is undefined', () => {
    // Build directly to avoid the default in makeReq swallowing undefined
    const req = { user: { id: 'u1' }, tenantId: undefined };
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toBeNull();
  });

  it('returns null when req.tenantId is an empty string', () => {
    const req = makeReq({ tenantId: '' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toBeNull();
  });

  it('returns null when req.tenantId is null', () => {
    const req = makeReq({ tenantId: null });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toBeNull();
  });

  it('returns null when req.tenantId is 0 (falsy number)', () => {
    const req = makeReq({ tenantId: 0 });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toBeNull();
  });

  it('returns null when req has no tenantId property at all', () => {
    const req = { user: { id: 'u1' } };  // no tenantId key
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Response contract on failure
// ---------------------------------------------------------------------------

describe('validateMetricsRequest — 400 response contract', () => {
  it('calls res.status(400) when tenantId is missing', () => {
    // Build directly to avoid the default in makeReq swallowing undefined
    const req = { user: { id: 'u1' }, tenantId: undefined };
    const res = makeRes();

    validateMetricsRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status).toHaveBeenCalledTimes(1);
  });

  it('calls res.json with the correct error body when tenantId is missing', () => {
    const req = makeReq({ tenantId: '' });
    const res = makeRes();

    validateMetricsRequest(req, res);

    expect(res.json).toHaveBeenCalledWith({
      error: 'Bad Request',
      message: 'Missing tenant context',
    });
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('uses the exact message string "Missing tenant context"', () => {
    const req = makeReq({ tenantId: null });
    const res = makeRes();

    validateMetricsRequest(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe('Missing tenant context');
  });

  it('uses the exact error string "Bad Request"', () => {
    const req = { user: { id: 'u1' }, tenantId: undefined };
    const res = makeRes();

    validateMetricsRequest(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('Bad Request');
  });

  it('response body has exactly two keys: error and message', () => {
    const req = { user: { id: 'u1' }, tenantId: undefined };
    const res = makeRes();

    validateMetricsRequest(req, res);

    const body = res.json.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(['error', 'message']);
  });

  it('chains res.status(400).json(...) correctly (status returns res)', () => {
    const req = makeReq({ tenantId: '' });
    const res = makeRes();

    // Confirm the chain: status mock returns `this` so json is called on res
    validateMetricsRequest(req, res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'Bad Request', message: 'Missing tenant context' });
  });
});

// ---------------------------------------------------------------------------
// userId edge cases
// ---------------------------------------------------------------------------

describe('validateMetricsRequest — userId resolution edge cases', () => {
  it('resolves userId from req.user.id (numeric id coercion check)', () => {
    const req = makeReq({ user: { id: 999 }, tenantId: 't1' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    // The raw value is returned as-is (not coerced to string by the helper)
    expect(result.userId).toBe(999);
  });

  it('resolves userId from req.user.sub when id is explicitly undefined', () => {
    const req = makeReq({ user: { id: undefined, sub: 'sub-value' }, tenantId: 't1' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result.userId).toBe('sub-value');
  });

  it('resolves userId as empty string when user.id is empty string (falsy)', () => {
    const req = makeReq({ user: { id: '', sub: 'sub-fallback' }, tenantId: 't1' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    // Empty string is falsy, so sub is used
    expect(result.userId).toBe('sub-fallback');
  });

  it('resolves userId as empty string when user is null', () => {
    const req = { user: null, tenantId: 't1' };
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result).not.toBeNull();
    expect(result.userId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Return-value shape
// ---------------------------------------------------------------------------

describe('validateMetricsRequest — return value shape', () => {
  it('returned object has exactly the keys userId and tenantId', () => {
    const req = makeReq({ user: { id: 'u1' }, tenantId: 't1' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(Object.keys(result).sort()).toEqual(['tenantId', 'userId']);
  });

  it('tenantId in result equals req.tenantId', () => {
    const req = makeReq({ user: { id: 'u1' }, tenantId: 'my-tenant' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result.tenantId).toBe('my-tenant');
  });

  it('userId in result equals req.user.id when present', () => {
    const req = makeReq({ user: { id: 'the-user' }, tenantId: 't1' });
    const res = makeRes();

    const result = validateMetricsRequest(req, res);

    expect(result.userId).toBe('the-user');
  });
});

// ---------------------------------------------------------------------------
// No-side-effect guarantee on success
// ---------------------------------------------------------------------------

describe('validateMetricsRequest — no side effects on success', () => {
  it('does not mutate the request object', () => {
    const req = makeReq();
    const originalKeys = Object.keys(req);
    const res = makeRes();

    validateMetricsRequest(req, res);

    expect(Object.keys(req)).toEqual(originalKeys);
  });

  it('does not mutate the response object beyond what is returned', () => {
    const req = makeReq();
    const res = makeRes();
    const originalStatusMock = res.status;

    validateMetricsRequest(req, res);

    // res.status should not have been called
    expect(res.status).toBe(originalStatusMock);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('Issue #875 - Metrics API Changelog Telemetry Protection Tests', () => {
  const { verifyTelemetryMetricsPayload } = require('../../src/utils/metricsValidation.js');

  it('should pass with 100% accuracy when all required numerical tracking metrics exist', () => {
    const validData = { uptime: 7200, requestsCount: 450, errorsCount: 2 };
    const result = verifyTelemetryMetricsPayload(validData);
    if (result !== true) throw new Error('Expected validation to pass successfully');
  });

  it('should return false if a critical metric field is completely absent from the payload', () => {
    const missingFieldsData = { uptime: 7200, requestsCount: 450 }; // missing errorsCount
    const result = verifyTelemetryMetricsPayload(missingFieldsData);
    if (result !== false) throw new Error('Expected validation to fail gracefully due to missing fields');
  });

  it('should return false if a critical tracking parameter is not provided as a numeric value', () => {
    const badTypeData = { uptime: 7200, requestsCount: "450", errorsCount: 0 }; // string value instead of number
    const result = verifyTelemetryMetricsPayload(badTypeData);
    if (result !== false) throw new Error('Expected validation to fail due to string parameter mismatch');
  });

  it('should immediately throw an informative schema validation error if input payload is completely empty or null', () => {
    let didThrow = false;
    try {
      verifyTelemetryMetricsPayload(null);
    } catch (err) {
      if (err.message.includes('Input must be a valid non-null object.')) {
        didThrow = true;
      }
    }
    if (!didThrow) throw new Error('Expected function to throw structural error for null input payloads');
  });
});
