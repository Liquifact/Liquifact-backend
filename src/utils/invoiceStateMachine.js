/**
 * Invoice State Machine
 * 
 * Defines the allowed statuses and valid transitions for an invoice.
 * Enforces a strict, deterministic workflow.
 */

const ALLOWED_STATUSES = Object.freeze([
  'draft',
  'pending_verification',
  'approved',
  'funded',
  'settled',
  'closed'
]);

// Map of valid transitions where key = fromStatus, value = array of valid toStatus
const TRANSITIONS = Object.freeze({
  draft: ['pending_verification'],
  pending_verification: ['approved'],
  approved: ['funded'],
  funded: ['settled'],
  settled: ['closed'],
  closed: []
});

/**
 * Checks if a status transition is mathematically valid according to the state machine rules.
 * Does not throw an error; only returns boolean.
 *
 * @param {string} fromStatus - The current status of the invoice.
 * @param {string} toStatus - The desired next status.
 * @returns {boolean} True if transition is valid, false otherwise.
 */
function canTransition(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) {
    return false;
  }
  
  const validDestinations = TRANSITIONS[fromStatus];
  if (!validDestinations) {
    return false;
  }
  
  return validDestinations.includes(toStatus);
}

/**
 * Validates a status transition and throws an error if it is invalid.
 * Used as a transition guard in API routes.
 * 
 * @param {string} currentStatus - The current status of the invoice.
 * @param {string} nextStatus - The proposed next status.
 * @returns {boolean} True if the transition is allowed.
 * @throws {Error} If either status is invalid or the transition is not allowed.
 */
function validateStatusTransition(currentStatus, nextStatus) {
  if (!currentStatus || !nextStatus) {
    throw new Error('Both currentStatus and nextStatus are required for transition validation');
  }

  if (!ALLOWED_STATUSES.includes(currentStatus)) {
    throw new Error(`Invalid current status: ${currentStatus}`);
  }

  if (!ALLOWED_STATUSES.includes(nextStatus)) {
    throw new Error(`Invalid next status: ${nextStatus}`);
  }

  if (!canTransition(currentStatus, nextStatus)) {
    throw new Error(`Invalid status transition from ${currentStatus} to ${nextStatus}`);
  }

  return true;
}

module.exports = {
  ALLOWED_STATUSES,
  TRANSITIONS,
  canTransition,
  validateStatusTransition
};
