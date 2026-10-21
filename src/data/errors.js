'use strict';

/**
 * Repository / persistence error with an HTTP-oriented status and stable code.
 */
class RepoError extends Error {
  /**
   * @param {string} code machine-readable error code
   * @param {string} message human-readable message
   * @param {number} [status=400] HTTP status
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {unknown} err caught error
 * @returns {boolean} true when the failure looks like a DB connectivity problem
 */
function isDbUnavailable(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  if (err.code === 'DB_UNAVAILABLE') {
    return true;
  }
  const code = err.code;
  // node-postgres / knex connection failures
  return (
    code === 'ECONNREFUSED'
    || code === 'ENOTFOUND'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === '57P01' // admin_shutdown
    || code === '57P03' // cannot_connect_now
    || code === '08000'
    || code === '08001'
    || code === '08003'
    || code === '08006'
  );
}

/**
 * Express helper: map repo/DB failures to JSON responses.
 *
 * @param {import('express').Response} res response
 * @param {unknown} err error
 * @returns {boolean} true if the error was handled
 */
function sendRepoError(res, err) {
  if (isDbUnavailable(err)) {
    res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
    return true;
  }
  if (err instanceof RepoError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

module.exports = { RepoError, isDbUnavailable, sendRepoError };
