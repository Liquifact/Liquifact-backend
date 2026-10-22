'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const contributions = require('../data/contributions');
const config = require('../config');
const { toMinor, fromMinor, couponMinor, daysBetween, annualisedBps } = require('../domain/returns');
const { badRequest, notFound, conflict, unprocessable } = require('../errors');

const router = express.Router();

/**
 * Validates a create-invoice payload.
 *
 * @param {object} body request body
 * @returns {{ value?: object, errors?: string[] }} validated fields or errors
 */
function validateInvoice(body) {
  const errors = [];
  const b = body || {};
  const str = (k, max = 120) => {
    if (typeof b[k] !== 'string' || !b[k].trim() || b[k].length > max) {
      errors.push(`${k} must be a non-empty string (max ${max} chars)`);
    }
  };
  str('sme');
  str('debtor');
  if (typeof b.amount !== 'number' || !(b.amount > 0) || b.amount > 1e12) {
    errors.push('amount must be a positive number');
  }
  const yieldBps = b.yieldBps === undefined ? 800 : b.yieldBps;
  if (!Number.isInteger(yieldBps) || yieldBps < 0 || yieldBps > 10000) {
    errors.push('yieldBps must be an integer between 0 and 10000');
  }
  if (typeof b.dueDate !== 'string' || Number.isNaN(Date.parse(b.dueDate))) {
    errors.push('dueDate must be an ISO date (YYYY-MM-DD)');
  }
  if (errors.length) {
    return { errors };
  }
  return {
    value: {
      sme: b.sme.trim(),
      debtor: b.debtor.trim(),
      smeAddress: typeof b.smeAddress === 'string' ? b.smeAddress : null,
      amount: b.amount,
      currency: typeof b.currency === 'string' ? b.currency.toUpperCase().slice(0, 12) : 'USDC',
      yieldBps,
      dueDate: b.dueDate,
    },
  };
}

router.get('/', (req, res) => {
  const { status } = req.query;
  if (status && !store.STATUSES.includes(status)) {
    throw badRequest('INVALID_STATUS_FILTER');
  }
  const data = status ? store.list().filter((i) => i.status === status) : store.list();
  return res.json({ data, count: data.length });
});

router.get('/:id', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }
  return res.json({ data: invoice });
});

router.get('/:id/quote', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }
  if (invoice.status !== 'open') {
    throw conflict('INVOICE_NOT_OPEN');
  }
  const { amount, asOf } = req.query;
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(amount)) {
    throw badRequest('INVALID_AMOUNT');
  }
  const parsedAsOf = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? new Date(`${asOf}T00:00:00.000Z`)
    : null;
  if (asOf !== undefined && (!parsedAsOf || Number.isNaN(parsedAsOf.getTime()) || parsedAsOf.toISOString().slice(0, 10) !== asOf)) {
    throw badRequest('INVALID_AS_OF');
  }
  let principalMinor;
  let capacityMinor;
  try {
    principalMinor = toMinor(amount);
    capacityMinor = toMinor(invoice.amount) - toMinor(invoice.fundedAmount);
  } catch {
    throw badRequest('INVALID_AMOUNT');
  }
  if (principalMinor <= 0n) {
    throw badRequest('INVALID_AMOUNT');
  }
  if (principalMinor > capacityMinor) {
    throw unprocessable('EXCEEDS_CAPACITY');
  }
  const quoteAsOf = asOf || new Date().toISOString().slice(0, 10);
  const daysToMaturity = daysBetween(quoteAsOf, invoice.dueDate);
  if (daysToMaturity <= 0) {
    throw conflict('INVOICE_MATURED');
  }
  const coupon = couponMinor(principalMinor, invoice.yieldBps);
  const { simpleAnnualisedBps, effectiveAnnualisedBps } = annualisedBps(invoice.yieldBps, daysToMaturity);
  return res.json({
    invoiceId: invoice.id,
    currency: invoice.currency,
    principal: fromMinor(principalMinor),
    yieldBps: invoice.yieldBps,
    coupon: fromMinor(coupon),
    payout: fromMinor(principalMinor + coupon),
    protocolFeeBps: config.protocolFeeBps,
    daysToMaturity,
    simpleAnnualisedBps,
    effectiveAnnualisedBps,
    maturity: invoice.dueDate,
    asOf: quoteAsOf,
  });
});

router.post('/', (req, res) => {
  const { value, errors } = validateInvoice(req.body);
  if (errors) {
    const fieldErrors = errors.map((msg) => {
      const field = msg.split(' ')[0];
      return { field, message: msg };
    });
    throw badRequest('VALIDATION_FAILED', 'Validation failed', fieldErrors);
  }
  return res.status(201).json({ data: store.create(value) });
});

router.post('/:id/fund', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }
  const { amount, investor } = req.body || {};
  if (investor === undefined || investor === null || investor === '') {
    throw badRequest('INVESTOR_REQUIRED');
  }
  if (typeof investor !== 'string' || !StrKey.isValidEd25519PublicKey(investor)) {
    throw badRequest('INVALID_INVESTOR_ADDRESS');
  }
  if (invoice.smeAddress && investor === invoice.smeAddress) {
    throw unprocessable('SELF_FUNDING_NOT_ALLOWED');
  }
  if (typeof amount !== 'number' || !(amount > 0) || !Number.isFinite(amount)) {
    throw badRequest('VALIDATION_FAILED', 'Validation failed', [{ field: 'amount', message: 'amount must be a positive number' }]);
  }
  if (invoice.status !== 'open') {
    throw conflict('INVOICE_NOT_OPEN');
  }
  return res.json({ data: store.fund(invoice, amount, investor) });
});

router.get('/:id/contributions', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }

  let limit = 50;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest('INVALID_LIMIT');
    }
  }

  const all = contributions.listByInvoice(invoice.id);
  let startIndex = 0;
  if (req.query.cursor) {
    const idx = all.findIndex((c) => c.id === req.query.cursor);
    if (idx === -1) {
      throw badRequest('INVALID_CURSOR');
    }
    startIndex = idx + 1;
  }

  const page = all.slice(startIndex, startIndex + limit);
  const data = page.map((c) => ({
    investor: c.investor,
    amount: c.amount,
    createdAt: c.createdAt,
  }));

  const uniqueInvestors = new Set(all.map((c) => c.investor)).size;
  const totalFunded = invoice.fundedAmount;

  const nextCursor = startIndex + limit < all.length && page.length > 0 ? page[page.length - 1].id : null;

  const response = {
    data,
    totals: {
      funded: totalFunded,
      investors: uniqueInvestors,
    },
  };
  if (nextCursor) {
    response.nextCursor = nextCursor;
  }

  return res.json(response);
});

module.exports = router;
module.exports.validateInvoice = validateInvoice;