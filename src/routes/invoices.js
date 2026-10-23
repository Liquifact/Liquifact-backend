'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const contributions = require('../data/contributions');
const config = require('../config');
const { toMinor, fromMinor, couponMinor, daysBetween, annualisedBps } = require('../domain/returns');
const {
  CreateInvoiceBody,
  FundInvoiceBodyValidate,
  InvoiceIdParam,
  ListInvoicesQuery,
} = require('../schemas');
const { validate } = require('../middleware/validate');

const router = express.Router();

// ---------------------------------------------------------------------------
// Backward-compatible validateInvoice wrapper
// Wraps the Zod schema so that code importing this function still works.
//
// Returns { value, errors } matching the original API:
//   errors – undefined on success, string[] on failure
//   value  – validated+transformed object on success
// ---------------------------------------------------------------------------
function validateInvoice(body) {
  const result = CreateInvoiceBody.safeParse(body || {});
  if (!result.success) {
    const errors = result.error.issues.map((i) => i.message);
    return { errors };
  }
  const d = result.data;
  return {
    value: {
      sme: d.sme.trim(),
      debtor: d.debtor.trim(),
      smeAddress: typeof d.smeAddress === 'string' ? d.smeAddress : null,
      amount: d.amount,
      currency: typeof d.currency === 'string' ? d.currency.toUpperCase().slice(0, 12) : 'USDC',
      yieldBps: d.yieldBps === undefined ? 800 : d.yieldBps,
      dueDate: d.dueDate,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', validate({ query: ListInvoicesQuery }), (req, res) => {
  const { status } = req.validatedQuery;
  const data = status ? store.list().filter((i) => i.status === status) : store.list();
  return res.json({ data, count: data.length });
});

router.get('/:id', validate({ params: InvoiceIdParam }), (req, res) => {
  const invoice = store.get(req.validatedParams.id);
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

router.post('/', validate({ body: CreateInvoiceBody }), (req, res) => {
  const d = req.validatedBody;
  const value = {
    sme: d.sme.trim(),
    debtor: d.debtor.trim(),
    smeAddress: typeof d.smeAddress === 'string' ? d.smeAddress : null,
    amount: d.amount,
    currency: typeof d.currency === 'string' ? d.currency.toUpperCase().slice(0, 12) : 'USDC',
    yieldBps: d.yieldBps === undefined ? 800 : d.yieldBps,
    dueDate: d.dueDate,
  };
  return res.status(201).json({ data: store.create(value) });
});

router.post('/:id/fund', validate({ params: InvoiceIdParam, body: FundInvoiceBodyValidate }), (req, res) => {
  const invoice = store.get(req.validatedParams.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (invoice.status !== 'open') {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; only open invoices can be funded` });
  }
  const { amount, investor } = req.validatedBody;
  if (investor === undefined || investor === null || investor === '') {
    return res.status(400).json({ error: 'INVESTOR_REQUIRED' });
  }
  if (typeof investor !== 'string' || !StrKey.isValidEd25519PublicKey(investor)) {
    return res.status(400).json({ error: 'INVALID_INVESTOR_ADDRESS' });
  }
  if (invoice.smeAddress && investor === invoice.smeAddress) {
    return res.status(422).json({ error: 'SELF_FUNDING_NOT_ALLOWED' });
  }
  return res.json({ data: store.fund(invoice, amount, investor) });
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

module.exports = router;
module.exports.validateInvoice = validateInvoice;
