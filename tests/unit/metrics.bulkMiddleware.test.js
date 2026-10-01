'use strict';

/**
 * End-to-end tests for validateBulkMetricsBody: the middleware must answer an
 * invalid body with a 400 problem document carrying stable codes, never call
 * next() on failure, and never echo raw client input back.
 */

const { validateBulkMetricsBody } = require('../../src/schemas/metrics');
const {
  METRICS_VALIDATION_CODES: CODES,
  METRICS_VALIDATION_ERROR_CODE,
  METRICS_VALIDATION_PROBLEM_TYPE,
} = require('../../src/constants/metricsValidationCodes');

/**
 * Runs the middleware against a fake request and captures the outcome.
 *
 * @param {unknown} body - Value placed on `req.body`.
 * @returns {object} The status, json payload, next mock and req.
 */
function run(body) {
  const req = { body };
  const out = { status: undefined, json: undefined };
  const res = {
    status(code) {
      out.status = code;
      return res;
    },
    json(payload) {
      out.json = payload;
      return res;
    },
  };
  const next = jest.fn();
  validateBulkMetricsBody(req, res, next);
  return { ...out, next, req };
}

describe('validateBulkMetricsBody: rejection', () => {
  it('answers a wrong-type field with a 400 problem document', () => {
    const { status, json, next } = run({ operations: [{ tenantId: 42, userId: 'u1' }] });
    expect(status).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(json.type).toBe(METRICS_VALIDATION_PROBLEM_TYPE);
    expect(json.status).toBe(400);
    expect(json.code).toBe(METRICS_VALIDATION_ERROR_CODE);
    expect(json.fieldCodes).toEqual({ 'operations.0.tenantId': [CODES.FIELD_TYPE_INVALID] });
  });

  it('answers an absent field with FIELD_REQUIRED', () => {
    const { json } = run({ operations: [{ tenantId: 't1' }] });
    expect(json.fieldCodes['operations.0.userId']).toEqual([CODES.FIELD_REQUIRED]);
  });

  it('answers a missing body with FIELD_REQUIRED at the root', () => {
    const { status, json, next } = run(undefined);
    expect(status).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(json.fieldCodes['']).toEqual([CODES.FIELD_REQUIRED]);
  });

  it('answers a non-object body with FIELD_TYPE_INVALID at the root', () => {
    const { json } = run('nope');
    expect(json.fieldCodes['']).toEqual([CODES.FIELD_TYPE_INVALID]);
  });

  it('keeps fieldErrors and fieldCodes keyed identically', () => {
    const { json } = run({ operations: [{ tenantId: '', userId: 'x'.repeat(129) }] });
    expect(Object.keys(json.fieldCodes).sort()).toEqual(Object.keys(json.fieldErrors).sort());
  });

  it('never echoes raw client input in the response', () => {
    const secret = 'SUPER-SECRET-VALUE-12345';
    const { json } = run({ operations: [{ tenantId: secret, userId: 1 }], leaked: secret });
    expect(JSON.stringify(json)).not.toContain(secret);
  });
});

describe('validateBulkMetricsBody: acceptance', () => {
  it('calls next once and attaches trimmed data on a valid body', () => {
    const { status, json, next, req } = run({
      operations: [{ tenantId: '  t1  ', userId: 'u1' }],
    });
    expect(status).toBeUndefined();
    expect(json).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.validated).toEqual({ operations: [{ tenantId: 't1', userId: 'u1' }] });
  });

  it('is deterministic: the same invalid body yields the same response', () => {
    const body = { operations: [{ tenantId: 7 }, { userId: '' }], extra: 1 };
    expect(run(body).json).toEqual(run(body).json);
  });

  it('does not mutate the request body', () => {
    const body = { operations: [{ tenantId: 7, userId: 'u1' }] };
    const before = JSON.stringify(body);
    run(body);
    expect(JSON.stringify(body)).toBe(before);
  });
});
