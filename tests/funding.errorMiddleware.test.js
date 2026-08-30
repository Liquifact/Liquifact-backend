'use strict';

const { fundingErrorHandler } = require('../src/middleware/fundingErrorHandler');
const {
  FundingError,
  FUNDING_ERROR_CODES,
  createFundingError,
  classifyFundingError,
  fundingValidationError,
} = require('../src/errors/fundingErrors');

function responseDouble() {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return response;
}

function requestDouble() {
  return {
    id: 'req-funding-001',
    headers: {},
    method: 'POST',
    originalUrl: '/api/invest/fund-invoice',
  };
}

describe('funding error taxonomy', () => {
  it('keeps code/status mappings bounded', () => {
    expect(createFundingError(FUNDING_ERROR_CODES.VALIDATION_ERROR, 'bad')).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    });
    expect(createFundingError(FUNDING_ERROR_CODES.ESCROW_NOT_FOUND, 'missing')).toMatchObject({
      code: 'ESCROW_NOT_FOUND',
      status: 404,
    });
    expect(createFundingError(FUNDING_ERROR_CODES.FUNDING_CONFLICT, 'conflict')).toMatchObject({
      code: 'FUNDING_CONFLICT',
      status: 409,
    });
    expect(createFundingError(FUNDING_ERROR_CODES.ESCROW_SUBMIT_FAILED, 'retry')).toMatchObject({
      code: 'ESCROW_SUBMIT_FAILED',
      status: 502,
      retryable: true,
    });
  });

  it('rejects unknown codes at construction time', () => {
    expect(() => createFundingError('DATABASE_SECRET', 'leak')).toThrow(TypeError);
  });

  it('preserves safe validation details', () => {
    const error = fundingValidationError(['invoiceId is required', 'amount is invalid']);
    expect(error).toBeInstanceOf(FundingError);
    expect(error.details).toEqual(['invoiceId is required', 'amount is invalid']);
    expect(error.message).toBe('invoiceId is required');
  });

  it('classifies the escrow mapping error without exposing its message', () => {
    const error = classifyFundingError(
      Object.assign(new Error('environment config contains secrets'), { name: 'EscrowNotFoundError' }),
    );
    expect(error).toMatchObject({ code: 'ESCROW_NOT_FOUND', status: 404 });
    expect(error.message).not.toContain('secrets');
  });

  it('maps database uniqueness failures to a conflict', () => {
    expect(classifyFundingError({ code: '23505', message: 'investor_commitments_pkey' })).toMatchObject({
      code: 'FUNDING_CONFLICT',
      status: 409,
    });
  });

  it('maps unexpected errors to a safe 500', () => {
    const error = classifyFundingError(new Error('postgres password=should-not-leak'));
    expect(error).toMatchObject({ code: 'FUNDING_INTERNAL_ERROR', status: 500 });
    expect(error.message).not.toContain('postgres');
  });
});

describe('fundingErrorHandler', () => {
  it.each([
    [createFundingError('VALIDATION_ERROR', 'invalid request'), 400, false],
    [createFundingError('ESCROW_NOT_FOUND', 'not found'), 404, false],
    [createFundingError('FUNDING_CONFLICT', 'conflict'), 409, false],
    [createFundingError('ESCROW_SUBMIT_FAILED', 'retry'), 502, true],
    [new Error('secret RPC response'), 500, false],
  ])('returns the stable response for %s', (error, status, retryable) => {
    const req = requestDouble();
    const res = responseDouble();
    const next = jest.fn();

    fundingErrorHandler(error, req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(status);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error.requestId).toBe('req-funding-001');
    expect(payload.error.retryable).toBe(retryable);
    expect(JSON.stringify(payload)).not.toContain('secret RPC response');
  });

  it('uses the trusted request header only when no middleware id is present', () => {
    const req = requestDouble();
    delete req.id;
    req.headers['x-request-id'] = 'req-from-proxy';
    const res = responseDouble();

    fundingErrorHandler(new Error('failure'), req, res, jest.fn());

    expect(res.json.mock.calls[0][0].error.requestId).toBe('req-from-proxy');
  });

  it('falls back to unknown when no request identifier exists', () => {
    const req = requestDouble();
    delete req.id;
    const res = responseDouble();

    fundingErrorHandler(new Error('failure'), req, res, jest.fn());

    expect(res.json.mock.calls[0][0].error.requestId).toBe('unknown');
  });

  it('passes an empty error through', () => {
    const next = jest.fn();
    fundingErrorHandler(null, requestDouble(), responseDouble(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('does not include details on non-validation failures', () => {
    const res = responseDouble();
    fundingErrorHandler(new Error('internal detail'), requestDouble(), res, jest.fn());
    expect(res.json.mock.calls[0][0].error.details).toBeUndefined();
  });
});
