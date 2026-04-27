'use strict';

const AppError = require('../errors/AppError');

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Middleware: verifies the authenticated user has a bound Stellar wallet address.
 * Accepts wallet from req.user.walletAddress or x-stellar-address header (stub).
 */
function authorizeSmeWallet(req, res, next) {
  if (!req.user) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    }));
  }

  const wallet = req.user.walletAddress || req.headers['x-stellar-address'];

  if (!wallet) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'No Stellar wallet address is bound to this account.',
    }));
  }

  if (!STELLAR_ADDRESS_RE.test(wallet)) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Invalid Wallet Address',
      status: 400,
      detail: 'Stellar wallet address format is invalid.',
    }));
  }

  req.walletAddress = wallet;
  return next();
}

/**
 * Middleware factory: verifies the authenticated user owns the invoice.
 * @param {Array} invoices - Invoice collection to check against.
 */
function verifyInvoiceOwner(invoices) {
  return function (req, res, next) {
    const id = req.params && req.params.id;
    if (!id) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invoice ID is required.',
      }));
    }

    const invoice = invoices.find((inv) => inv.id === id);
    if (!invoice) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Not Found',
        status: 404,
        detail: `Invoice ${id} was not found.`,
      }));
    }

    const userId = req.user && req.user.id;
    const wallet = req.walletAddress;

    const ownsById = userId && invoice.ownerId === userId;
    const ownsByWallet = wallet && invoice.smeWallet === wallet;

    if (!ownsById && !ownsByWallet) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have permission to access this invoice.',
      }));
    }

    req.invoice = invoice;
    return next();
  };
}

module.exports = { authorizeSmeWallet, verifyInvoiceOwner };
