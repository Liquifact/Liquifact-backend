'use strict';

const { demoInvoices } = require('../src/data/seed-invoices');
const { toDbRow } = require('../src/data/pg-repository');

/**
 * @param {import('knex').Knex} knex
 */
exports.seed = async function seed(knex) {
  await knex('invoices').del();
  await knex('invoices').insert(demoInvoices().map(toDbRow));
};
