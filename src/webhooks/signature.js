'use strict';

/**
 * HMAC-SHA256 signing and verification for webhook deliveries.
 *
 * Header format:  LiquiFact-Signature: t=<unix>,v1=<hex>
 * Signed payload: `${t}.${rawBody}`
 */

const crypto = require('crypto');

/**
 * Signs a raw body string and returns the LiquiFact-Signature header value.
 *
 * @param {string} secret  base64url-encoded 32-byte secret
 * @param {string} rawBody serialised JSON string being sent
 * @param {number} [ts]    unix timestamp in seconds (defaults to now)
 * @returns {string} header value `t=<ts>,v1=<hex>`
 */
function sign(secret, rawBody, ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret, 'base64url');
  const payload = `${ts}.${rawBody}`;
  const hmac = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
  return `t=${ts},v1=${hmac}`;
}

/**
 * Verifies a LiquiFact-Signature header against the raw body.
 *
 * Uses a constant-time comparison to prevent timing attacks.
 *
 * @param {string} secret       base64url-encoded 32-byte secret
 * @param {string} header       value of the LiquiFact-Signature header
 * @param {string} rawBody      raw request body string
 * @param {number} [toleranceSec=300] max age of the timestamp in seconds
 * @returns {{ ok: boolean, error?: string }}
 */
function verifySignature(secret, header, rawBody, toleranceSec = 300) {
  if (!header || typeof header !== 'string') {
    return { ok: false, error: 'missing header' };
  }

  // Parse t= and v1= from header
  let ts, v1;
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') { ts = v; }
    if (k === 'v1') { v1 = v; }
  }

  if (!ts || !v1) {
    return { ok: false, error: 'malformed header' };
  }

  const timestamp = parseInt(ts, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: 'malformed header' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) {
    return { ok: false, error: 'stale timestamp' };
  }

  let key;
  try {
    key = Buffer.from(secret, 'base64url');
  } catch {
    return { ok: false, error: 'invalid secret' };
  }

  const payload = `${ts}.${rawBody}`;
  const expected = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');

  // Constant-time compare
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(v1, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return { ok: false, error: 'signature mismatch' };
  }

  const match = crypto.timingSafeEqual(expectedBuf, actualBuf);
  return match ? { ok: true } : { ok: false, error: 'signature mismatch' };
}

module.exports = { sign, verifySignature };
