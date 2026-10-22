'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const contributions = require('../data/contributions');
const { toMinor, fromMinor } = contributions;

const router = express.Router();

/**
 * Computes coupon floored in integer minor units (same as the escrow contract).
 * coupon = principal × yieldBps / 10000
 *
 * @param {bigint} principalMinor principal in minor units (7 dp)
 * @param {number} yieldBps yield in basis points
 * @returns {bigint} coupon in minor units
 */
function computeCouponMinor(principalMinor, yieldBps) {
  return (principalMinor * BigInt(yieldBps || 0)) / 10000n;
}

router.get('/:address/portfolio', (req, res) => {
  const { address } = req.params;

  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    return res.status(400).json({ error: 'INVALID_INVESTOR_ADDRESS' });
  }

  const investorContributions = contributions.listByInvestor(address);
  if (investorContributions.length === 0) {
    return res.json({
      investor: address,
      positions: [],
      totalsByCurrency: {},
    });
  }

  // Aggregate multiple contributions by the same investor to one invoice
  const byInvoice = new Map();
  for (const c of investorContributions) {
    const prev = byInvoice.get(c.invoiceId) || 0n;
    byInvoice.set(c.invoiceId, prev + toMinor(c.amount));
  }

  const positions = [];
  const totalsByCurrency = {};

  for (const [invoiceId, principalMinor] of byInvoice.entries()) {
    const invoice = store.get(invoiceId);
    if (!invoice) {
      continue;
    }

    const principal = fromMinor(principalMinor);
    const isCancelled = invoice.status === 'cancelled';
    const couponMinor = isCancelled ? 0n : computeCouponMinor(principalMinor, invoice.yieldBps);
    const payoutMinor = principalMinor + couponMinor;

    const expectedCoupon = isCancelled ? '0' : fromMinor(couponMinor);
    const expectedPayout = fromMinor(payoutMinor);

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

  const formattedTotals = {};
  for (const [curr, t] of Object.entries(totalsByCurrency)) {
    formattedTotals[curr] = {
      principal: fromMinor(t.principalMinor),
      expectedCoupon: fromMinor(t.couponMinor),
      expectedPayout: fromMinor(t.payoutMinor),
    };
  }

  return res.json({
    investor: address,
    positions,
    totalsByCurrency: formattedTotals,
  });
});

module.exports = router;
module.exports.computeCouponMinor = computeCouponMinor;
