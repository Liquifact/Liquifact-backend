'use strict';

/**
 * @fileoverview AsyncLocalStorage-backed request context store.
 *
 * Provides an ambient store that carries safe correlation identifiers
 * (requestId, correlationId, tenantId, userId) across the async call chain of
 * a single request without threading them through every function signature.
 *
 * Background jobs that never call {@link run} simply get an empty context —
 * the logger degrades gracefully by omitting the ambient fields.
 *
 * @module requestContext
 */

const { AsyncLocalStorage } = require('async_hooks');

/**
 * The storage instance shared across the entire process.
 *
 * @type {AsyncLocalStorage<RequestContext>}
 */
const storage = new AsyncLocalStorage();

/**
 * @typedef {Object} RequestContext
 * @property {string} [requestId]     - Server-assigned request identifier.
 * @property {string} [correlationId] - Caller-supplied or generated correlation id.
 * @property {string} [tenantId]      - Resolved tenant identifier.
 * @property {string} [userId]        - Authenticated user identifier.
 */

/**
 * The set of keys permitted in the ambient context.
 * Only these keys are written; all others are silently ignored to prevent
 * PII or sensitive data from leaking into every log line.
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_KEYS = new Set(['requestId', 'correlationId', 'tenantId', 'userId']);

/**
 * Run `fn` inside a new context initialised with `initialValues`.
 * Any async work spawned inside `fn` inherits the same context.
 *
 * @param {Partial<RequestContext>} initialValues - Fields to seed the context with.
 * @param {() => void} fn - Synchronous callback (typically calls `next()`).
 * @returns {void}
 */
function run(initialValues, fn) {
  const ctx = {};
  for (const key of ALLOWED_KEYS) {
    if (typeof initialValues[key] === 'string' && initialValues[key]) {
      ctx[key] = initialValues[key];
    }
  }
  storage.run(ctx, fn);
}

/**
 * Return the current ambient context, or an empty object when there is none
 * (e.g. in background job workers).
 *
 * @returns {Readonly<RequestContext>}
 */
function get() {
  return storage.getStore() ?? {};
}

/**
 * Merge additional fields into the current context store in place.
 * No-ops when there is no active store (background job path).
 * Only {@link ALLOWED_KEYS} are accepted.
 *
 * @param {Partial<RequestContext>} fields - Fields to merge.
 * @returns {void}
 */
function set(fields) {
  const ctx = storage.getStore();
  if (!ctx) { return; }
  for (const key of ALLOWED_KEYS) {
    if (typeof fields[key] === 'string' && fields[key]) {
      ctx[key] = fields[key];
    }
  }
}

module.exports = { run, get, set, ALLOWED_KEYS };
