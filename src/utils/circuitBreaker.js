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

/** @type {Object|null} Metrics module reference — lazily loaded so the breaker works without prom-client. */
let metricsModule = null;

/**
 * Returns the metrics module, attempting to load it only once.
 * This allows the breaker to work in environments where prom-client/metrics are
 * unavailable (test shim path) without throwing at require time.
 *
 * @returns {Object|null} The metrics module exports or null.
 */
function getMetrics() {
  if (metricsModule === null) {
    try {
      metricsModule = require('../metrics');
    } catch (_e) {
      metricsModule = false;
    }
  }
  return metricsModule || null;
}

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
   * @param {string} [options.name='default'] - Unique breaker name for metrics labels (e.g. 'soroban', 'redis', 'kyc').
   * @param {number} [options.failureThreshold=5] - Number of failures before state changes to OPEN.
   * @param {number} [options.recoveryTimeout=10000] - Time in ms before state changes from OPEN to HALF_OPEN.
   * @param {Function} [options.fallbackLogic=null] - Optional fallback function executed when circuit is OPEN.
   * @param {Function} [options.onStateChange=null] - Optional callback triggered on state transitions `(oldState, newState)`.
   */
  constructor(options = {}) {
    /** @type {string} */
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 5;
    this.recoveryTimeout = options.recoveryTimeout || 10000;
    this.fallbackLogic = options.fallbackLogic || null;
    this.onStateChange = options.onStateChange || null;

    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.nextAttemptTime = Date.now();
  }

  /**
   * Updates the internal state, fires the onStateChange callback (if provided),
   * and emits a Prometheus counter metric for observability.
   *
   * The metric is labeled with the breaker's `name` and the `newState` so that
   * operators can distinguish transitions per dependency (Soroban, Redis, KYC).
   *
   * @param {string} newState - The new state to transition to.
   * @returns {void}
   */
  _transitionState(newState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      if (typeof this.onStateChange === 'function') {
        this.onStateChange(oldState, newState);
      }
      const metrics = getMetrics();
      if (metrics && metrics.sorobanCircuitBreakerStateTransitionsTotal) {
        metrics.sorobanCircuitBreakerStateTransitionsTotal.labels(this.name, oldState, newState).inc();
      }
    }
  }

  /**
   * Forces the breaker back to the CLOSED state and resets the failure count.
   *
   * Use this after a known dependency fix has been deployed — operators can call
   * reset() instead of waiting for the recovery timeout. This method does not
   * clear `nextAttemptTime` (it is set optimistically so the next `execute()` call
   * will proceed immediately when the state is CLOSED).
   *
   * @returns {void}
   *
   * @example
   * breaker.reset();
   * console.log(breaker.state); // 'CLOSED'
   * console.log(breaker.failureCount); // 0
   */
  reset() {
    this._transitionState(CircuitBreakerState.CLOSED);
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
        this._transitionState(CircuitBreakerState.HALF_OPEN);
      } else {
        // Circuit is still OPEN. Fail fast or use fallback.
        if (this.fallbackLogic) {
          return this.fallbackLogic();
        }
        const err = new Error('Circuit Breaker is OPEN. Operation failed fast.');
        err.code = 'CIRCUIT_OPEN';
        throw err;
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
      this._transitionState(CircuitBreakerState.CLOSED);
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
      this._transitionState(CircuitBreakerState.OPEN);
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
