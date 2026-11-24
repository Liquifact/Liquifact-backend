'use strict';

/**
 * In-memory storage adapter for invoices and contributions.
 * Implements the standard storage repository interface.
 */

const assert = require('node:assert');
const { formatAmount, toMinorUnits, parseAmount } = require('../lib/money');
const config = require('../config');

const STATUSES = ['open', 'funded', 'settled', 'cancelled'];
const INVOICE_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const DEMO_INVESTOR = 'GB46PNGL3W2G66OWSPBQOWWJWMEKO34HBZDAYAIZOKNPAU7PAZW7QHEE';

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

function normalizeIdentity(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function compositeKey(parts) {
  return JSON.stringify(parts);
}

function exactKey(invoice) {
  const number = String(invoice.invoiceNumber ?? '').trim();
  return compositeKey([normalizeIdentity(invoice.sme), number]);
}

function fuzzyKey(invoice) {
  const amount = invoice.amountMinor !== undefined ? formatAmount(toMinorUnits(invoice.amountMinor)) : String(invoice.amount);
  return compositeKey([normalizeIdentity(invoice.sme), normalizeIdentity(invoice.debtor), amount, invoice.dueDate]);
}

function hasInvoiceNumber(invoice) {
  return typeof invoice.invoiceNumber === 'string' && invoice.invoiceNumber.trim().length > 0;
}

function isValidInvoiceId(id) {
  return typeof id === 'string' && INVOICE_ID_PATTERN.test(id);
}

function generateInvoiceId({ has = () => false } = {}) {
  for (let sequence = 1; sequence <= Number.MAX_SAFE_INTEGER; sequence += 1) {
    const id = `INV_${String(sequence).padStart(4, '0')}`;
    if (!has(id)) {
      return id;
    }
  }
  throw new Error('Unable to generate a unique invoice ID');
}

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

function minorOf(invoice) {
  return {
    amountMinor: invoice.amountMinor !== undefined ? invoice.amountMinor : toMinorUnits(invoice.amount),
    fundedAmountMinor: invoice.fundedAmountMinor !== undefined
      ? invoice.fundedAmountMinor
      : toMinorUnits(invoice.fundedAmount || 0),
  };
}

function remaining(invoice) {
  const { amountMinor, fundedAmountMinor } = minorOf(invoice);
  return amountMinor - fundedAmountMinor;
}

const seedInvoices = () => [
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

const seedContributions = () => [
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

class MemoryAdapter {
  constructor(options = {}) {
    this.filePath = options.filePath || null;
    this.invoices = [];
    this.contributions = [];
    this.invoicesById = new Map();
    this.exactIndex = new Map();
    this.fuzzyIndex = new Map();
    this.init();
  }

  init() {
    this.reset();
  }

  addToIndex(index, key, id) {
    const ids = index.get(key) || new Set();
    ids.add(id);
    index.set(key, ids);
  }

  indexInvoice(invoice) {
    this.invoicesById.set(invoice.id, invoice);
    if (!hasInvoiceNumber(invoice)) {
      return;
    }
    this.addToIndex(this.exactIndex, exactKey(invoice), invoice.id);
    this.addToIndex(this.fuzzyIndex, fuzzyKey(invoice), invoice.id);
  }

  rebuildIndexes() {
    this.invoicesById = new Map();
    this.exactIndex = new Map();
    this.fuzzyIndex = new Map();
    for (const invoice of this.invoices) {
      this.indexInvoice(invoice);
    }
  }

  findEligible(index, key) {
    const ids = index.get(key);
    if (!ids) {
      return undefined;
    }
    for (const id of ids) {
      const invoice = this.invoicesById.get(id);
      if (invoice && invoice.status !== 'cancelled') {
        return invoice;
      }
    }
    return undefined;
  }

  findExactDuplicate(invoice) {
    if (!hasInvoiceNumber(invoice)) {
      return undefined;
    }
    return this.findEligible(this.exactIndex, exactKey(invoice));
  }

  findPossibleDuplicate(invoice) {
    if (!hasInvoiceNumber(invoice)) {
      return undefined;
    }
    return this.findEligible(this.fuzzyIndex, fuzzyKey(invoice));
  }

  listInvoices() {
    return this.invoices;
  }

  getInvoice(id) {
    return this.invoicesById.get(id);
  }

  createInvoice(invoice) {
    const exact = this.findExactDuplicate(invoice);
    if (exact) {
      throw new DuplicateInvoiceError('DUPLICATE_INVOICE', exact.id);
    }
    const possible = this.findPossibleDuplicate(invoice);
    if (possible && invoice.confirmNotDuplicate !== true) {
      throw new DuplicateInvoiceError('POSSIBLE_DUPLICATE', possible.id);
    }
    const id = generateInvoiceId({ has: (candidate) => this.invoicesById.has(candidate) });
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
    this.invoices.push(record);
    this.indexInvoice(record);
    this.persist();
    return record;
  }

  fundInvoice(invoice, amount, investor) {
    const amountMinor = toMinorUnits(amount);
    if (!(amountMinor <= remaining(invoice))) {
      throw new Error('fund() called with amount exceeding remaining capacity');
    }
    assert(investor, 'investor address is required to fund an invoice');
    this.recordContribution({ invoiceId: invoice.id, investor, amountMinor });
    invoice.fundedAmountMinor = this.sumContributionsForInvoice(invoice.id);
    if (invoice.fundedAmountMinor >= invoice.amountMinor) {
      invoice.status = 'funded';
    }
    assert.strictEqual(
      invoice.fundedAmountMinor,
      this.sumContributionsForInvoice(invoice.id),
      `Invoice ${invoice.id} fundedAmount must equal contributions sum`,
    );
    this.persist();
    return invoice;
  }

  settleInvoice(invoice) {
    invoice.status = 'settled';
    this.persist();
    return invoice;
  }

  cancelInvoice(invoice) {
    invoice.status = 'cancelled';
    this.persist();
    return invoice;
  }

  linkEscrow(invoice, contractId) {
    if (invoice.escrowContractId && invoice.escrowContractId !== contractId) {
      return 'ALREADY_LINKED';
    }
    if (this.invoices.some((other) => other !== invoice && other.escrowContractId === contractId)) {
      return 'CONTRACT_IN_USE';
    }
    invoice.escrowContractId = contractId;
    this.persist();
    return null;
  }

  // ── Contributions ──────────────────────────────────────────────────────────

  listContributions() {
    return this.contributions;
  }

  listContributionsByInvoice(invoiceId) {
    return this.contributions.filter((c) => c.invoiceId === invoiceId);
  }

  listContributionsByInvestor(investor) {
    return this.contributions.filter((c) => c.investor === investor);
  }

  sumContributionsForInvoice(invoiceId) {
    return this.contributions
      .filter((c) => c.invoiceId === invoiceId)
      .reduce((acc, c) => acc + c.amountMinor, 0n);
  }

  recordContribution({ invoiceId, investor, amountMinor }) {
    const id = `CTB_${String(this.contributions.length + 1).padStart(4, '0')}`;
    const item = {
      id,
      invoiceId,
      investor,
      amountMinor,
      createdAt: new Date().toISOString(),
    };
    this.contributions.push(item);
    this.persist();
    return item;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  reset() {
    this.contributions = seedContributions();
    this.invoices = seedInvoices().map((record) => withDerivedOnChain(withMoney(record)));
    this.rebuildIndexes();
    this.persist();
  }

  persist() {
    // In-memory adapter does not need to serialize to disk
  }

  async flush() {
    return Promise.resolve();
  }
}

module.exports = {
  MemoryAdapter,
  STATUSES,
  DEMO_INVESTOR,
  DuplicateInvoiceError,
  normalizeIdentity,
  compositeKey,
  exactKey,
  fuzzyKey,
  hasInvoiceNumber,
  isValidInvoiceId,
  generateInvoiceId,
  withDerivedOnChain,
  withMoney,
  minorOf,
  remaining,
  seedInvoices,
  seedContributions,
};
