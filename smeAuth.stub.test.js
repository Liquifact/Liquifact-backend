'use strict';

const { authorizeSmeWallet, verifyInvoiceOwner } = require('./src/middleware/smeAuth');
const AppError = require('./src/errors/AppError');

describe('SME Auth Middleware Stub', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      headers: {},
      params: {},
      user: null,
      originalUrl: '/api/test'
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
  });

  describe('authorizeSmeWallet', () => {
    it('should fail if user is not authenticated', () => {
      authorizeSmeWallet(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.status).toBe(401);
      expect(error.title).toBe('Unauthorized');
    });

    it('should fail if no wallet is bound and no header provided', () => {
      req.user = { id: 'user1' };
      authorizeSmeWallet(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.status).toBe(403);
      expect(error.detail).toContain('No Stellar wallet address is bound');
    });

    it('should fail if wallet address is invalid format', () => {
      req.user = { id: 'user1', walletAddress: 'invalid-stellar-address' };
      authorizeSmeWallet(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.status).toBe(400);
      expect(error.title).toBe('Invalid Wallet Address');
    });

    it('should succeed if wallet is bound to user record', () => {
      const validAddress = 'G' + 'A'.repeat(55);
      req.user = { id: 'user1', walletAddress: validAddress };
      authorizeSmeWallet(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.walletAddress).toBe(validAddress);
    });

    it('should succeed if wallet is provided via x-stellar-address header (stub behavior)', () => {
      const validAddress = 'G' + 'A'.repeat(55);
      req.user = { id: 'user1' };
      req.headers['x-stellar-address'] = validAddress;
      authorizeSmeWallet(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.walletAddress).toBe(validAddress);
    });
  });

  describe('verifyInvoiceOwner', () => {
    const validWallet = 'G' + 'A'.repeat(55);
    const invoices = [
      { id: 'inv1', ownerId: 'user1', smeWallet: validWallet },
      { id: 'inv2', ownerId: 'user2', smeWallet: 'G' + 'B'.repeat(55) }
    ];

    it('should fail if invoice ID is missing from params', () => {
      req.params = {};
      verifyInvoiceOwner(invoices)(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.status).toBe(400);
      expect(error.detail).toBe('Invoice ID is required.');
    });

    it('should fail if invoice is not found', () => {
      req.params.id = 'missing-id';
      verifyInvoiceOwner(invoices)(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.status).toBe(404);
      expect(error.detail).toContain('was not found');
    });

    it('should succeed if user is owner via userId match', () => {
      req.params.id = 'inv1';
      req.user = { id: 'user1' };
      verifyInvoiceOwner(invoices)(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.invoice).toBe(invoices[0]);
    });

    it('should succeed if user is owner via walletAddress match', () => {
      req.params.id = 'inv1';
      req.walletAddress = validWallet;
      verifyInvoiceOwner(invoices)(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.invoice).toBe(invoices[0]);
    });

    it('should fail if user/wallet does not match invoice owner info', () => {
      req.params.id = 'inv2';
      req.user = { id: 'user1' };
      req.walletAddress = validWallet;
      verifyInvoiceOwner(invoices)(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.status).toBe(403);
      expect(error.title).toBe('Forbidden');
    });
  });
});