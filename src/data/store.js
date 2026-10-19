'use strict';

/**
 * In-memory data store seeded with demo invoices. Serverless instances are
 * stateless, so writes live for the lifetime of a warm instance only; this is
 * intentional for the public demo (no database required).
 */

const crypto = require('crypto');
const { StrKey } = require('@stellar/stellar-sdk');

const STATUSES = ['open', 'funded', 'settled', 'cancelled'];

/**
 * Deterministic demo public key (G...) derived from a label. Only the public
 * key is ever produced; no secret exists for these demo accounts.
 *
 * @param {string} label demo account label
 * @returns {string} valid ed25519 public key StrKey
 */
const demoAddress = (label) =>
  StrKey.encodeEd25519PublicKey(crypto.createHash('sha256').update(`liquifact-demo:${label}`).digest());

const seed = () => [
  {
    id: 'INV_0001',
    sme: 'Acme Components Ltd',
    smeAddress: demoAddress('acme'),
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
    smeAddress: demoAddress('northwind'),
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
    smeAddress: demoAddress('blue-harbor'),
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
    smeAddress: demoAddress('sunrise'),
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
 * Records an investor contribution against an open invoice.
 *
 * @param {object} invoice target invoice
 * @param {number} amount contribution amount
 * @returns {object} updated invoice
 */
function fund(invoice, amount) {
  invoice.fundedAmount = Math.min(invoice.amount, invoice.fundedAmount + amount);
  if (invoice.fundedAmount >= invoice.amount) {
    invoice.status = 'funded';
  }
  return invoice;
}

/** Restores the seed data (used by tests). */
function reset() {
  invoices = seed();
}

module.exports = { STATUSES, list, get, create, fund, reset };
