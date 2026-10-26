'use strict';

const assert = require('node:assert');
const contributions = require('./contributions');
const { STATUSES } = require('./statuses');
const { demoInvoices } = require('./seed-invoices');
const { generateInvoiceId } = require('./ids');
const { RepoError } = require('./errors');
const { subMoney, compareMoney, moneyToNumber } = require('./money');

/**
 * Deep-copies an invoice so callers never receive live internal references.
 *
 * @param {object} invoice invoice record
 * @returns {object} copy
 */
function copyInvoice(invoice) {
  return structuredClone(invoice);
}

/**
 * In-memory invoice repository (default for tests and zero-config demo).
 *
 * @returns {import('./repository').InvoiceRepository}
 */
function createMemoryRepository() {
  /** @type {object[]} */
  let invoices = demoInvoices().map(copyInvoice);

  for (const inv of invoices) {
    assert.strictEqual(
      moneyToNumber(inv.fundedAmount),
      contributions.sumForInvoice(inv.id),
      `Invoice ${inv.id} fundedAmount must equal contributions sum`,
    );
  }

  function listSync(filter = {}) {
    let rows = invoices.map(copyInvoice);
    if (filter.status) {
      rows = rows.filter((i) => i.status === filter.status);
    }
    return rows;
  }

  function getSync(id) {
    const found = invoices.find((i) => i.id === id);
    return found ? copyInvoice(found) : undefined;
  }

  function createSync(input) {
    const record = {
      id: generateInvoiceId(),
      fundedAmount: 0,
      status: 'open',
      onChain: false,
      createdAt: new Date().toISOString(),
      ...input,
    };
    invoices.push(record);
    return copyInvoice(record);
  }

  function fundSync(id, amount, investor) {
    if (!investor) {
      throw new RepoError('INVESTOR_REQUIRED', 'investor address is required to fund an invoice', 400);
    }
    const invoice = invoices.find((i) => i.id === id);
    if (!invoice) {
      throw new RepoError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
    }
    if (invoice.status !== 'open') {
      throw new RepoError(
        'INVOICE_NOT_OPEN',
        `Invoice is ${invoice.status}; only open invoices can be funded`,
        409,
      );
    }
    const remaining = subMoney(invoice.amount, invoice.fundedAmount);
    if (compareMoney(amount, remaining) > 0) {
      throw new RepoError('EXCEEDS_CAPACITY', 'Contribution exceeds remaining capacity', 422);
    }
    contributions.record({ invoiceId: invoice.id, investor, amount });
    invoice.fundedAmount = contributions.sumForInvoice(invoice.id);
    if (compareMoney(invoice.fundedAmount, invoice.amount) >= 0) {
      invoice.status = 'funded';
    }
    assert.strictEqual(
      moneyToNumber(invoice.fundedAmount),
      contributions.sumForInvoice(invoice.id),
      `Invoice ${invoice.id} fundedAmount must equal contributions sum`,
    );
    return copyInvoice(invoice);
  }

  function setStatusSync(id, status) {
    if (!STATUSES.includes(status)) {
      throw new RepoError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`, 400);
    }
    const invoice = invoices.find((i) => i.id === id);
    if (!invoice) {
      throw new RepoError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
    }
    invoice.status = status;
    return copyInvoice(invoice);
  }

  function resetSync() {
    contributions.reset();
    invoices = demoInvoices().map(copyInvoice);
  }

  return {
    STATUSES,
    async list(filter) {
      return listSync(filter);
    },
    async get(id) {
      return getSync(id);
    },
    async create(input) {
      return createSync(input);
    },
    async fund(id, amount, investor) {
      return fundSync(id, amount, investor);
    },
    async setStatus(id, status) {
      return setStatusSync(id, status);
    },
    async reset() {
      resetSync();
    },
  };
}

module.exports = { createMemoryRepository };
