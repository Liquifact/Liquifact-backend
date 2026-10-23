'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const config = require('../config');
const { parseIsoDate } = require('../lib/dates');
const { toMinor, fromMinor, couponMinor, daysBetween, annualisedBps } = require('../domain/returns');
const contributions = require('../data/contributions');

const router = express.Router();

/**
 * Returns midnight UTC of today (start of the current UTC day).
 *
 * @param {number} nowMs  Current epoch ms (injectable for tests, defaults to Date.now()).
 * @returns {number} Epoch ms of 00:00:00 UTC today.
 */
function todayUtcMs(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Validates a create-invoice payload.
 *
 * dueDate rules:
 *  1. Must match /^\d{4}-\d{2}-\d{2}$/ exactly (no lenient Date.parse).
 *  2. Must be a real calendar date (no roll-overs like 2027-02-30).
 *  3. Must be strictly > today + MIN_TENOR_DAYS (UTC).
 *  4. Must be <= today + MAX_TENOR_DAYS (UTC, matches escrow contract horizon).
 *
 * @param {object} body  Request body.
 * @param {{ now?: number }} [opts]  Injectable clock; `now` is epoch ms (default Date.now()).
 * @returns {{ value?: object, errors?: string[] }}
 */
function validateInvoice(body, opts = {}) {
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

  // --- dueDate validation ---
  const parsed = parseIsoDate(b.dueDate);
  if (!parsed) {
    errors.push('dueDate must be a real calendar date in YYYY-MM-DD format');
  } else {
    const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
    const todayMs = todayUtcMs(nowMs);
    const minMs = todayMs + config.minTenorDays * 86_400_000;
    const maxMs = todayMs + config.maxTenorDays * 86_400_000;
    const dueDateMs = parsed.date.getTime(); // 00:00:00 UTC of dueDate

    if (dueDateMs < minMs) {
      errors.push(
        `dueDate must be at least ${config.minTenorDays} day(s) in the future (received ${b.dueDate})`
      );
    } else if (dueDateMs > maxMs) {
      errors.push(
        `dueDate must be within ${config.maxTenorDays} days from today (max ~${Math.round(config.maxTenorDays / 365)} years)`
      );
    }
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
      maturity: parsed.unixSeconds,
    },
  };
}

router.get('/', (req, res) => {
  const { status, dueBefore, dueAfter } = req.query;

  if (status && !store.STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${store.STATUSES.join(', ')}` });
  }

  // Validate dueBefore / dueAfter filters with the same strict parser.
  let dueBeforeDate = null;
  let dueAfterDate = null;

  if (dueBefore !== undefined) {
    const p = parseIsoDate(dueBefore);
    if (!p) {
      return res
        .status(400)
        .json({ error: 'dueBefore must be a real calendar date in YYYY-MM-DD format' });
    }
    dueBeforeDate = p.date;
  }
  if (dueAfter !== undefined) {
    const p = parseIsoDate(dueAfter);
    if (!p) {
      return res
        .status(400)
        .json({ error: 'dueAfter must be a real calendar date in YYYY-MM-DD format' });
    }
    dueAfterDate = p.date;
  }

  let data = store.list();
  if (status) {
    data = data.filter((i) => i.status === status);
  }
  if (dueBeforeDate) {
    data = data.filter((i) => {
      const p = parseIsoDate(i.dueDate);
      return p && p.date < dueBeforeDate;
    });
  }
  if (dueAfterDate) {
    data = data.filter((i) => {
      const p = parseIsoDate(i.dueDate);
      return p && p.date > dueAfterDate;
    });
  }

  return res.json({ data, count: data.length });
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
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }
  return res.status(201).json({ data: store.create(value) });
});

router.post('/:id/fund', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  const { amount, investor } = req.body || {};
  if (investor === undefined || investor === null || investor === '') {
    return res.status(400).json({ error: 'INVESTOR_REQUIRED' });
  }
  if (typeof investor !== 'string' || !StrKey.isValidEd25519PublicKey(investor)) {
    return res.status(400).json({ error: 'INVALID_INVESTOR_ADDRESS' });
  }
  if (invoice.smeAddress && investor === invoice.smeAddress) {
    return res.status(422).json({ error: 'SELF_FUNDING_NOT_ALLOWED' });
  }
  if (typeof amount !== 'number' || !(amount > 0) || !Number.isFinite(amount)) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (invoice.status !== 'open') {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; only open invoices can be funded` });
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
