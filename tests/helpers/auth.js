'use strict';

/**
 * Test API keys (issue #1534). Requiring this module configures API_KEYS with
 * one key per role; it must be required before src/app (or src/config).
 */

const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const KEYS = {
  sme: 'lf_test_sme_key',
  investor: 'lf_test_investor_key',
  admin: 'lf_test_admin_key',
};

process.env.API_KEYS = Object.entries(KEYS)
  .map(([role, key]) => `test-${role}:${role}:${sha256(key)}`)
  .join(',');

/**
 * @param {'sme'|'investor'|'admin'} [role] key role
 * @returns {{ authorization: string }} header object for supertest's `.set()`
 */
function authHeader(role = 'admin') {
  return { authorization: `Bearer ${KEYS[role]}` };
}

module.exports = { KEYS, authHeader };
