'use strict';

/**
 * In-memory append-only contributions store.
 * Seeded to match demo invoice funded amounts.
 */

const DEMO_INVESTOR = 'GB46PNGL3W2G66OWSPBQOWWJWMEKO34HBZDAYAIZOKNPAU7PAZW7QHEE';

const seed = () => [
  {
    id: 'CTB_0001',
    invoiceId: 'INV_0002',
    investor: DEMO_INVESTOR,
    amount: 18000,
    createdAt: '2026-10-02T10:00:00.000Z',
  },
  {
    id: 'CTB_0002',
    invoiceId: 'INV_0003',
    investor: DEMO_INVESTOR,
    amount: 42000,
    createdAt: '2026-09-16T12:00:00.000Z',
  },
  {
    id: 'CTB_0003',
    invoiceId: 'INV_0004',
    investor: DEMO_INVESTOR,
    amount: 12500,
    createdAt: '2026-07-02T15:00:00.000Z',
  },
];

let contributions = seed();

function toMinor(amount) {
  if (typeof amount === 'bigint') {
    return amount;
  }
  const num = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(num)) {
    throw new TypeError('amount must be a finite number');
  }
  const str = num.toFixed(7);
  const isNegative = str.startsWith('-');
  const [whole, frac = ''] = (isNegative ? str.slice(1) : str).split('.');
  const wholeBigInt = BigInt(whole);
  const fracBigInt = BigInt(frac.slice(0, 7));
  const minor = wholeBigInt * 10000000n + fracBigInt;
  return isNegative ? -minor : minor;
}

function fromMinor(minorBigInt) {
  return Number(minorBigInt) / 10000000;
}

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
    .reduce((acc, c) => acc + toMinor(c.amount), 0n);
  return fromMinor(sumMinor);
}

function record({ invoiceId, investor, amount }) {
  const id = `CTB_${String(contributions.length + 1).padStart(4, '0')}`;
  const item = {
    id,
    invoiceId,
    investor,
    amount,
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
  toMinor,
  fromMinor,
  list,
  listByInvoice,
  listByInvestor,
  sumForInvoice,
  record,
  reset,
};
