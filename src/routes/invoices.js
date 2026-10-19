'use strict';

const express = require('express');
const store = require('../data/store');
const config = require('../config');
const stellar = require('../lib/stellar-validate');

const router = express.Router();

const allowedCurrencies = () =>
  config.supportedAssets.map((a) => (a.issuer ? `${a.code}:${a.issuer}` : a.code));

/**
 * Resolves a requested currency against the configured supported assets.
 *
 * @param {unknown} input requested currency (undefined means default USDC)
 * @returns {string|null} normalised currency, or null if unsupported
 */
function resolveCurrency(input) {
  const raw = input === undefined ? 'USDC' : input;
  if (typeof raw !== 'string') {
    return null;
  }
  const [code, issuer] = raw.trim().toUpperCase().split(':');
  const match = config.supportedAssets.find(
    (a) => a.code === code && (issuer === undefined ? true : a.issuer === issuer),
  );
  return match ? (issuer === undefined ? match.code : `${match.code}:${match.issuer}`) : null;
}

/**
 * Validates a create-invoice payload.
 *
 * @param {object} body request body
 * @returns {{ value?: object, errors?: string[], code?: string }} validated fields or errors
 */
function validateInvoice(body) {
  const errors = [];
  const b = body || {};
  if (b.smeAddress !== undefined && b.smeAddress !== null) {
    const check = stellar.checkAddress(b.smeAddress);
    if (!check.ok) {
      return { errors: [check.message], code: check.code };
    }
  }
  const currency = resolveCurrency(b.currency);
  if (currency === null) {
    return {
      errors: [`currency must be one of ${allowedCurrencies().join(', ')}`],
      code: 'UNSUPPORTED_CURRENCY',
    };
  }
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
      currency,
      yieldBps,
      dueDate: b.dueDate,
    },
  };
}

router.get('/', (req, res) => {
  const { status, smeAddress } = req.query;
  if (status && !store.STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${store.STATUSES.join(', ')}` });
  }
  if (smeAddress !== undefined) {
    const check = stellar.checkAddress(smeAddress);
    if (!check.ok) {
      return res.status(400).json({ error: check.message, code: check.code });
    }
  }
  let data = status ? store.list().filter((i) => i.status === status) : store.list();
  if (smeAddress !== undefined) {
    data = data.filter((i) => i.smeAddress === smeAddress);
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

router.post('/', (req, res) => {
  const { value, errors, code } = validateInvoice(req.body);
  if (code) {
    const body = { error: errors[0], code };
    if (code === 'UNSUPPORTED_CURRENCY') {
      body.allowed = allowedCurrencies();
    }
    return res.status(400).json(body);
  }
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

module.exports = router;
module.exports.validateInvoice = validateInvoice;
