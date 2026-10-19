'use strict';

/**
 * Invoice lifecycle, mirroring the escrow contract
 * (`status: 0 = open, 1 = funded, 2 = settled, 3 = withdrawn, 4 = cancelled`).
 * Every status change must go through `transition()`.
 */

const STATUSES = ['open', 'funded', 'withdrawn', 'settled', 'cancelled'];

const CONTRACT_STATUS_CODES = Object.freeze({
  open: 0,
  funded: 1,
  settled: 2,
  withdrawn: 3,
  cancelled: 4,
});

const TRANSITIONS = Object.freeze({
  open: Object.freeze(['funded', 'cancelled']),
  funded: Object.freeze(['withdrawn', 'settled']),
  withdrawn: Object.freeze(['settled']),
  settled: Object.freeze([]),
  cancelled: Object.freeze([]),
});

class InvalidTransitionError extends Error {
  /**
   * @param {string} from current status
   * @param {string} to requested status
   */
  constructor(from, to) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

/**
 * Moves an invoice to a new status and appends to its history.
 *
 * @param {object} invoice invoice to mutate
 * @param {string} to target status
 * @param {{ reason?: string, actor?: string, at?: string }} [meta] audit metadata
 * @returns {object} the updated invoice
 * @throws {InvalidTransitionError} if the transition is not allowed
 */
function transition(invoice, to, { reason, actor, at } = {}) {
  const from = invoice.status;
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
  const entry = { from, to, at: at || new Date().toISOString(), reason: reason === undefined ? null : reason };
  if (actor !== undefined) {
    entry.actor = actor;
  }
  if (!Array.isArray(invoice.history)) {
    invoice.history = [];
  }
  invoice.history.push(entry);
  invoice.status = to;
  return invoice;
}

module.exports = { STATUSES, CONTRACT_STATUS_CODES, TRANSITIONS, InvalidTransitionError, transition };
