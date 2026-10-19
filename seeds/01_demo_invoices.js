'use strict';

const { seedInvoices } = require('../src/data/pg-repository');

exports.seed = (knex) => seedInvoices(knex);
