'use strict';

const express = require('express');
const store = require('../data/store');
const { auditContext } = require('../audit/middleware');

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
  const amount = req.body && req.body.amount;
  const before = { fundedAmount: invoice.fundedAmount, status: invoice.status };
  const requested = {
    requestedAmount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    requestedAmountType: typeof amount,
  };
  if (typeof amount !== 'number' || !(amount > 0)) {
    return reject(400, 'amount must be a positive number', { before, metadata: requested });
  }
  if (invoice.status !== 'open') {
    return reject(409, `Invoice is ${invoice.status}; only open invoices can be funded`, {
      before,
      metadata: requested,
    });
  }
  const updated = store.fund(invoice, amount);
  record({
    outcome: 'success',
    statusCode: 200,
    before,
    after: { fundedAmount: updated.fundedAmount, status: updated.status },
    metadata: requested,
  });
  return res.json({ data: updated });
});

module.exports = router;
module.exports.validateInvoice = validateInvoice;
