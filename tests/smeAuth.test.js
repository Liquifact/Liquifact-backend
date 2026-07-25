'use strict';

const { authorizeSmeWallet } = require('../src/middleware/smeAuth');
const AppError = require('../src/errors/AppError');

function makeRequestContext(user, headers = {}) {
  return {
    headers,
    params: {},
    user,
    originalUrl: '/api/test',
  };
}

describe('SME wallet authorization', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = makeRequestContext(null);
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('rejects requests without an authenticated principal', () => {
    authorizeSmeWallet(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = next.mock.calls[0][0];
    expect(error.status).toBe(401);
    expect(error.title).toBe('Unauthorized');
  });

  it('returns 403 when no wallet is bound to the authenticated principal', () => {
    req.user = { id: 'user-001' };

    authorizeSmeWallet(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = next.mock.calls[0][0];
    expect(error.status).toBe(403);
    expect(error.detail).toContain('No Stellar wallet address is bound');
  });

  it('ignores a spoofed x-stellar-address header and uses the bound wallet', () => {
    const boundWallet = 'G' + 'A'.repeat(55);
    const spoofedWallet = 'G' + 'B'.repeat(55);
    req.user = { id: 'user-001', walletAddress: boundWallet };
    req.headers['x-stellar-address'] = spoofedWallet;

    authorizeSmeWallet(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.walletAddress).toBe(boundWallet);
    expect(req.walletAddress).not.toBe(spoofedWallet);
  });

  it('rejects malformed wallet values from the authenticated principal', () => {
    req.user = { id: 'user-001', walletAddress: 'invalid-stellar-address' };

    authorizeSmeWallet(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = next.mock.calls[0][0];
    expect(error.status).toBe(400);
    expect(error.title).toBe('Invalid Wallet Address');
  });
});
