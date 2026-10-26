'use strict';

/**
 * In-memory data store seeded with demo invoices. Serverless instances are
 * stateless, so writes and lookup indexes live for a warm instance only; this
 * is intentional for the public demo (no database required). The indexes
 * improve local lookup efficiency but are not distributed coordination.
 */

const assert = require('node:assert');
const contributions = require('./contributions');
const { formatAmount, toMinorUnits } = require('../lib/money');
const config = require('../config');

const STATUSES = ['open', 'funded', 'settled', 'cancelled'];
const INVOICE_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

const seed = () => {
  const records = [
  {
    id: 'INV_0001',
    sme: 'Acme Components Ltd',
    smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
    debtor: 'Globex Retail',
    amount: 100,
    currency: 'XLM',
    fundedAmount: 0,
    yieldBps: 800,
    dueDate: '2027-01-17',
    status: 'open',
    escrowContractId: config.contractId,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  {
    id: 'INV_0002',
    sme: 'Northwind Textiles',
    smeAddress: 'GBNORTHWINDDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    debtor: 'Initech Wholesale',
    amount: 25000,
    currency: 'USDC',
    fundedAmount: 18000,
    yieldBps: 650,
    dueDate: '2026-12-30',
    status: 'open',
    escrowContractId: null,
    createdAt: '2026-10-02T09:30:00.000Z',
  },
  {
    id: 'INV_0003',
    sme: 'Blue Harbor Logistics',
    smeAddress: 'GBBLUEHARBORDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    debtor: 'Umbrella Foods',
    amount: 42000,
    currency: 'USDC',
    fundedAmount: 42000,
    yieldBps: 720,
    dueDate: '2026-11-28',
    status: 'funded',
    escrowContractId: null,
    createdAt: '2026-09-15T14:00:00.000Z',
  },
  {
    id: 'INV_0004',
    sme: 'Sunrise Agritech',
    smeAddress: 'GBSUNRISEDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    debtor: 'Stark Industries',
    amount: 12500,
    currency: 'USDC',
    fundedAmount: 12500,
    yieldBps: 900,
    dueDate: '2026-09-30',
    status: 'settled',
    escrowContractId: null,
    createdAt: '2026-07-01T08:00:00.000Z',
  },
  ];
  for (const inv of records) {
    assert.strictEqual(
      toMinorUnits(inv.fundedAmount),
      contributions.sumForInvoice(inv.id),
      `Invoice ${inv.id} fundedAmount must equal contributions sum`,
    );
  }
  return records;
};

/**
 * Normalizes a displayed SME or debtor name for identity comparison.
 *
 * @param {string} value display name
 * @returns {string} lowercased name without punctuation and with collapsed whitespace
 */
function normalizeIdentity(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * JSON array encoding avoids ambiguous delimiter-based composite keys.
 *
 * @param {Array<unknown>} parts key components
 * @returns {string} composite key
 */
function compositeKey(parts) {
  return JSON.stringify(parts);
}

/**
 * @param {object} invoice invoice fields
 * @returns {string} key identifying the same SME + invoice number
 */
function exactKey(invoice) {
  const number = String(invoice.invoiceNumber ?? '').trim();
  return compositeKey([normalizeIdentity(invoice.sme), number]);
}

/**
 * @param {object} invoice invoice fields
 * @returns {string} key identifying the same receivable (SME, debtor, amount, due date)
 */
function fuzzyKey(invoice) {
  const amount = invoice.amountMinor !== undefined ? formatAmount(toMinorUnits(invoice.amountMinor)) : String(invoice.amount);
  return compositeKey([normalizeIdentity(invoice.sme), normalizeIdentity(invoice.debtor), amount, invoice.dueDate]);
}

/**
 * @param {object} invoice invoice fields
 * @returns {boolean} whether the invoice carries an invoice number
 */
function hasInvoiceNumber(invoice) {
  return typeof invoice.invoiceNumber === 'string' && invoice.invoiceNumber.trim().length > 0;
}

/**
 * @param {unknown} id candidate id
 * @returns {boolean} whether the id is contract-compatible
 */
function isValidInvoiceId(id) {
  return typeof id === 'string' && INVOICE_ID_PATTERN.test(id);
}

/**
 * Creates the next unused INV_XXXX identifier without changing seed IDs.
 *
 * @param {{ has?: (id: string) => boolean }} [opts] existence check
 * @returns {string} an unused invoice id
 */
function generateInvoiceId({ has = () => false } = {}) {
  for (let sequence = 1; sequence <= Number.MAX_SAFE_INTEGER; sequence += 1) {
    const id = `INV_${String(sequence).padStart(4, '0')}`;
    if (!has(id)) {
      return id;
    }
  }
  throw new Error('Unable to generate a unique invoice ID');
}

class DuplicateInvoiceError extends Error {
  /**
   * @param {'DUPLICATE_INVOICE'|'POSSIBLE_DUPLICATE'} code duplicate kind
   * @param {string} existingId id of the invoice already on file
   */
  constructor(code, existingId) {
    super(code);
    this.name = 'DuplicateInvoiceError';
    this.code = code;
    this.existingId = existingId;
  }
}

/**
 * Defines `onChain` as a derived, enumerable property: an invoice is on-chain
 * exactly when it has a verified linked escrow contract.
 *
 * @param {object} invoice invoice record
 * @returns {object} the same record
 */
function withDerivedOnChain(invoice) {
  Object.defineProperty(invoice, 'onChain', {
    enumerable: true,
    configurable: true,
    get() {
      return this.escrowContractId !== null && this.escrowContractId !== undefined;
    },
  });
  return invoice;
}

/**
 * Stores money as bigint minor units (non-enumerable `amountMinor`,
 * `fundedAmountMinor`) and exposes `amount`/`fundedAmount` as canonical decimal
 * strings, so JSON serialisation (responses, audit log, webhooks) never sees a
 * bigint or a float. Accepts legacy numeric/decimal `amount` input.
 *
 * @param {object} record invoice record (mutated)
 * @returns {object} the same record
 */
function withMoney(record) {
  const amountMinor = record.amountMinor !== undefined ? toMinorUnits(record.amountMinor) : toMinorUnits(record.amount);
  const fundedAmountMinor = record.fundedAmountMinor !== undefined
    ? toMinorUnits(record.fundedAmountMinor)
    : toMinorUnits(record.fundedAmount || 0);
  delete record.amount;
  delete record.fundedAmount;
  Object.defineProperty(record, 'amountMinor', { value: amountMinor, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(record, 'fundedAmountMinor', { value: fundedAmountMinor, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(record, 'amount', {
    enumerable: true,
    configurable: true,
    get() {
      return formatAmount(this.amountMinor);
    },
  });
  Object.defineProperty(record, 'fundedAmount', {
    enumerable: true,
    configurable: true,
    get() {
      return formatAmount(this.fundedAmountMinor);
    },
  });
  return record;
}

let invoices = [];
let invoicesById = new Map();
let exactIndex = new Map();
let fuzzyIndex = new Map();

/**
 * @param {Map<string, Set<string>>} index target index
 * @param {string} key index key
 * @param {string} id invoice id
 */
function addToIndex(index, key, id) {
  const ids = index.get(key) || new Set();
  ids.add(id);
  index.set(key, ids);
}

/** @param {object} invoice stored invoice to index */
function indexInvoice(invoice) {
  invoicesById.set(invoice.id, invoice);
  if (!hasInvoiceNumber(invoice)) {
    return;
  }
  addToIndex(exactIndex, exactKey(invoice), invoice.id);
  addToIndex(fuzzyIndex, fuzzyKey(invoice), invoice.id);
}

/** Rebuilds every lookup index from the invoice list. */
function rebuildIndexes() {
  invoicesById = new Map();
  exactIndex = new Map();
  fuzzyIndex = new Map();
  for (const invoice of invoices) {
    indexInvoice(invoice);
  }
}

/**
 * @param {Map<string, Set<string>>} index index to search
 * @param {string} key index key
 * @returns {object|undefined} first matching invoice that is not cancelled
 */
function findEligible(index, key) {
  const ids = index.get(key);
  if (!ids) {
    return undefined;
  }
  for (const id of ids) {
    const invoice = invoicesById.get(id);
    // Statuses are mutable; retaining IDs and filtering here prevents stale blocks.
    if (invoice && invoice.status !== 'cancelled') {
      return invoice;
    }
  }
  return undefined;
}

/** @returns {object[]} all invoices */
function list() {
  return invoices;
}

/**
 * @param {string} id invoice id
 * @returns {object|undefined} the invoice
 */
function get(id) {
  return invoicesById.get(id);
}

/**
 * @param {object} invoice candidate invoice fields
 * @returns {object|undefined} existing non-cancelled invoice with the same SME + invoice number
 */
function findExactDuplicate(invoice) {
  if (!hasInvoiceNumber(invoice)) {
    return undefined;
  }
  return findEligible(exactIndex, exactKey(invoice));
}

/**
 * @param {object} invoice candidate invoice fields
 * @returns {object|undefined} existing non-cancelled invoice for the same receivable
 */
function findPossibleDuplicate(invoice) {
  if (!hasInvoiceNumber(invoice)) {
    return undefined;
  }
  return findEligible(fuzzyIndex, fuzzyKey(invoice));
}

/**
 * Inserts validated fields after local duplicate and id integrity checks.
 *
 * @param {object} invoice validated invoice fields
 * @returns {object} the stored invoice
 * @throws {DuplicateInvoiceError} when the invoice duplicates an existing one
 */
function create(invoice) {
  const exact = findExactDuplicate(invoice);
  if (exact) {
    throw new DuplicateInvoiceError('DUPLICATE_INVOICE', exact.id);
  }
  const possible = findPossibleDuplicate(invoice);
  if (possible && invoice.confirmNotDuplicate !== true) {
    throw new DuplicateInvoiceError('POSSIBLE_DUPLICATE', possible.id);
  }
  const id = generateInvoiceId({ has: (candidate) => invoicesById.has(candidate) });
  if (!isValidInvoiceId(id)) {
    throw new Error('Generated invalid invoice ID');
  }
  const record = {
    id,
    fundedAmountMinor: 0n,
    status: 'open',
    escrowContractId: null,
    createdAt: new Date().toISOString(),
    duplicateOverride: invoice.confirmNotDuplicate === true,
    ...invoice,
  };
  delete record.confirmNotDuplicate;
  withMoney(record);
  withDerivedOnChain(record);
  invoices.push(record);
  indexInvoice(record);
  return record;
}

/**
 * Amount fields of an invoice in minor units (7 decimals). Store records keep
 * bigint `amountMinor`/`fundedAmountMinor`; plain objects fall back to their
 * decimal `amount`/`fundedAmount`.
 *
 * @param {object} invoice invoice record
 * @returns {{ amountMinor: bigint, fundedAmountMinor: bigint }} minor units
 */
function minorOf(invoice) {
  return {
    amountMinor: invoice.amountMinor !== undefined ? invoice.amountMinor : toMinorUnits(invoice.amount),
    fundedAmountMinor: invoice.fundedAmountMinor !== undefined
      ? invoice.fundedAmountMinor
      : toMinorUnits(invoice.fundedAmount || 0),
  };
}

/**
 * Remaining funding capacity for an invoice.
 *
 * @param {object} invoice target invoice
 * @returns {bigint} minor units that can still be contributed
 */
function remaining(invoice) {
  const { amountMinor, fundedAmountMinor } = minorOf(invoice);
  return amountMinor - fundedAmountMinor;
}

/**
 * Records an investor contribution against an open invoice.
 *
 * @param {object} invoice target invoice
 * @param {number} amount contribution amount
 * @param {string} investor investor Stellar address
 * @returns {object} updated invoice
 */
function fund(invoice, amount, investor) {
  const amountMinor = toMinorUnits(amount);
  if (!(amountMinor <= remaining(invoice))) {
    throw new Error('fund() called with amount exceeding remaining capacity');
  }
  assert(investor, 'investor address is required to fund an invoice');
  contributions.record({ invoiceId: invoice.id, investor, amountMinor });
  invoice.fundedAmountMinor = contributions.sumForInvoice(invoice.id);
  if (invoice.fundedAmountMinor >= invoice.amountMinor) {
    invoice.status = 'funded';
  }
  assert.strictEqual(
    invoice.fundedAmountMinor,
    contributions.sumForInvoice(invoice.id),
    `Invoice ${invoice.id} fundedAmount must equal contributions sum`,
  );
  return invoice;
}

/**
 * Marks a fully funded invoice as settled (debtor paid).
 *
 * @param {object} invoice target invoice
 * @returns {object} updated invoice
 */
function settle(invoice) {
  invoice.status = 'settled';
  return invoice;
}

/**
 * Cancels an open or funded invoice.
 *
 * @param {object} invoice target invoice
 * @returns {object} updated invoice
 */
function cancel(invoice) {
  invoice.status = 'cancelled';
  return invoice;
}

/** Restores the seed data (used by tests). */
function reset() {
  contributions.reset();
  invoices = seed().map((record) => withDerivedOnChain(withMoney(record)));
  rebuildIndexes();
}

/**
 * Links a verified escrow contract to an invoice.
 *
 * @param {object} invoice target invoice
 * @param {string} contractId verified escrow contract id
 * @returns {null|'ALREADY_LINKED'|'CONTRACT_IN_USE'} null on success, otherwise the conflict code
 */
function linkEscrow(invoice, contractId) {
  if (invoice.escrowContractId && invoice.escrowContractId !== contractId) {
    return 'ALREADY_LINKED';
  }
  if (invoices.some((other) => other !== invoice && other.escrowContractId === contractId)) {
    return 'CONTRACT_IN_USE';
  }
  invoice.escrowContractId = contractId;
  return null;
}

reset();

module.exports = {
  STATUSES,
  normalizeIdentity,
  compositeKey,
  exactKey,
  fuzzyKey,
  isValidInvoiceId,
  generateInvoiceId,
  DuplicateInvoiceError,
  list,
  get,
  findExactDuplicate,
  findPossibleDuplicate,
  create,
  fund,
  remaining,
  minorOf,
  settle,
  cancel,
  linkEscrow,
  reset,
};
