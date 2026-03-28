/**
 * @fileoverview Circuit Breaker pattern implementation to protect against cascading failures
 * caused by unstable external dependencies.
 *
 * @module utils/circuitBreaker
 */

/**
 * Valid states for the Circuit Breaker.
 * @enum {string}
 */
const CircuitBreakerState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

/**
 * Circuit Breaker class implementing the standard state transitions:
 * CLOSED -> OPEN (on failures)
 * OPEN -> HALF_OPEN (after timeout)
 * HALF_OPEN -> CLOSED (on success) or HALF_OPEN -> OPEN (on failure)
 */
class CircuitBreaker {
  /**
   * Creates a new Circuit Breaker.
   * @param {Object} [options={}] - Configuration options for the Circuit Breaker.
   * @param {number} [options.failureThreshold=5] - Number of failures before state changes to OPEN.
   * @param {number} [options.recoveryTimeout=10000] - Time in ms before state changes from OPEN to HALF_OPEN.
   * @param {Function} [options.fallbackLogic=null] - Optional fallback function executed when circuit is OPEN.
   */
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.recoveryTimeout = options.recoveryTimeout || 10000;
    this.fallbackLogic = options.fallbackLogic || null;

    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.nextAttemptTime = Date.now();
  }

  /**
   * Executes the given operation within the circuit breaker context.
   * @param {Function} operation - The async operation to execute.
   * @returns {Promise<any>} Resolves with the operation's result or the fallback logic result.
   * @throws {Error} If the circuit is OPEN and no fallback is provided, or if the operation fails.
   */
  async execute(operation) {
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() >= this.nextAttemptTime) {
        // Time has elapsed, transition to HALF_OPEN to test the resource.
        this.state = CircuitBreakerState.HALF_OPEN;
      } else {
        // Circuit is still OPEN. Fail fast or use fallback.
        if (this.fallbackLogic) {
          return this.fallbackLogic();
        }
        throw new Error('Circuit Breaker is OPEN. Operation failed fast.');
      }
    }

    try {
      const response = await operation();
      return this.onSuccess(response);
    } catch (error) {
      return this.onFailure(error);
    }
  }

  /**
   * Handles a successful operation, resetting failure count.
   * If state was HALF_OPEN, transitions to CLOSED.
   * @param {any} response - The successful response.
   * @returns {any} The identical response.
   */
  onSuccess(response) {
    this.failureCount = 0;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.CLOSED;
    }
    return response;
  }

  /**
   * Handles a failed operation. Increments failure count.
   * Transitions to OPEN if threshold is reached or if already HALF_OPEN.
   * @param {Error} error - The error that caused the failure.
   * @returns {any} Returns fallback if implemented.
   * @throws {Error} Re-throws the error if no fallback is available.
   */
  onFailure(error) {
    this.failureCount += 1;

    if (this.state === CircuitBreakerState.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
      this.nextAttemptTime = Date.now() + this.recoveryTimeout;
    }

    if (this.state === CircuitBreakerState.OPEN && this.fallbackLogic) {
      return this.fallbackLogic(error);
    }

    throw error;
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerState
};
