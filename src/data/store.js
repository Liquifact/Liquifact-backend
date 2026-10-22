'use strict';

/**
 * In-memory data store seeded with demo invoices. Serverless instances are
 * stateless, so writes live for the lifetime of a warm instance only; this is
 * intentional for the public demo (no database required).
 */

const assert = require('node:assert');
const contributions = require('./contributions');
const { parseAmount } = require('../lib/money');

const STATUSES = ['open', 'funded', 'settled', 'cancelled'];

const seed = () => {
  const records = [
  {
    id: 'INV_0001',
    sme: 'Acme Components Ltd',
    smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
    debtor: 'Globex Retail',
    amountMinor: parseAmount('100'),
    currency: 'XLM',
    fundedAmountMinor: 0n,
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
    amountMinor: parseAmount('25000'),
    currency: 'USDC',
    fundedAmountMinor: parseAmount('18000'),
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
    amountMinor: parseAmount('42000'),
    currency: 'USDC',
    fundedAmountMinor: parseAmount('42000'),
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
    amountMinor: parseAmount('12500'),
    currency: 'USDC',
    fundedAmountMinor: parseAmount('12500'),
    yieldBps: 900,
    dueDate: '2026-09-30',
    status: 'settled',
    onChain: false,
    createdAt: '2026-07-01T08:00:00.000Z',
  },
  ];
  for (const inv of records) {
    assert.strictEqual(
      inv.fundedAmountMinor,
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
    fundedAmountMinor: 0n,
    status: 'open',
    onChain: false,
    createdAt: new Date().toISOString(),
    ...invoice,
  };
  invoices.push(record);
  return record;
}

/**
 * Records an investor contribution against an open invoice.
 *
 * @param {object} invoice target invoice
 * @param {bigint} amountMinor contribution in minor units
 * @param {string} investor investor Stellar address
 * @returns {object} updated invoice
 */
function fund(invoice, amountMinor, investor) {
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

/** Restores the seed data (used by tests). */
function reset() {
  contributions.reset();
  invoices = seed();
}

module.exports = { STATUSES, list, get, create, fund, reset };
