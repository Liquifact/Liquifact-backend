'use strict';

/**
 * Contributions store module.
 * Delegates to the active storage repository adapter.
 */

const { getAdapter } = require('./adapter-registry');
const { formatAmount } = require('../lib/money');
const { DEMO_INVESTOR } = require('./memory-adapter');

function list() {
  return getAdapter().listContributions();
}

function listByInvoice(invoiceId) {
  return getAdapter().listContributionsByInvoice(invoiceId);
}

function listByInvestor(investor) {
  return getAdapter().listContributionsByInvestor(investor);
}

function sumForInvoice(invoiceId) {
  return getAdapter().sumContributionsForInvoice(invoiceId);
}

function record({ invoiceId, investor, amountMinor }) {
  return getAdapter().recordContribution({ invoiceId, investor, amountMinor });
}

function reset() {
  // Resetting adapter resets both invoices and contributions
  getAdapter().reset();
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
