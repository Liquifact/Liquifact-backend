'use strict';

/**
 * In-memory data store seeded with demo invoices. Serverless instances are
 * stateless, so writes live for the lifetime of a warm instance only; this is
 * intentional for the public demo (no database required).
 */

const assert = require('node:assert');
const contributions = require('./contributions');

const STATUSES = ['open', 'funded', 'settled', 'cancelled'];

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

let invoices = seed();

/** @returns {object[]} all invoices */
function list() {
  return invoices;
}

/**
 * @param {string} id invoice id
 * @returns {object|undefined} the invoice
 */
function get(id) {
  return invoices.find((i) => i.id === id);
}

/**
 * @param {object} invoice validated invoice fields
 * @returns {object} the stored invoice
 */
function create(invoice) {
  const id = `INV_${String(invoices.length + 1).padStart(4, '0')}`;
  const record = {
    id,
    fundedAmount: 0,
    status: 'open',
    onChain: false,
    createdAt: new Date().toISOString(),
    ...invoice,
  };
  invoices.push(record);
  return record;
}

/**
 * Remaining funding capacity for an invoice.
 *
 * @param {object} invoice target invoice
 * @returns {number} amount that can still be contributed
 */
function remaining(invoice) {
  return invoice.amount - invoice.fundedAmount;
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
  if (!(amount <= remaining(invoice))) {
    throw new Error('fund() called with amount exceeding remaining capacity');
  }
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

/** Restores the seed data (used by tests). */
function reset() {
  contributions.reset();
  invoices = seed();
}

module.exports = { STATUSES, list, get, create, fund, remaining, reset };