'use strict';

const express = require('express');
const store = require('../data/store');

const { InvalidTransitionError, TRANSITIONS, transition } = require('../domain/invoice-state');

const router = express.Router();

/**
 * Maps an InvalidTransitionError to a 409 response; rethrows anything else.
 *
 * @param {Error} err caught error
 * @param {object} res express response
 * @returns {object} the response
 */
function handleTransitionError(err, res) {
  if (err instanceof InvalidTransitionError) {
    return res.status(409).json({
      error: `Invoice is ${err.from}; cannot move to ${err.to}`,
      code: err.code,
      from: err.from,
      to: err.to,
    });
  }
  throw err;
}

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
    return res.status(400).json({ error: `status must be one of ${store.STATUSES.join(', ')}` });
  }
  const data = status ? store.list().filter((i) => i.status === status) : store.list();
  return res.json({ data, count: data.length });
});

router.get('/:id', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  return res.json({ data: invoice });
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
  const amount = req.body && req.body.amount;
  if (typeof amount !== 'number' || !(amount > 0)) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  // TODO(auth)
  try {
    return res.json({ data: store.fund(invoice, amount) });
  } catch (err) {
    return handleTransitionError(err, res);
  }
});

router.post('/:id/cancel', (req, res) => {
  // TODO(auth)
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  const reason = req.body && req.body.reason;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 280) {
    return res.status(400).json({ error: 'reason must be a non-empty string (max 280 chars)' });
  }
  const refundDue = invoice.fundedAmount > 0 ? invoice.fundedAmount : undefined;
  try {
    transition(invoice, 'cancelled', { reason });
  } catch (err) {
    return handleTransitionError(err, res);
  }
  const body = { data: invoice };
  if (refundDue !== undefined) {
    body.refundDue = refundDue;
  }
  return res.json(body);
});

router.post('/:id/withdraw', (req, res) => {
  // TODO(auth)
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  try {
    transition(invoice, 'withdrawn', { reason: 'SME withdrew liquidity' });
  } catch (err) {
    return handleTransitionError(err, res);
  }
  return res.json({ data: invoice });
});

router.post('/:id/settle', (req, res) => {
  // TODO(auth)
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  const settledAmount = req.body && req.body.settledAmount;
  if (typeof settledAmount !== 'number' || !Number.isFinite(settledAmount) || settledAmount < 0) {
    return res.status(400).json({ error: 'settledAmount must be a non-negative number' });
  }
  if (!TRANSITIONS[invoice.status].includes('settled')) {
    return handleTransitionError(new InvalidTransitionError(invoice.status, 'settled'), res);
  }
  const required = invoice.fundedAmount + Math.floor((invoice.fundedAmount * invoice.yieldBps) / 10000);
  if (settledAmount < required) {
    return res.status(422).json({
      error: `settledAmount must be at least ${required} (funded amount + coupon)`,
      code: 'INSUFFICIENT_SETTLEMENT',
      required,
    });
  }
  try {
    transition(invoice, 'settled', { reason: `settled with ${settledAmount}` });
  } catch (err) {
    return handleTransitionError(err, res);
  }
  return res.json({ data: invoice });
});

module.exports = router;
module.exports.validateInvoice = validateInvoice;
