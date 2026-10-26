#!/usr/bin/env node
'use strict';

/**
 * Generates a new LiquiFact API key.
 *
 * Usage:
 *   npm run apikey:new -- --role sme [--id my-key-id]
 *
 * Prints the raw key exactly once (store it securely; it is never retrievable
 * afterwards) plus the matching `API_KEYS` configuration line, which only
 * contains the SHA-256 hash of the key.
 */

const crypto = require('crypto');

/** Roles an API key can carry (mirrors src/config.js). */
const ROLES = ['sme', 'investor', 'admin'];

/**
 * Reads the value following a CLI flag.
 *
 * @param {string} flag flag to look for, e.g. `--role`
 * @returns {string|null} the value, or null when the flag is absent
 */
function argValue(flag) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  if (index === -1 || index === argv.length - 1) {
    return null;
  }
  return argv[index + 1];
}

const role = argValue('--role');
if (!role || !ROLES.includes(role)) {
  console.error(`Usage: npm run apikey:new -- --role <${ROLES.join('|')}> [--id <key-id>]`);
  process.exit(1);
}

const id = argValue('--id') || `ak_${crypto.randomBytes(4).toString('hex')}`;
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
  console.error('Key id must be 1-64 letters, digits, "_" or "-"');
  process.exit(1);
}

// 32 random bytes, URL-safe base64, prefixed so the value is recognisable.
const key = `lf_${crypto.randomBytes(32).toString('base64url')}`;
const hash = crypto.createHash('sha256').update(key).digest('hex');

console.log('API key (shown once, store it securely):');
console.log(key);
console.log('');
console.log('API_KEYS entry (safe to commit to your deployment config):');
console.log(`${id}:${role}:${hash}`);
