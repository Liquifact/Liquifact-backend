'use strict';

/**
 * In-memory data store seeded with demo invoices. Serverless instances are
 * stateless, so writes and lookup indexes live for a warm instance only.
 * They improve local lookup efficiency but are not distributed coordination.
 */

const assert = require('node:assert');
const contributions = require('./contributions');

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
    onChain: true,
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
    onChain: false,
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
    onChain: false,
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
    onChain: false,
    createdAt: '2026-07-01T08:00:00.000Z',
  },
  ];
  for (const inv of records) {
    assert.strictEqual(
      inv.fundedAmount,
      contributions.sumForInvoice(inv.id),
      `Invoice ${inv.id} fundedAmount must equal contributions sum`,
    );
  }
  return records;
};

/** Normalizes a displayed SME or debtor name for identity comparison. */
function normalizeIdentity(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** JSON array encoding avoids ambiguous delimiter-based composite keys. */
function compositeKey(parts) {
  return JSON.stringify(parts);
}

function exactKey(invoice) {
  const number = String(invoice.invoiceNumber ?? '').trim();
  return compositeKey([normalizeIdentity(invoice.sme), number]);
}

function fuzzyKey(invoice) {
  return compositeKey([normalizeIdentity(invoice.sme), normalizeIdentity(invoice.debtor), invoice.amount, invoice.dueDate]);
}

function hasInvoiceNumber(invoice) {
  return typeof invoice.invoiceNumber === 'string' && invoice.invoiceNumber.trim().length > 0;
}

function isValidInvoiceId(id) {
  return typeof id === 'string' && INVOICE_ID_PATTERN.test(id);
}

/** Creates the next unused INV_XXXX identifier without changing seed IDs. */
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
  constructor(code, existingId) {
    super(code);
    this.code = code;
    this.existingId = existingId;
  }
}

let invoices = [];
let invoicesById = new Map();
let exactIndex = new Map();
let fuzzyIndex = new Map();

function addToIndex(index, key, id) {
  const ids = index.get(key) || new Set();
  ids.add(id);
  index.set(key, ids);
}

function indexInvoice(invoice) {
  invoicesById.set(invoice.id, invoice);
  if (!hasInvoiceNumber(invoice)) {
    return;
  }
  addToIndex(exactIndex, exactKey(invoice), invoice.id);
  addToIndex(fuzzyIndex, fuzzyKey(invoice), invoice.id);
}

function rebuildIndexes() {
  invoicesById = new Map();
  exactIndex = new Map();
  fuzzyIndex = new Map();
  for (const invoice of invoices) {
    indexInvoice(invoice);
  }
}

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

function list() {
  return invoices;
}

function get(id) {
  return invoicesById.get(id);
}

function findExactDuplicate(invoice) {
  if (!hasInvoiceNumber(invoice)) {
    return undefined;
  }
  return findEligible(exactIndex, exactKey(invoice));
}

function findPossibleDuplicate(invoice) {
  if (!hasInvoiceNumber(invoice)) {
    return undefined;
  }
  return findEligible(fuzzyIndex, fuzzyKey(invoice));
}

/** Inserts validated fields after local integrity checks. */
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
  const record = { id, fundedAmount: 0, status: 'open', onChain: false, createdAt: new Date().toISOString(), duplicateOverride: invoice.confirmNotDuplicate === true, ...invoice };
  delete record.confirmNotDuplicate;
  invoices.push(record);
  indexInvoice(record);
  return record;
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
  assert(investor, 'investor address is required to fund an invoice');
  contributions.record({ invoiceId: invoice.id, investor, amount });
  invoice.fundedAmount = contributions.sumForInvoice(invoice.id);
  if (invoice.fundedAmount >= invoice.amount) {
    invoice.status = 'funded';
  }
  assert.strictEqual(
    invoice.fundedAmount,
    contributions.sumForInvoice(invoice.id),
    `Invoice ${invoice.id} fundedAmount must equal contributions sum`,
  );
  return invoice;
}

/** Restores seed data and all derived lookup indexes (used by tests). */
function reset() {
  contributions.reset();
  invoices = seed();
  rebuildIndexes();
}

reset();

module.exports = { STATUSES, normalizeIdentity, compositeKey, exactKey, fuzzyKey, isValidInvoiceId, generateInvoiceId, DuplicateInvoiceError, list, get, findExactDuplicate, findPossibleDuplicate, create, fund, reset };
