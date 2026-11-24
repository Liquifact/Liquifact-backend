'use strict';

/**
 * Data store facade.
 * Delegates storage operations to the active repository adapter (MemoryAdapter or JsonFileAdapter).
 */

const { getAdapter, setAdapter, resetAdapter } = require('./adapter-registry');
const {
  STATUSES,
  DuplicateInvoiceError,
  normalizeIdentity,
  compositeKey,
  exactKey,
  fuzzyKey,
  isValidInvoiceId,
  generateInvoiceId,
  minorOf,
  remaining,
} = require('./memory-adapter');

function list() {
  return getAdapter().listInvoices();
}

function get(id) {
  return getAdapter().getInvoice(id);
}

function create(invoice) {
  return getAdapter().createInvoice(invoice);
}

function fund(invoice, amount, investor) {
  return getAdapter().fundInvoice(invoice, amount, investor);
}

function settle(invoice) {
  return getAdapter().settleInvoice(invoice);
}

function cancel(invoice) {
  return getAdapter().cancelInvoice(invoice);
}

function linkEscrow(invoice, contractId) {
  return getAdapter().linkEscrow(invoice, contractId);
}

function findExactDuplicate(invoice) {
  return getAdapter().findExactDuplicate(invoice);
}

function findPossibleDuplicate(invoice) {
  return getAdapter().findPossibleDuplicate(invoice);
}

function reset() {
  getAdapter().reset();
}

function flush() {
  return getAdapter().flush();
}

module.exports = {
  STATUSES,
  normalizeIdentity,
  compositeKey,
  exactKey,
  fuzzyKey,
  isValidInvoiceId,
  generateInvoiceId,
  DuplicateInvoiceError,
  list,
  get,
  findExactDuplicate,
  findPossibleDuplicate,
  create,
  fund,
  remaining,
  minorOf,
  settle,
  cancel,
  linkEscrow,
  reset,
  flush,
  getAdapter,
  setAdapter,
  resetAdapter,
};
