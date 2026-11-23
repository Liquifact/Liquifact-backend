'use strict';

/**
 * Shared guard for internal cron/scheduler endpoints.
 *
 * Returns 404 when CRON_SECRET is not configured so the endpoint does not
 * advertise itself, and 401 for a missing or invalid Bearer token. Uses a
 * constant-time comparison to avoid timing-based secret leakage.
 */

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') { return false; }
  if (a.length !== b.length) {
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    void diff;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * @param {import('express').Request} req request
 * @param {import('express').Response} res response
 * @param {import('express').NextFunction} next next handler
 * @returns {void}
 */
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return res.status(404).json({ error: 'Not found' });
  }

  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!safeEqual(token, secret)) {
    return res.status(401).json({
      type: 'https://liquifact.io/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid or missing Authorization: Bearer <CRON_SECRET>.',
    });
  }
  return next();
}

// Marker for the route-table guard test (machine credential, not an API-key role).
requireCronSecret.requiredRoles = ['cron'];

module.exports = { requireCronSecret, safeEqual };
