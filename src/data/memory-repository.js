'use strict';

const { planFunding, notFound } = require('./repository');
const { toUnits, fromUnits } = require('./money');
const { newInvoiceId } = require('./ids');
const { seed } = require('./seed');

/**
 * @param {object} rec stored record
 * @returns {object} public copy (never the internal object)
 */
function toPublic(rec) {
  return {
    id: rec.id,
    sme: rec.sme,
    smeAddress: rec.smeAddress,
    debtor: rec.debtor,
    amount: fromUnits(rec.amountUnits),
    currency: rec.currency,
    fundedAmount: fromUnits(rec.fundedUnits),
    yieldBps: rec.yieldBps,
    dueDate: rec.dueDate,
    status: rec.status,
    onChain: rec.onChain,
    createdAt: rec.createdAt,
  };
}

const fromSeed = () =>
  seed().map((s) => ({ ...s, amountUnits: toUnits(s.amount), fundedUnits: toUnits(s.fundedAmount) }));

/**
 * In-memory repository (default; used by tests and the zero-config demo).
 *
 * @returns {object} repository
 */
function createMemoryRepository() {
  let invoices = fromSeed();

  return {
    async list(filter = {}) {
      const rows = filter.status ? invoices.filter((i) => i.status === filter.status) : invoices;
      return rows
        .map(toPublic)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    },

    async get(id) {
      const rec = invoices.find((i) => i.id === id);
      return rec ? toPublic(rec) : null;
    },

    async create(input) {
      const rec = {
        id: newInvoiceId(),
        sme: input.sme,
        smeAddress: input.smeAddress === undefined ? null : input.smeAddress,
        debtor: input.debtor,
        amountUnits: toUnits(input.amount),
        currency: input.currency,
        fundedUnits: 0n,
        yieldBps: input.yieldBps,
        dueDate: input.dueDate,
        status: 'open',
        onChain: false,
        createdAt: new Date().toISOString(),
      };
      invoices.push(rec);
      return toPublic(rec);
    },

    async fund(id, amount) {
      const contribution = toUnits(amount);
      const rec = invoices.find((i) => i.id === id);
      if (!rec) {
        throw notFound();
      }
      const next = planFunding(rec, contribution);
      rec.fundedUnits = next.fundedUnits;
      rec.status = next.status;
      return toPublic(rec);
    },

    async reset() {
      invoices = fromSeed();
    },
  };
}

module.exports = { createMemoryRepository };
