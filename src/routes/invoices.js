'use strict';

const express = require('express');
const store = require('../data/store');

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
  if (invoice.status !== 'open') {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; only open invoices can be funded` });
  }
  return res.json({ data: store.fund(invoice, amount) });
});

router.post('/:id/settle', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (invoice.status !== 'funded') {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; only funded invoices can be settled` });
  }
  return res.json({ data: store.settle(invoice) });
});

router.post('/:id/cancel', (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (invoice.status !== 'open' && invoice.status !== 'funded') {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; only open or funded invoices can be cancelled` });
  }
  return res.json({ data: store.cancel(invoice) });
});

module.exports = router;
module.exports.validateInvoice = validateInvoice;
