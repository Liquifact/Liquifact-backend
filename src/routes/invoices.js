'use strict';

const express = require('express');
const store = require('../data/store');
const escrowReader = require('./escrow');
const { StrKey } = require('@stellar/stellar-sdk');
const { createHash, timingSafeEqual } = require('node:crypto');

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


function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) return res.status(503).json({ code: 'ADMIN_TOKEN_NOT_CONFIGURED', error: 'Admin token not configured' });
  const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Admin bearer token required' });
  const hash = (value) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(match[1]), hash(expected))) {
    return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid admin bearer token' });
  }
  return next();
}

// Convert exact decimal amounts to 7-decimal stroops, never round excess precision.
function exactStroops(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(amount));
  if (!match) return null;
  const digits = match[1] + (match[2] || '');
  const shift = Number(match[3] || 0) - (match[2] || '').length + 7;
  if (shift < 0) {
    const excess = -shift;
    if (excess > digits.length) return /^0+$/.test(digits) ? '0' : null;
    if (!/^0*$/.test(digits.slice(-excess))) return null;
    return BigInt(digits.slice(0, -excess) || '0').toString();
  }
  return (BigInt(digits) * 10n ** BigInt(shift)).toString();
}

function validateEscrowTerms(invoice, escrow) {
  const mismatches = [];
  const check = (field, expected, actual) => {
    if (expected === null || String(expected) !== String(actual)) {
      mismatches.push({ field, expected: expected === null ? null : String(expected), actual: actual == null ? null : String(actual) });
    }
  };
  check('invoice_id', invoice.id, escrow.invoice_id);
  check('amount', exactStroops(invoice.amount), escrow.amount);
  if (invoice.smeAddress) check('sme_address', invoice.smeAddress, escrow.sme_address);
  check('yield_bps', invoice.yieldBps, escrow.yield_bps);
  if (String(escrow.status) === '4') mismatches.push({ field: 'status', expected: 'not cancelled (4)', actual: '4' });
  return mismatches;
}

router.post('/:id/escrow', requireAdminToken, async (req, res) => {
  const { contractId } = req.body || {};
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    return res.status(400).json({ code: 'INVALID_CONTRACT_ID', error: 'Invalid Stellar contract ID' });
  }
  const invoice = store.get(req.params.id);
  if (!invoice) return res.status(404).json({ code: 'INVOICE_NOT_FOUND', error: 'Invoice not found' });
  if (invoice.escrowContractId === contractId) return res.json({ data: invoice });
  if (invoice.escrowContractId) return res.status(409).json({ code: 'ALREADY_LINKED', error: 'Invoice already linked to another escrow' });
  if (store.list().some((i) => i.id !== invoice.id && i.escrowContractId === contractId)) {
    return res.status(409).json({ code: 'CONTRACT_IN_USE', error: 'Contract already linked to another invoice' });
  }
  let escrow;
  try {
    escrow = await escrowReader.readEscrowOnChain(contractId);
  } catch (_err) {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Contract escrow could not be read' });
  }
  if (!escrow || typeof escrow !== 'object' || Array.isArray(escrow)) {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Contract is not an escrow' });
  }
  const mismatches = validateEscrowTerms(invoice, escrow);
  if (mismatches.length) return res.status(422).json({ code: 'ESCROW_TERMS_MISMATCH', mismatches });
  const conflict = store.linkEscrow(invoice, contractId);
  if (conflict) return res.status(409).json({ code: conflict, error: 'Escrow link conflict' });
  return res.json({ data: invoice });
});

router.get('/:id/escrow', async (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) return res.status(404).json({ code: 'INVOICE_NOT_FOUND', error: 'Invoice not found' });
  if (!invoice.escrowContractId) return res.status(404).json({ code: 'NOT_LINKED', error: 'Invoice has no linked escrow' });
  try {
    const escrow = await escrowReader.readEscrowOnChain(invoice.escrowContractId);
    return res.json({ contractId: invoice.escrowContractId, escrow });
  } catch (_err) {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Linked escrow could not be read' });
  }
});

module.exports = router;
module.exports.exactStroops = exactStroops;
module.exports.validateInvoice = validateInvoice;
