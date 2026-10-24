'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const { auditContext } = require('../audit/middleware');
const contributions = require('../data/contributions');
const config = require('../config');
const { toMinor, fromMinor, couponMinor, daysBetween, annualisedBps } = require('../domain/returns');
const { parseInvoiceQuery, queryInvoices, InvoiceQueryError } = require('../services/invoice-query');

const router = express.Router();
router.use(auditContext());

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
  const yieldBps = b.yieldBps == null ? 800 : b.yieldBps;
  if (!Number.isInteger(yieldBps) || yieldBps < 0 || yieldBps > 10000) {
    errors.push('yieldBps must be an integer between 0 and 10000');
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_DATE.test(b.dueDate) || Number.isNaN(Date.parse(b.dueDate))) {
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
  try {
    const query = parseInvoiceQuery(req.query);
    return res.json(queryInvoices(store.list(), query));
  } catch (error) {
    if (!(error instanceof InvoiceQueryError)) {
      throw error;
    }
    return res.status(400).json({ error: error.message, code: error.code, details: error.details });
  }
});

router.get('/:id', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  return res.json({ data: invoice });
});

router.get('/:id/quote', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'INVOICE_NOT_FOUND', code: 'INVOICE_NOT_FOUND' });
  }
  if (invoice.status !== 'open') {
    return res.status(409).json({ error: 'INVOICE_NOT_OPEN', code: 'INVOICE_NOT_OPEN' });
  }
  const { amount, asOf } = req.query;
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(amount)) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', code: 'INVALID_AMOUNT' });
  }
  const parsedAsOf = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? new Date(`${asOf}T00:00:00.000Z`)
    : null;
  if (asOf !== undefined && (!parsedAsOf || Number.isNaN(parsedAsOf.getTime()) || parsedAsOf.toISOString().slice(0, 10) !== asOf)) {
    return res.status(400).json({ error: 'INVALID_AS_OF', code: 'INVALID_AS_OF' });
  }
  let principalMinor;
  let capacityMinor;
  try {
    principalMinor = toMinor(amount);
    capacityMinor = toMinor(invoice.amount) - toMinor(invoice.fundedAmount);
  } catch {
    return res.status(400).json({ error: 'INVALID_AMOUNT', code: 'INVALID_AMOUNT' });
  }
  if (principalMinor <= 0n) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', code: 'INVALID_AMOUNT' });
  }
  if (principalMinor > capacityMinor) {
    return res.status(422).json({ error: 'EXCEEDS_CAPACITY', code: 'EXCEEDS_CAPACITY' });
  }
  const quoteAsOf = asOf || new Date().toISOString().slice(0, 10);
  const daysToMaturity = daysBetween(quoteAsOf, invoice.dueDate);
  if (daysToMaturity <= 0) {
    return res.status(409).json({ error: 'INVOICE_MATURED', code: 'INVOICE_MATURED' });
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
    req.audit({
      action: 'invoice.create',
      resourceType: 'invoice',
      outcome: 'rejected',
      statusCode: 400,
      metadata: { errors },
    });
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  const invoice = store.create(value);
  req.audit({
    action: 'invoice.create',
    resourceType: 'invoice',
    resourceId: invoice.id,
    outcome: 'success',
    statusCode: 201,
    after: invoice,
  });
  return res.status(201).json({ data: invoice });
});

router.post('/:id/fund', (req, res) => {
  const record = (details) =>
    req.audit({ action: 'invoice.fund', resourceType: 'invoice', resourceId: req.params.id, ...details });
  const reject = (statusCode, error, details) => {
    record({ outcome: 'rejected', statusCode, metadata: { error, ...details.metadata }, before: details.before });
    return res.status(statusCode).json({ error });
  };

  const invoice = store.get(req.params.id);
  if (!invoice) {
    return reject(404, 'Invoice not found', {});
  }
  const { amount, investor } = req.body || {};
  const before = { fundedAmount: invoice.fundedAmount, status: invoice.status };
  const requested = {
    requestedAmount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    requestedAmountType: typeof amount,
  };
  if (investor === undefined || investor === null || investor === '') {
    return reject(400, 'INVESTOR_REQUIRED', { before, metadata: requested });
  }
  if (typeof investor !== 'string' || !StrKey.isValidEd25519PublicKey(investor)) {
    return reject(400, 'INVALID_INVESTOR_ADDRESS', { before, metadata: requested });
  }
  if (invoice.smeAddress && investor === invoice.smeAddress) {
    return reject(422, 'SELF_FUNDING_NOT_ALLOWED', { before, metadata: requested });
  }
  if (typeof amount !== 'number' || !(amount > 0) || !Number.isFinite(amount)) {
    return reject(400, 'amount must be a positive number', { before, metadata: requested });
  }
  if (invoice.status !== 'open') {
    return reject(409, `Invoice is ${invoice.status}; only open invoices can be funded`, {
      before,
      metadata: requested,
    });
  }
  const updated = store.fund(invoice, amount, investor);
  record({
    outcome: 'success',
    statusCode: 200,
    before,
    after: { fundedAmount: updated.fundedAmount, status: updated.status },
    metadata: requested,
  });
  return res.json({ data: updated });
});

router.get('/:id/contributions', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  let limit = 50;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
  }

  const all = contributions.listByInvoice(invoice.id);
  let startIndex = 0;
  if (req.query.cursor) {
    const idx = all.findIndex((c) => c.id === req.query.cursor);
    if (idx === -1) {
      return res.status(400).json({ error: 'Invalid cursor' });
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

/**
 * Builds an audit-recording helper for a status transition route.
 *
 * @param {import('express').Request} req request carrying `req.audit`
 * @param {import('express').Response} res response
 * @param {string} action audit action name, e.g. "invoice.settle"
 * @returns {{ reject: Function, success: Function }} helpers that record and respond
 */
function transitionAudit(req, res, action) {
  const record = (details) => req.audit({ action, resourceType: 'invoice', resourceId: req.params.id, ...details });
  return {
    reject(statusCode, error, before = null) {
      record({ outcome: 'rejected', statusCode, before, metadata: { error } });
      return res.status(statusCode).json({ error });
    },
    success(before, updated) {
      record({ outcome: 'success', statusCode: 200, before, after: { fundedAmount: updated.fundedAmount, status: updated.status } });
      return res.json({ data: updated });
    },
  };
}

router.post('/:id/settle', (req, res) => {
  const audit = transitionAudit(req, res, 'invoice.settle');
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return audit.reject(404, 'Invoice not found');
  }
  const before = { fundedAmount: invoice.fundedAmount, status: invoice.status };
  if (invoice.status !== 'funded') {
    return audit.reject(409, `Invoice is ${invoice.status}; only funded invoices can be settled`, before);
  }
  return audit.success(before, store.settle(invoice));
});

router.post('/:id/cancel', (req, res) => {
  const audit = transitionAudit(req, res, 'invoice.cancel');
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return audit.reject(404, 'Invoice not found');
  }
  const before = { fundedAmount: invoice.fundedAmount, status: invoice.status };
  if (invoice.status !== 'open' && invoice.status !== 'funded') {
    return audit.reject(409, `Invoice is ${invoice.status}; only open or funded invoices can be cancelled`, before);
  }
  return audit.success(before, store.cancel(invoice));
});

module.exports = router;
module.exports.validateInvoice = validateInvoice;
