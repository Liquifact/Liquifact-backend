'use strict';

const knexLib = require('knex');
const pg = require('pg');
const contributions = require('./contributions');
const { STATUSES } = require('./statuses');
const { demoInvoices } = require('./seed-invoices');
const { generateInvoiceId } = require('./ids');
const { RepoError, isDbUnavailable } = require('./errors');
const { addMoney, subMoney, compareMoney, moneyToNumber } = require('./money');
const { buildKnexConfig } = require('../../knexfile');

// Keep DATE and NUMERIC as strings (never parseFloat / timezone-shifted Dates).
pg.types.setTypeParser(1082, (value) => value); // date
pg.types.setTypeParser(1700, (value) => value); // numeric


/**
 * @param {object} row DB row
 * @returns {object} API invoice shape
 */
function mapRow(row) {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  let dueDate = row.due_date;
  if (dueDate instanceof Date) {
    dueDate = dueDate.toISOString().slice(0, 10);
  } else if (typeof dueDate === 'string' && dueDate.includes('T')) {
    dueDate = dueDate.slice(0, 10);
  }
  return {
    id: row.id,
    sme: row.sme,
    smeAddress: row.sme_address,
    debtor: row.debtor,
    amount: moneyToNumber(row.amount),
    currency: row.currency,
    fundedAmount: moneyToNumber(row.funded_amount),
    yieldBps: row.yield_bps,
    dueDate,
    status: row.status,
    onChain: row.on_chain,
    createdAt,
  };
}

/**
 * @param {object} invoice API invoice
 * @returns {object} DB insert row
 */
function toDbRow(invoice) {
  return {
    id: invoice.id,
    sme: invoice.sme,
    sme_address: invoice.smeAddress ?? null,
    debtor: invoice.debtor,
    amount: String(invoice.amount),
    funded_amount: String(invoice.fundedAmount ?? 0),
    currency: invoice.currency,
    yield_bps: invoice.yieldBps,
    due_date: invoice.dueDate,
    status: invoice.status,
    on_chain: Boolean(invoice.onChain),
    created_at: invoice.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Wraps a knex call so connectivity failures become RepoError DB_UNAVAILABLE.
 *
 * @template T
 * @param {() => Promise<T>} fn async work
 * @returns {Promise<T>}
 */
async function withDb(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RepoError) {
      throw err;
    }
    if (isDbUnavailable(err)) {
      throw new RepoError('DB_UNAVAILABLE', 'Database unavailable', 503);
    }
    throw err;
  }
}

/**
 * @param {string} databaseUrl Postgres connection string
 * @returns {import('./repository').InvoiceRepository & { knex: import('knex').Knex, destroy: () => Promise<void> }}
 */
function createPgRepository(databaseUrl) {
  const knex = knexLib(buildKnexConfig(databaseUrl));

  const repo = {
    STATUSES,
    knex,

    async list(filter = {}) {
      return withDb(async () => {
        let query = knex('invoices').select('*').orderBy('created_at', 'asc');
        if (filter.status) {
          query = query.where('status', filter.status);
        }
        const rows = await query;
        return rows.map(mapRow);
      });
    },

    async get(id) {
      return withDb(async () => {
        const row = await knex('invoices').where({ id }).first();
        return row ? mapRow(row) : undefined;
      });
    },

    async create(input) {
      return withDb(async () => {
        const record = {
          id: generateInvoiceId(),
          fundedAmount: 0,
          status: 'open',
          onChain: false,
          createdAt: new Date().toISOString(),
          ...input,
        };
        await knex('invoices').insert(toDbRow(record));
        const row = await knex('invoices').where({ id: record.id }).first();
        return mapRow(row);
      });
    },

    async fund(id, amount, investor) {
      if (!investor) {
        throw new RepoError('INVESTOR_REQUIRED', 'investor address is required to fund an invoice', 400);
      }
      return withDb(async () => knex.transaction(async (trx) => {
        const row = await trx('invoices').where({ id }).forUpdate().first();
        if (!row) {
          throw new RepoError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
        }
        if (row.status !== 'open') {
          throw new RepoError(
            'INVOICE_NOT_OPEN',
            `Invoice is ${row.status}; only open invoices can be funded`,
            409,
          );
        }
        const remaining = subMoney(row.amount, row.funded_amount);
        if (compareMoney(amount, remaining) > 0) {
          throw new RepoError('EXCEEDS_CAPACITY', 'Contribution exceeds remaining capacity', 422);
        }
        const newFunded = addMoney(row.funded_amount, amount);
        const newStatus = compareMoney(newFunded, row.amount) >= 0 ? 'funded' : 'open';
        await trx('invoices').where({ id }).update({
          funded_amount: newFunded,
          status: newStatus,
          updated_at: trx.fn.now(),
        });
        contributions.record({ invoiceId: id, investor, amount: moneyToNumber(amount) });
        const updated = await trx('invoices').where({ id }).first();
        return mapRow(updated);
      }));
    },

    async setStatus(id, status) {
      if (!STATUSES.includes(status)) {
        throw new RepoError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`, 400);
      }
      return withDb(async () => {
        const updated = await knex('invoices').where({ id }).update({
          status,
          updated_at: knex.fn.now(),
        });
        if (!updated) {
          throw new RepoError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
        }
        const row = await knex('invoices').where({ id }).first();
        return mapRow(row);
      });
    },

    async reset() {
      return withDb(async () => {
        contributions.reset();
        await knex('invoices').del();
        const rows = demoInvoices().map(toDbRow);
        if (rows.length) {
          await knex('invoices').insert(rows);
        }
      });
    },

    async destroy() {
      await knex.destroy();
    },
  };

  return repo;
}

module.exports = { createPgRepository, mapRow, toDbRow };
