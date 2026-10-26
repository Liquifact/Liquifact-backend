'use strict';

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const store = require('../data/store');
const { auditContext } = require('../audit/middleware');
const contributions = require('../data/contributions');
const { sendRepoError } = require('../data/errors');
const config = require('../config');
const { toMinor, fromMinor, couponMinor, daysBetween, annualisedBps } = require('../domain/returns');
const { ApiError, badRequest, notFound, conflict, unprocessable, sendProblem } = require('../errors');
const { parseInvoiceQuery, queryInvoices, InvoiceQueryError } = require('../services/invoice-query');
const { requireAdminToken } = require('../middleware/require-admin-token');
const escrowReader = require('./escrow');
const { CreateInvoiceBody, FundInvoiceBodyShape, InvoiceIdParam } = require('../schemas');
const { validate } = require('../middleware/validate');
const emitter = require('../webhooks/emitter');
const { parseAmount, formatAmount } = require('../lib/money');
const idempotency = require('../middleware/idempotency');
const { requireRole } = require('../middleware/auth');
const smes = require('../data/smes');

const router = express.Router();
router.use(auditContext());

/**
 * Adds the computed remainingCapacity field to an invoice representation.
 *
 * @param {object} invoice invoice record
 * @returns {object} invoice with remainingCapacity
 */
function present(invoice) {
  if (!invoice) {
    return invoice;
  }
  // amount/fundedAmount are decimal strings (7 decimals, see lib/money.js).
  return { ...invoice, remainingCapacity: formatAmount(store.remaining(invoice)), decimals: 7 };
}

/**
 * Maps a parsed CreateInvoiceBody to the stored invoice fields (trim,
 * uppercase currency, defaults: yieldBps 800, currency USDC).
 *
 * @param {object} d parsed CreateInvoiceBody
 * @returns {object} invoice fields
 */
function toInvoiceValue(d) {
  const invoiceNumber = typeof d.invoiceNumber === 'string' ? d.invoiceNumber.trim() : undefined;
  return {
    ...(typeof d.sme === 'string' ? { sme: d.sme.trim() } : {}),
    ...(d.smeId ? { smeId: d.smeId } : {}),
    debtor: d.debtor.trim(),
    ...(invoiceNumber ? { invoiceNumber } : {}),
    smeAddress: typeof d.smeAddress === 'string' ? d.smeAddress : null,
    amountMinor: parseAmount(d.amount),
    currency: typeof d.currency === 'string' ? d.currency.toUpperCase().slice(0, 12) : 'USDC',
    yieldBps: d.yieldBps == null ? 800 : d.yieldBps,
    dueDate: d.dueDate,
    confirmNotDuplicate: d.confirmNotDuplicate === true,
  };
}

/**
 * Validates a create-invoice payload (backward-compatible wrapper around the
 * CreateInvoiceBody zod schema).
 *
 * @param {object} body request body
 * @returns {{ value?: object, errors?: string[] }} validated fields or errors
 */
function validateInvoice(body) {
  const result = CreateInvoiceBody.safeParse(body || {});
  if (!result.success) {
    return { errors: [...new Set(result.error.issues.map((i) => i.message))] };
  }
  return { value: toInvoiceValue(result.data) };
}

const idParam = (audit) => validate({ params: InvoiceIdParam, audit });

router.get('/', (req, res) => {
  try {
    const query = parseInvoiceQuery(req.query);
    const page = queryInvoices(store.list(), query);
    return res.json({ ...page, data: page.data.map(present) });
  } catch (error) {
    if (!(error instanceof InvoiceQueryError)) {
      throw error;
    }
    const fieldErrors = Object.entries(error.details || {}).map(([field, message]) => ({ field, message }));
    // Keep the parameter-keyed `details` map existing clients rely on, alongside RFC 7807 `errors`.
    throw new ApiError(400, error.code, error.message, { errors: fieldErrors, extra: { details: error.details } });
  }
});

router.get('/:id', idParam(), (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }
  return res.json({ data: present(invoice) });
});

router.get('/:id/quote', idParam(), (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }
  if (invoice.status !== 'open') {
    throw conflict('INVOICE_NOT_OPEN');
  }
  const { amount, asOf } = req.query;
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(amount)) {
    throw badRequest('INVALID_AMOUNT');
  }
  const parsedAsOf = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? new Date(`${asOf}T00:00:00.000Z`)
    : null;
  if (asOf !== undefined && (!parsedAsOf || Number.isNaN(parsedAsOf.getTime()) || parsedAsOf.toISOString().slice(0, 10) !== asOf)) {
    throw badRequest('INVALID_AS_OF');
  }
  let principalMinor;
  let capacityMinor;
  try {
    principalMinor = toMinor(amount);
    capacityMinor = store.remaining(invoice);
  } catch {
    throw badRequest('INVALID_AMOUNT');
  }
  if (principalMinor <= 0n) {
    throw badRequest('INVALID_AMOUNT');
  }
  if (principalMinor > capacityMinor) {
    throw unprocessable('EXCEEDS_CAPACITY');
  }
  const quoteAsOf = asOf || new Date().toISOString().slice(0, 10);
  const daysToMaturity = daysBetween(quoteAsOf, invoice.dueDate);
  if (daysToMaturity <= 0) {
    throw conflict('INVOICE_MATURED');
  }
});

/**
 * Resolves the SME identity of a new invoice.
 *
 * With REQUIRE_SME_VERIFICATION=true an smeId is required, the SME must be
 * verified, and `sme`/`smeAddress` always come from the SME record (client
 * values are ignored, so an invoice cannot impersonate another SME). Without
 * the flag, an smeId is optional; when given, it must exist and fills in any
 * identity fields the client left out.
 *
 * @param {object} value validated invoice fields (mutated)
 * @returns {{ status: number, error: string, code: string }|null} rejection, or null when accepted
 */
function applySmeIdentity(value) {
  const enforce = process.env.REQUIRE_SME_VERIFICATION === 'true';
  if (enforce && !value.smeId) {
    return { status: 400, error: 'smeId is required when SME verification is enabled', code: 'SME_ID_REQUIRED' };
  }
  if (!value.smeId) {
    return null;
  }
  const sme = smes.getSme(value.smeId);
  if (!sme) {
    return { status: 404, error: 'SME not found', code: 'SME_NOT_FOUND' };
  }
  if (enforce) {
    if (sme.status !== 'verified') {
      return { status: 403, error: 'Only verified SMEs may create invoices', code: 'SME_NOT_VERIFIED' };
    }
    value.sme = sme.legalName;
    value.smeAddress = sme.stellarAddress;
    return null;
  }
  if (value.sme === undefined) {
    value.sme = sme.legalName;
  }
  if (value.smeAddress === null) {
    value.smeAddress = sme.stellarAddress;
  }
  return null;
}

router.post('/', requireRole('sme', 'admin'), idempotency, validate({ body: CreateInvoiceBody, audit: 'invoice.create', fieldCodes: { amount: 'INVALID_AMOUNT' } }), (req, res) => {
  // Record the opaque API key id that created the invoice (safe to return publicly).
  const value = { ...toInvoiceValue(req.validatedBody), createdBy: req.principal.keyId };
  const smeRejection = applySmeIdentity(value);
  if (smeRejection) {
    req.audit({
      action: 'invoice.create',
      resourceType: 'invoice',
      outcome: 'rejected',
      statusCode: smeRejection.status,
      metadata: { code: smeRejection.code, smeId: value.smeId || null },
    });
    return res.status(smeRejection.status).json({ error: smeRejection.error, code: smeRejection.code });
  }
  let invoice;
  try {
    invoice = store.create(value);
  } catch (error) {
    if (!(error instanceof store.DuplicateInvoiceError)) {
      throw error;
    }
    req.audit({
      action: 'invoice.create',
      resourceType: 'invoice',
      outcome: 'rejected',
      statusCode: 409,
      metadata: { code: error.code, existingId: error.existingId },
    });
    return res.status(409).json({ code: error.code, existingId: error.existingId });
  }
  req.audit({
    action: 'invoice.create',
    resourceType: 'invoice',
    resourceId: invoice.id,
    outcome: 'success',
    statusCode: 201,
    after: invoice,
  });
  emitter.emit('invoice.created', present(invoice));
  return res.status(201).json({ data: present(invoice) });
});

router.post('/:id/fund', requireRole('investor', 'admin'), idempotency, validate({ params: InvoiceIdParam, body: FundInvoiceBodyShape, audit: 'invoice.fund' }), (req, res) => {
  const record = (details) =>
    req.audit({ action: 'invoice.fund', resourceType: 'invoice', resourceId: req.params.id, ...details });
  const reject = (statusCode, error, details, extra = {}) => {
    record({ outcome: 'rejected', statusCode, metadata: { error, ...details.metadata }, before: details.before });
    const { code: extraCode, ...rest } = extra;
    const isCode = /^[A-Z_]+$/.test(error);
    const code = extraCode || (isCode ? error : { 404: 'INVOICE_NOT_FOUND', 409: 'INVOICE_NOT_OPEN' }[statusCode]);
    return sendProblem(req, res, code, {
      status: statusCode,
      detail: isCode ? undefined : error,
      extra: Object.keys(rest).length ? rest : undefined,
    });
  };

  const invoice = store.get(req.params.id);
  if (!invoice) {
    return reject(404, 'Invoice not found', {});
  }
  const body = req.body || {};
  const { amount, investor } = body;
  const before = { fundedAmount: invoice.fundedAmount, status: invoice.status };
  const requested = {
    requestedAmount: (typeof amount === 'number' && Number.isFinite(amount)) || typeof amount === 'string' ? amount : null,
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
  // Money is parsed into bigint minor units (7 decimals); floats never touch the arithmetic.
  let amountMinor;
  try {
    amountMinor = parseAmount(amount);
  } catch {
    return reject(400, 'amount must be a positive amount with at most 7 fractional digits', { before, metadata: requested }, { code: 'INVALID_AMOUNT' });
  }
  if (amountMinor > invoice.amountMinor) {
    return reject(400, 'amount must not exceed the invoice face value', { before, metadata: requested }, {
      code: 'INVALID_AMOUNT',
    });
  }
  if (invoice.status !== 'open') {
    return reject(409, `Invoice is ${invoice.status}; only open invoices can be funded`, {
      before,
      metadata: requested,
    });
  }

  // Contributions are accepted in full or rejected; allowPartial explicitly caps at remaining capacity.
  const remainingMinor = store.remaining(invoice);
  const remainingCapacity = formatAmount(remainingMinor);
  let acceptedMinor = amountMinor;
  if (amountMinor > remainingMinor) {
    if (body.allowPartial !== true) {
      return reject(422, 'Contribution exceeds remaining capacity', {
        before,
        metadata: { ...requested, remainingCapacity },
      }, { code: 'FUNDING_EXCEEDS_CAPACITY', remainingCapacity });
    }
    acceptedMinor = remainingMinor;
  }
  const partial = acceptedMinor !== amountMinor;
  const accepted = formatAmount(acceptedMinor);
  const rejected = formatAmount(amountMinor - acceptedMinor);
  const wasFunded = invoice.status === 'funded';
  const updated = store.fund(invoice, acceptedMinor, investor);
  // Emit funding_received for every contribution; emit funded when status flips to funded
  emitter.emit('invoice.funding_received', present(updated));
  if (!wasFunded && updated.status === 'funded') {
    emitter.emit('invoice.funded', present(updated));
  }
  record({
    outcome: 'success',
    statusCode: 200,
    before,
    after: { fundedAmount: updated.fundedAmount, status: updated.status },
    metadata: partial ? { ...requested, accepted, rejected } : requested,
  });
  if (partial) {
    return res.json({ data: present(updated), accepted, rejected });
  }
  return res.json({ data: present(updated) });
});

router.get('/:id/contributions', idParam(), (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    throw notFound('INVOICE_NOT_FOUND');
  }

  let limit = 50;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest('INVALID_LIMIT');
    }

  const all = contributions.listByInvoice(invoice.id);
  let startIndex = 0;
  if (req.query.cursor) {
    const idx = all.findIndex((c) => c.id === req.query.cursor);
    if (idx === -1) {
      throw badRequest('INVALID_CURSOR');
    }
    startIndex = idx + 1;
  }

  const page = all.slice(startIndex, startIndex + limit);
  const data = page.map((c) => ({
    investor: c.investor,
    amount: formatAmount(c.amountMinor),
    createdAt: c.createdAt,
  }));

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

  const response = {
    data,
    totals: {
      funded: totalFunded,
      investors: uniqueInvestors,
    },
    decimals: 7,
  };
  if (nextCursor) {
    response.nextCursor = nextCursor;
  }
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
      return sendProblem(req, res, statusCode === 404 ? 'INVOICE_NOT_FOUND' : 'INVALID_STATE_TRANSITION', { detail: error });
    },
    success(before, updated) {
      record({ outcome: 'success', statusCode: 200, before, after: { fundedAmount: updated.fundedAmount, status: updated.status } });
      return res.json({ data: updated });
    },
  };
}

router.post('/:id/settle', requireRole('admin'), idParam('invoice.settle'), (req, res) => {
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

router.post('/:id/cancel', requireRole('sme', 'admin'), idParam('invoice.cancel'), (req, res) => {
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

/**
 * Converts an exact decimal amount to 7-decimal stroops without rounding away
 * excess precision.
 *
 * @param {number} amount decimal amount
 * @returns {string|null} stroops as a decimal integer string, or null if not exactly representable
 */
function exactStroops(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(amount));
  if (!match) {
    return null;
  }
  const digits = match[1] + (match[2] || '');
  const shift = Number(match[3] || 0) - (match[2] || '').length + 7;
  if (shift < 0) {
    const excess = -shift;
    if (excess > digits.length) {
      return /^0+$/.test(digits) ? '0' : null;
    }
    if (!/^0*$/.test(digits.slice(-excess))) {
      return null;
    }
    return BigInt(digits.slice(0, -excess) || '0').toString();
  }
  return (BigInt(digits) * 10n ** BigInt(shift)).toString();
}

/**
 * Compares an invoice's terms against a decoded `get_escrow` struct.
 *
 * @param {object} invoice off-chain invoice
 * @param {object} escrow on-chain escrow struct
 * @returns {Array<{ field: string, expected: string|null, actual: string|null }>} mismatches
 */
function validateEscrowTerms(invoice, escrow) {
  const mismatches = [];
  const check = (field, expected, actual) => {
    if (expected === null || String(expected) !== String(actual)) {
      mismatches.push({ field, expected: expected === null ? null : String(expected), actual: actual == null ? null : String(actual) });
    }
  };
  check('invoice_id', invoice.id, escrow.invoice_id);
  check('amount', invoice.amountMinor !== undefined ? invoice.amountMinor.toString() : exactStroops(invoice.amount), escrow.amount);
  if (invoice.smeAddress) {
    check('sme_address', invoice.smeAddress, escrow.sme_address);
  }
  check('yield_bps', invoice.yieldBps, escrow.yield_bps);
  if (String(escrow.status) === '4') {
    mismatches.push({ field: 'status', expected: 'not cancelled (4)', actual: '4' });
  }
  return mismatches;
}

/**
 * Makes a decoded contract value JSON-serialisable (BigInt -> decimal string).
 *
 * @param {unknown} value decoded value
 * @returns {unknown} JSON-safe copy
 */
function jsonSafe(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/**
 * Reads the raw `get_escrow` struct of a contract.
 *
 * @param {string} contractId escrow contract id
 * @returns {Promise<object>} decoded native escrow struct
 */
async function readEscrow(contractId) {
  const result = await escrowReader.readEscrowOnChain(contractId);
  return result ? result.native : result;
}

router.post('/:id/escrow', requireAdminToken, idParam(), async (req, res) => {
  const { contractId } = req.body || {};
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    return res.status(400).json({ code: 'INVALID_CONTRACT_ID', error: 'Invalid Stellar contract ID' });
  }
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ code: 'INVOICE_NOT_FOUND', error: 'Invoice not found' });
  }
  if (invoice.escrowContractId === contractId) {
    return res.json({ data: present(invoice) });
  }
  if (invoice.escrowContractId) {
    return res.status(409).json({ code: 'ALREADY_LINKED', error: 'Invoice already linked to another escrow' });
  }
  if (store.list().some((i) => i.id !== invoice.id && i.escrowContractId === contractId)) {
    return res.status(409).json({ code: 'CONTRACT_IN_USE', error: 'Contract already linked to another invoice' });
  }
  let escrow;
  try {
    escrow = await readEscrow(contractId);
  } catch {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Contract escrow could not be read' });
  }
  if (!escrow || typeof escrow !== 'object' || Array.isArray(escrow)) {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Contract is not an escrow' });
  }
  // Reject arbitrary contract return values masquerading as escrow structs.
  if (['invoice_id', 'amount', 'yield_bps', 'status'].some((key) => escrow[key] === undefined || escrow[key] === null)
    || (invoice.smeAddress && (escrow.sme_address === undefined || escrow.sme_address === null))) {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Contract returned an invalid escrow' });
  }
  const mismatches = validateEscrowTerms(invoice, escrow);
  if (mismatches.length) {
    return res.status(422).json({ code: 'ESCROW_TERMS_MISMATCH', mismatches });
  }
  const linkConflict = store.linkEscrow(invoice, contractId);
  if (linkConflict) {
    return res.status(409).json({ code: linkConflict, error: 'Escrow link conflict' });
  }
  req.audit({
    action: 'invoice.escrow.link',
    resourceType: 'invoice',
    resourceId: invoice.id,
    outcome: 'success',
    statusCode: 200,
    before: { escrowContractId: null },
    after: { escrowContractId: contractId },
  });
  return res.json({ data: present(invoice) });
});

router.get('/:id/escrow', idParam(), async (req, res) => {
  const invoice = store.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ code: 'INVOICE_NOT_FOUND', error: 'Invoice not found' });
  }
  if (!invoice.escrowContractId) {
    return res.status(404).json({ code: 'NOT_LINKED', error: 'Invoice has no linked escrow' });
  }
  try {
    const escrow = await readEscrow(invoice.escrowContractId);
    return res.json({ contractId: invoice.escrowContractId, escrow: jsonSafe(escrow) });
  } catch {
    return res.status(422).json({ code: 'ESCROW_NOT_FOUND', error: 'Linked escrow could not be read' });
  }
});

module.exports = router;
module.exports.exactStroops = exactStroops;
module.exports.validateInvoice = validateInvoice;