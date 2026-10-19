'use strict';

const knexFactory = require('knex');
const pg = require('pg');
const knexfile = require('../../knexfile');
const { RepoError, planFunding, notFound } = require('./repository');
const { toUnits, fromUnits } = require('./money');
const { newInvoiceId } = require('./ids');
const { seed } = require('./seed');

// DATE columns come back as 'YYYY-MM-DD' strings instead of local-time Dates.
pg.types.setTypeParser(1082, (v) => v);

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

/**
 * @param {Error} err thrown error
 * @returns {boolean} whether it means the database cannot be reached
 */
function isConnectionError(err) {
  return Boolean(
    err &&
      (CONNECTION_CODES.has(err.code) ||
        err.name === 'KnexTimeoutError' ||
        /Connection terminated|timeout acquiring a connection/i.test(err.message || '')),
  );
}

/**
 * Runs a repository operation and maps connectivity failures to DB_UNAVAILABLE.
 * The message is fixed so the connection string can never leak.
 *
 * @param {Function} fn operation
 * @returns {Promise<*>} its result
 */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RepoError) {
      throw err;
    }
    if (isConnectionError(err) || (err && err.errors && err.errors.some(isConnectionError))) {
      throw new RepoError('DB_UNAVAILABLE', 'Database unavailable', 503);
    }
    throw err;
  }
}

/**
 * @param {object} row DB row
 * @returns {object} API invoice
 */
function toInvoice(row) {
  return {
    id: row.id,
    sme: row.sme,
    smeAddress: row.sme_address,
    debtor: row.debtor,
    amount: fromUnits(toUnits(row.amount)),
    currency: row.currency,
    fundedAmount: fromUnits(toUnits(row.funded_amount)),
    yieldBps: row.yield_bps,
    dueDate: row.due_date,
    status: row.status,
    onChain: row.on_chain,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Inserts the demo invoices (idempotent); used by `db:seed` and reset().
 *
 * @param {import('knex').Knex} db knex or transaction
 * @returns {Promise<void>}
 */
async function seedInvoices(db) {
  const rows = seed().map((s) => ({
    id: s.id,
    sme: s.sme,
    sme_address: s.smeAddress,
    debtor: s.debtor,
    amount: s.amount,
    funded_amount: s.fundedAmount,
    currency: s.currency,
    yield_bps: s.yieldBps,
    due_date: s.dueDate,
    status: s.status,
    on_chain: s.onChain,
    created_at: s.createdAt,
  }));
  await db('invoices').insert(rows).onConflict('id').ignore();
}

/**
 * Postgres repository. Connects lazily on first query.
 *
 * @param {{ connectionString: string }} options connection options
 * @returns {object} repository (with `knex` and `destroy()` for tests/shutdown)
 */
function createPgRepository({ connectionString }) {
  const knex = knexFactory({
    ...knexfile,
    connection: { ...knexfile.connection, connectionString },
  });

  return {
    knex,

    list: (filter = {}) =>
      guarded(async () => {
        const q = knex('invoices').select('*').orderBy([
          { column: 'created_at', order: 'desc' },
          { column: 'id', order: 'asc' },
        ]);
        if (filter.status) {
          q.where({ status: filter.status });
        }
        return (await q).map(toInvoice);
      }),

    get: (id) =>
      guarded(async () => {
        const row = await knex('invoices').where({ id }).first();
        return row ? toInvoice(row) : null;
      }),

    create: (input) =>
      guarded(async () => {
        const [row] = await knex('invoices')
          .insert({
            id: newInvoiceId(),
            sme: input.sme,
            sme_address: input.smeAddress === undefined ? null : input.smeAddress,
            debtor: input.debtor,
            amount: fromUnits(toUnits(input.amount)),
            currency: input.currency,
            yield_bps: input.yieldBps,
            due_date: input.dueDate,
          })
          .returning('*');
        return toInvoice(row);
      }),

    fund: (id, amount) =>
      guarded(async () => {
        const contribution = toUnits(amount);
        return knex.transaction(async (trx) => {
          const row = await trx('invoices').where({ id }).forUpdate().first();
          if (!row) {
            throw notFound();
          }
          const next = planFunding(
            { status: row.status, amountUnits: toUnits(row.amount), fundedUnits: toUnits(row.funded_amount) },
            contribution,
          );
          const [updated] = await trx('invoices')
            .where({ id })
            .update({
              funded_amount: fromUnits(next.fundedUnits),
              status: next.status,
              updated_at: knex.fn.now(),
            })
            .returning('*');
          return toInvoice(updated);
        });
      }),

    reset: () =>
      guarded(() =>
        knex.transaction(async (trx) => {
          await trx('invoices').del();
          await seedInvoices(trx);
        }),
      ),

    destroy: () => knex.destroy(),
  };
}

module.exports = { createPgRepository, seedInvoices };
