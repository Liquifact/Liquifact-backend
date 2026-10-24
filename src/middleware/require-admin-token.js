'use strict';

const crypto = require('crypto');

const digest = (text) => crypto.createHash('sha256').update(text).digest();

/**
 * Guards admin-only routes with a shared secret:
 * `Authorization: Bearer ${ADMIN_API_TOKEN}`.
 *
 * - 503 when ADMIN_API_TOKEN is not configured (the routes stay closed)
 * - 401 when the header is missing, malformed or the token does not match
 *
 * Tokens are compared as fixed-length digests with timingSafeEqual, so response
 * time does not reveal how much of a guess was right or how long the token is.
 *
 * @param {import('express').Request} req request
 * @param {import('express').Response} res response
 * @param {import('express').NextFunction} next next handler
 * @returns {void}
 */
function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Admin API is not configured' });
    return;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
  const matches = crypto.timingSafeEqual(digest(match ? match[1] : ''), digest(expected));
  if (!match || !matches) {
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Admin token required' });
    return;
  }
  next();
}

module.exports = { requireAdminToken };
