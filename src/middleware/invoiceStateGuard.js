const INVOICE_STATE_TRANSITIONS = require('../policies/invoiceStateMachine');

/**
 * Checks if a transition from currentStatus to nextStatus is valid.
 * @param {string} currentStatus - The current status
 * @param {string} nextStatus - The requested next status
 * @returns {boolean} True if valid, false otherwise
 */
const canTransition = (currentStatus, nextStatus) => {
  const allowedNextStates = INVOICE_STATE_TRANSITIONS[currentStatus];
  if (!allowedNextStates) return false;
  return allowedNextStates.includes(nextStatus);
};

/**
 * Express middleware to guard invoice state transitions.
 * Expects `currentStatus` and `nextStatus` in the request body.
 * @returns {import('express').RequestHandler}
 */
const invoiceStateGuard = () => {
  return (req, res, next) => {
    const { currentStatus, nextStatus } = req.body;
    
    if (!currentStatus || !nextStatus) {
      return res.status(400).json({ error: 'currentStatus and nextStatus are required' });
    }
    
    if (!canTransition(currentStatus, nextStatus)) {
      return res.status(400).json({ error: `Invalid transition from ${currentStatus} to ${nextStatus}` });
    }
    
    next();
  };
};

module.exports = { canTransition, invoiceStateGuard };
