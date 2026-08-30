'use strict';

const crypto = require('crypto');
const { validateKycWebhookRequest } = require('/home/inspiuser/Desktop/Liquifact-backend/src/middleware/kycWebhookValidation');

function createSignature(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

function makeKycService() {
  return {
    normalizeProviderStatus: (s) => (s === 'verified' ? 'verified' : 'unknown'),
    KYC_STATUSES: { UNKNOWN: 'unknown', VERIFIED: 'verified' },
  };
}

describe('KYC Webhook Signing Key Rotation (Issue #1195)', () => {
  const NEW_KEY = 'new-secret-key-1234567890';
  const OLD_KEY = 'old-secret-key-0987654321';
  const NOW_SEC = Math.floor(Date.now() / 1000);
  const RAW_PAYLOAD = JSON.stringify({ smeId: 'sme-1', status: 'verified' });

  describe('Edge case 1: new key only', () => {
    it('verifies signatures signed with the new active key', () => {
      const sig = `t=${NOW_SEC},v1=${createSignature(NEW_KEY, RAW_PAYLOAD, NOW_SEC)}`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        { current: NEW_KEY, retiring: OLD_KEY },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(true);
      expect(result.payload.smeId).toBe('sme-1');
    });

    it('verifies when only new key is configured without retiring key', () => {
      const sig = `t=${NOW_SEC},v1=${createSignature(NEW_KEY, RAW_PAYLOAD, NOW_SEC)}`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        { current: NEW_KEY },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('Edge case 2: old key during grace period', () => {
    it('verifies signatures signed with the retiring key when grace period is active', () => {
      const sig = `t=${NOW_SEC},v1=${createSignature(OLD_KEY, RAW_PAYLOAD, NOW_SEC)}`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        { current: NEW_KEY, retiring: OLD_KEY },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(true);
      expect(result.payload.status).toBe('verified');
    });

    it('rejects old key if retiring key is not configured', () => {
      const sig = `t=${NOW_SEC},v1=${createSignature(OLD_KEY, RAW_PAYLOAD, NOW_SEC)}`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        { current: NEW_KEY },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(false);
      expect(result.error.errorCode).toBe('invalid_signature');
    });
  });

  describe('Edge case 3: unknown key ID', () => {
    it('verifies successfully when matching kid is provided', () => {
      const sig = `t=${NOW_SEC},v1=${createSignature(NEW_KEY, RAW_PAYLOAD, NOW_SEC)},kid=key-2026`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        { keys: { 'key-2026': NEW_KEY, 'key-2025': OLD_KEY } },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(true);
    });

    it('rejects when kid does not match any configured key', () => {
      const sig = `t=${NOW_SEC},v1=${createSignature(NEW_KEY, RAW_PAYLOAD, NOW_SEC)},kid=unknown-key-id`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        { keys: { 'key-2026': NEW_KEY, 'key-2025': OLD_KEY } },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(false);
      expect(result.error.status).toBe(401);
      expect(result.error.errorCode).toBe('invalid_signature');
    });
  });

  describe('Edge case 4: signature with wrong body', () => {
    it('rejects tampered body with valid signature for different body', () => {
      const differentBody = JSON.stringify({ smeId: 'sme-tampered', status: 'verified' });
      const sig = `t=${NOW_SEC},v1=${createSignature(NEW_KEY, RAW_PAYLOAD, NOW_SEC)}`;
      const result = validateKycWebhookRequest(
        differentBody,
        sig,
        { current: NEW_KEY, retiring: OLD_KEY },
        null,
        makeKycService()
      );
      expect(result.valid).toBe(false);
      expect(result.error.errorCode).toBe('invalid_signature');
    });
  });

  describe('Edge case 5: rotation configuration is incomplete', () => {
    it('returns missing_secret (503) when no keys are configured', () => {
      const sig = `t=${NOW_SEC},v1=somehash`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        null,
        null,
        makeKycService()
      );
      expect(result.valid).toBe(false);
      expect(result.error.status).toBe(503);
      expect(result.error.errorCode).toBe('missing_secret');
    });

    it('returns missing_secret when empty object is passed', () => {
      const sig = `t=${NOW_SEC},v1=somehash`;
      const result = validateKycWebhookRequest(
        RAW_PAYLOAD,
        sig,
        {},
        null,
        makeKycService()
      );
      expect(result.valid).toBe(false);
      expect(result.error.status).toBe(503);
    });
  });
});
