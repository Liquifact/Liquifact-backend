'use strict';

/**
 * In-memory append-only contributions store.
 * Seeded to match demo invoice funded amounts.
 */

const DEMO_INVESTOR = 'GB46PNGL3W2G66OWSPBQOWWJWMEKO34HBZDAYAIZOKNPAU7PAZW7QHEE';
const { parseAmount, formatAmount } = require('../lib/money');

const seed = () => [
  {
    id: 'CTB_0001',
    invoiceId: 'INV_0002',
    investor: DEMO_INVESTOR,
    amountMinor: parseAmount('18000'),
    createdAt: '2026-10-02T10:00:00.000Z',
  },
  {
    id: 'CTB_0002',
    invoiceId: 'INV_0003',
    investor: DEMO_INVESTOR,
    amountMinor: parseAmount('42000'),
    createdAt: '2026-09-16T12:00:00.000Z',
  },
  {
    id: 'CTB_0003',
    invoiceId: 'INV_0004',
    investor: DEMO_INVESTOR,
    amountMinor: parseAmount('12500'),
    createdAt: '2026-07-02T15:00:00.000Z',
  },
];

let contributions = seed();

function list() {
  return contributions;
}

function listByInvoice(invoiceId) {
  return contributions.filter((c) => c.invoiceId === invoiceId);
}

function listByInvestor(investor) {
  return contributions.filter((c) => c.investor === investor);
}

function sumForInvoice(invoiceId) {
  const sumMinor = contributions
    .filter((c) => c.invoiceId === invoiceId)
    .reduce((acc, c) => acc + c.amountMinor, 0n);
  return sumMinor;
}

function record({ invoiceId, investor, amountMinor }) {
  const id = `CTB_${String(contributions.length + 1).padStart(4, '0')}`;
  const item = {
    id,
    invoiceId,
    investor,
    amountMinor,
    createdAt: new Date().toISOString(),
  };
  contributions.push(item);
  return item;
}

function reset() {
  contributions = seed();
}

module.exports = {
  DEMO_INVESTOR,
  formatAmount,
  list,
  listByInvoice,
  listByInvestor,
  sumForInvoice,
  record,
  reset,
};
