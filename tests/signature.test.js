'use strict';

/**
 * Tests for src/webhooks/signature.js
 */

const { sign, verifySignature } = require('../src/webhooks/signature');
const crypto = require('crypto');

function makeSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

describe('signature', () => {
  test('sign + verifySignature round-trips', () => {
    const secret = makeSecret();
    const body = JSON.stringify({ id: 'evt_test', type: 'invoice.created' });
    const header = sign(secret, body);
    const result = verifySignature(secret, header, body);
    expect(result.ok).toBe(true);
  });

  test('tampered body fails verification', () => {
    const secret = makeSecret();
    const body = JSON.stringify({ id: 'evt_test', type: 'invoice.created' });
    const header = sign(secret, body);
    const tampered = body + ' ';
    const result = verifySignature(secret, header, tampered);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('signature mismatch');
  });

  test('wrong secret fails verification', () => {
    const secret = makeSecret();
    const wrongSecret = makeSecret();
    const body = JSON.stringify({ type: 'invoice.funded' });
    const header = sign(secret, body);
    const result = verifySignature(wrongSecret, header, body);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('signature mismatch');
  });

  test('stale timestamp fails verification', () => {
    const secret = makeSecret();
    const body = '{"type":"invoice.created"}';
    // timestamp 10 minutes in the past
    const staleTs = Math.floor(Date.now() / 1000) - 601;
    const header = sign(secret, body, staleTs);
    const result = verifySignature(secret, header, body, 300);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('stale timestamp');
  });

  test('malformed header (missing t=) fails', () => {
    const secret = makeSecret();
    const result = verifySignature(secret, 'v1=abcdef', '{}');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('malformed header');
  });

  test('missing header fails', () => {
    const secret = makeSecret();
    const result = verifySignature(secret, '', '{}');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing header');
  });

  test('null header fails', () => {
    const secret = makeSecret();
    const result = verifySignature(secret, null, '{}');
    expect(result.ok).toBe(false);
  });

  test('header with non-numeric t= fails', () => {
    const secret = makeSecret();
    const result = verifySignature(secret, 't=abc,v1=deadbeef', '{}');
    expect(result.ok).toBe(false);
  });
});
