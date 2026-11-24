'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const contributions = require('../data/contributions');
const { formatAmount, mulBps } = require('../lib/money');
const { badRequest } = require('../errors');

const router = express.Router();
const PORTFOLIO_STATUSES = ['open', 'funded', 'settled', 'cancelled'];
const DEFAULT_PORTFOLIO_LIMIT = 50;
const MAX_PORTFOLIO_LIMIT = 100;

const { couponMinor } = require('../domain/returns');

const computeCouponMinor = couponMinor;

router.get('/:address/portfolio', (req, res) => {
  const { address } = req.params;

  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    throw badRequest('INVALID_INVESTOR_ADDRESS');
  }

  let limit = DEFAULT_PORTFOLIO_LIMIT;
  if (req.query.limit !== undefined) {
    if (
      typeof req.query.limit !== 'string'
      || !/^\d+$/.test(req.query.limit)
      || Number(req.query.limit) < 1
      || Number(req.query.limit) > MAX_PORTFOLIO_LIMIT
    ) {
      throw badRequest('INVALID_LIMIT');
    }
    limit = Number(req.query.limit);
  }

  let statuses;
  if (req.query.status !== undefined) {
    if (
      typeof req.query.status !== 'string'
      || req.query.status.split(',').some((status) => !PORTFOLIO_STATUSES.includes(status))
    ) {
      throw badRequest('INVALID_STATUS_FILTER');
    }
    statuses = new Set(req.query.status.split(','));
  }

  const cursor = req.query.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw badRequest('INVALID_CURSOR');
  }

  const investorContributions = contributions.listByInvestor(address);

  // Aggregate multiple contributions by the same investor to one invoice
  const byInvoice = new Map();
  for (const c of investorContributions) {
    const prev = byInvoice.get(c.invoiceId) || 0n;
    byInvoice.set(c.invoiceId, prev + c.amountMinor);
  }

  const positions = [];
  const totalsByCurrency = {};

  for (const [invoiceId, principalMinor] of byInvoice.entries()) {
    const invoice = store.get(invoiceId);
    if (!invoice) {
      continue;
    }
    if (statuses && !statuses.has(invoice.status)) {
      continue;
    }

    const principal = formatAmount(principalMinor);
    const isCancelled = invoice.status === 'cancelled';
    const couponMinor = isCancelled ? 0n : computeCouponMinor(principalMinor, invoice.yieldBps);
    const payoutMinor = principalMinor + couponMinor;

    const expectedCoupon = formatAmount(couponMinor);
    const expectedPayout = formatAmount(payoutMinor);

    positions.push({
      invoiceId: invoice.id,
      status: invoice.status,
      currency: invoice.currency,
      principal,
      yieldBps: invoice.yieldBps,
      dueDate: invoice.dueDate,
      expectedCoupon,
      expectedPayout,
    });

    // Totals intentionally cover the full status-filtered set, not just this page.
    const curr = invoice.currency;
    if (!totalsByCurrency[curr]) {
      totalsByCurrency[curr] = {
        principalMinor: 0n,
        couponMinor: 0n,
        payoutMinor: 0n,
      };
    }

    totalsByCurrency[curr].principalMinor += principalMinor;
    totalsByCurrency[curr].couponMinor += couponMinor;
    totalsByCurrency[curr].payoutMinor += payoutMinor;
  }

  positions.sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));

  let startIndex = 0;
  if (cursor !== undefined) {
    const cursorIndex = positions.findIndex((position) => position.invoiceId === cursor);
    if (cursorIndex === -1) {
      throw badRequest('INVALID_CURSOR');
    }
    startIndex = cursorIndex + 1;
  }

  const page = positions.slice(startIndex, startIndex + limit);
  const nextCursor = page.length > 0 && startIndex + limit < positions.length
    ? page[page.length - 1].invoiceId
    : null;

  const formattedTotals = {};
  for (const [curr, t] of Object.entries(totalsByCurrency)) {
    formattedTotals[curr] = {
      principal: formatAmount(t.principalMinor),
      expectedCoupon: formatAmount(t.couponMinor),
      expectedPayout: formatAmount(t.payoutMinor),
    };
  }

  return res.json({
    investor: address,
    positions: page,
    totalsByCurrency: formattedTotals,
    nextCursor,
  });
});

module.exports = router;
module.exports.computeCouponMinor = computeCouponMinor;