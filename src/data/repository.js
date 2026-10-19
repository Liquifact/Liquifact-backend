'use strict';

/**
 * Invoice repository contract. Every implementation exposes the same async API
 * and returns plain copies (never internal references):
 *
 *   list(filter)       -> Promise<Invoice[]>   filter: { status? }
 *   get(id)            -> Promise<Invoice|null>
 *   create(input)      -> Promise<Invoice>
 *   fund(id, amount)   -> Promise<Invoice>     throws RepoError on failure
 *   reset()            -> Promise<void>        restore the demo seed (tests)
 *
 * Money (`amount`, `fundedAmount`) is a canonical decimal string, e.g. "100.5".
 */

const STATUSES = ['open', 'funded', 'settled', 'cancelled'];

/** Error carrying an HTTP status and a stable machine-readable code. */
class RepoError extends Error {
  /**
   * @param {string} code stable error code
   * @param {string} message human readable message
   * @param {number} status HTTP status the API should answer with
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Decides the outcome of a contribution; shared so every backend enforces the
 * same rules.
 *
 * @param {{ status: string, amountUnits: bigint, fundedUnits: bigint }} state current invoice state
 * @param {bigint} contributionUnits contribution in minor units
 * @returns {{ fundedUnits: bigint, status: string }} next state
 */
function planFunding(state, contributionUnits) {
  if (state.status !== 'open') {
    throw new RepoError(
      'INVOICE_NOT_OPEN',
      `Invoice is ${state.status}; only open invoices can be funded`,
      409,
    );
  }
  const next = state.fundedUnits + contributionUnits;
  if (next > state.amountUnits) {
    throw new RepoError('OVERFUNDED', 'Contribution exceeds the remaining amount', 409);
  }
  return { fundedUnits: next, status: next === state.amountUnits ? 'funded' : 'open' };
}

const notFound = () => new RepoError('NOT_FOUND', 'Invoice not found', 404);

module.exports = { STATUSES, RepoError, planFunding, notFound };
