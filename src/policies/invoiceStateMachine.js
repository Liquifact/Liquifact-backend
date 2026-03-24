/**
 * Defines the valid state transitions for an invoice.
 */
const INVOICE_STATE_TRANSITIONS = {
  draft: ['pending_verification'],
  pending_verification: ['approved', 'draft'],
  approved: ['funded'],
  funded: ['settled'],
  settled: ['closed'],
  closed: []
};

module.exports = INVOICE_STATE_TRANSITIONS;
