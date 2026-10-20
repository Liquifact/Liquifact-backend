'use strict';

const crypto = require('crypto');

/**
 * Checks whether a trusted upstream authentication layer identified an admin.
 *
 * @param {import('express').Request} req Request.
 * @returns {boolean} Whether the authenticated principal has an admin role.
 */
function isAdminPrincipal(req) {
  return Boolean(req.user && ['admin', 'owner'].includes(String(req.user.role || '').toLowerCase()));
}

/**
 * Compares a bearer token with the configured admin token in constant time.
 *
 * @param {import('express').Request} req Request.
 * @returns {boolean} Whether the request presents the configured token.
 */
function isValidAdminToken(req) {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    return false;
  }
  const authorization = req.get('authorization') || '';
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) {
    return false;
  }
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  const suppliedDigest = crypto.createHash('sha256').update(match[1]).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

/**
 * Checks admin access via the configured API token or an authenticated admin
 * principal supplied by an upstream authentication layer.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {import('express').NextFunction} next Next callback.
 * @returns {void}
 */
function requireAdminToken(req, res, next) {
  if (isAdminPrincipal(req)) {
    return next();
  }

  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: { code: 'ADMIN_AUTH_UNCONFIGURED', message: 'Admin authentication is not configured.' },
    });
  }

  if (!isValidAdminToken(req)) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'A valid admin token is required.' },
    });
  }

  return next();
}

module.exports = { requireAdminToken, isAdminPrincipal, isValidAdminToken };
