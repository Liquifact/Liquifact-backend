'use strict';

/**
 * Minimal in-process event emitter for invoice lifecycle events.
 *
 * Uses Node's built-in EventEmitter. Errors thrown inside listeners are caught
 * and logged so they never propagate to callers.
 */

const { EventEmitter } = require('events');

const emitter = new EventEmitter();
// Prevent accidental memory leaks from test listener accumulation
emitter.setMaxListeners(50);

/**
 * Emits an invoice lifecycle event.
 *
 * @param {'invoice.created'|'invoice.funding_received'|'invoice.funded'} type
 * @param {object} invoice the invoice data
 */
function emit(type, invoice) {
  try {
    emitter.emit(type, invoice);
  } catch (err) {
    // Listeners must not crash the calling request
    console.error(`[webhook-emitter] error in listener for ${type}:`, err);
  }
}

/**
 * Registers a listener for an invoice event type.
 *
 * @param {string} type event name
 * @param {Function} listener
 */
function on(type, listener) {
  emitter.on(type, listener);
}

/**
 * Removes a listener (used in tests).
 *
 * @param {string} type
 * @param {Function} listener
 */
function off(type, listener) {
  emitter.off(type, listener);
}

/**
 * Removes all listeners for a type, or all listeners if no type given (used in tests).
 *
 * @param {string} [type]
 */
function removeAllListeners(type) {
  emitter.removeAllListeners(type);
}

module.exports = { emit, on, off, removeAllListeners };
