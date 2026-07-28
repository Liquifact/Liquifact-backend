'use strict';

/**
 * @fileoverview Comprehensive tests for KYC webhook input validation (issue #638).
 *
 * Coverage:
 *  • kycWebhookSchema — strict parsing, field-level errors
 *  • parseValidationErrors — ZodError → fieldErrors map
 *  • Route integration — structured RFC 7807 400 responses
 */

const { kycWebhookSchema, parseValidationErrors, SME_ID_REGEX } = require('../../src/schemas/kycWebhook');

// ── Schema-level tests ──────────────────────────────────────────────────────

describe('kycWebhookSchema — input validation', () => {
  // ─── Valid payloads ──────────────────────────────────────────────────────

  describe('valid payloads', () => {
    it('accepts a minimal payload with required fields only', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
      });
      expect(result.success).toBe(true);
      expect(result.data.smeId).toBe('sme-001');
      expect(result.data.status).toBe('verified');
    });

    it('accepts a full payload with optional fields', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-002',
        status: 'approved',
        recordId: 'rec_abc123',
        verifiedAt: '2026-07-23T10:00:00.000Z',
      });
      expect(result.success).toBe(true);
      expect(result.data.recordId).toBe('rec_abc123');
      expect(result.data.verifiedAt).toBe('2026-07-23T10:00:00.000Z');
    });

    it('accepts smeId with underscores and hyphens', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme_test-123',
        status: 'pending',
      });
      expect(result.success).toBe(true);
    });
  });

  // ─── Missing fields ──────────────────────────────────────────────────────

  describe('missing fields', () => {
    it('rejects when smeId is missing', () => {
      const result = kycWebhookSchema.safeParse({ status: 'verified' });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.smeId).toBeDefined();
    });

    it('rejects when status is missing', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 'sme-001' });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.status).toBeDefined();
    });

    it('rejects an empty object', () => {
      const result = kycWebhookSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  // ─── Wrong types ─────────────────────────────────────────────────────────

  describe('wrong types', () => {
    it('rejects smeId as a number', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 12345, status: 'verified' });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.smeId).toMatch(/string/);
    });

    it('rejects status as a number', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 'sme-001', status: 123 });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.status).toMatch(/string/);
    });

    it('rejects recordId as a number', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        recordId: 999,
      });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.recordId).toMatch(/string/);
    });

    it('rejects verifiedAt as a number', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        verifiedAt: 1234567890,
      });
      expect(result.success).toBe(false);
    });

    it('rejects null smeId', () => {
      const result = kycWebhookSchema.safeParse({ smeId: null, status: 'verified' });
      expect(result.success).toBe(false);
    });
  });

  // ─── Unknown fields ──────────────────────────────────────────────────────

  describe('unknown fields (strict)', () => {
    it('rejects payloads with extra properties', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        hackerField: 'malicious',
      });
      expect(result.success).toBe(false);
    });

    it('rejects payloads with multiple unknown fields', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        extra1: true,
        extra2: {},
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── Oversized strings ───────────────────────────────────────────────────

  describe('oversized strings', () => {
    it('rejects smeId exceeding 128 characters', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'a'.repeat(129),
        status: 'verified',
      });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.smeId).toMatch(/128/);
    });

    it('rejects status exceeding 50 characters', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 's'.repeat(51),
      });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.status).toMatch(/50/);
    });

    it('rejects recordId exceeding 255 characters', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        recordId: 'r'.repeat(256),
      });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.recordId).toMatch(/255/);
    });

    it('accepts smeId at exactly 128 characters (boundary)', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'a'.repeat(128),
        status: 'verified',
      });
      expect(result.success).toBe(true);
    });

    it('accepts status at exactly 50 characters (boundary)', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 's'.repeat(50),
      });
      expect(result.success).toBe(true);
    });
  });

  // ─── Empty strings ───────────────────────────────────────────────────────

  describe('empty strings', () => {
    it('rejects empty smeId', () => {
      const result = kycWebhookSchema.safeParse({ smeId: '', status: 'verified' });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.smeId).toMatch(/not be empty/);
    });

    it('rejects empty status', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 'sme-001', status: '' });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.status).toMatch(/not be empty/);
    });
  });

  // ─── Invalid smeId characters ────────────────────────────────────────────

  describe('invalid smeId characters', () => {
    it('rejects smeId with spaces', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 'sme 001', status: 'verified' });
      expect(result.success).toBe(false);
    });

    it('rejects smeId with special characters', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 'sme@001!', status: 'verified' });
      expect(result.success).toBe(false);
    });

    it('rejects smeId with control characters', () => {
      const result = kycWebhookSchema.safeParse({ smeId: 'sme\n001', status: 'verified' });
      expect(result.success).toBe(false);
    });
  });

  // ─── Invalid verifiedAt ──────────────────────────────────────────────────

  describe('invalid verifiedAt', () => {
    it('rejects non-ISO date strings', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        verifiedAt: 'not-a-date',
      });
      expect(result.success).toBe(false);
      const errors = parseValidationErrors(result.error);
      expect(errors.verifiedAt).toMatch(/ISO 8601/);
    });

    it('rejects date-only strings (no time component)', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        verifiedAt: '2026-07-23',
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid ISO 8601 with milliseconds and Z suffix', () => {
      const result = kycWebhookSchema.safeParse({
        smeId: 'sme-001',
        status: 'verified',
        verifiedAt: '2026-07-23T10:00:00.000Z',
      });
      expect(result.success).toBe(true);
    });
  });

  // ─── Boundary numbers / edge cases ───────────────────────────────────────

  describe('boundary and edge cases', () => {
    it('rejects an array instead of an object', () => {
      const result = kycWebhookSchema.safeParse([]);
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = kycWebhookSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects undefined', () => {
      const result = kycWebhookSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('rejects boolean', () => {
      const result = kycWebhookSchema.safeParse(true);
      expect(result.success).toBe(false);
    });
  });
});

// ── parseValidationErrors ────────────────────────────────────────────────────

describe('parseValidationErrors', () => {
  it('maps field-level issues to a flat map', () => {
    const result = kycWebhookSchema.safeParse({});
    const errors = parseValidationErrors(result.error);
    expect(typeof errors).toBe('object');
    expect(errors.smeId).toBeDefined();
    expect(errors.status).toBeDefined();
    expect(errors.smeId).toEqual(expect.any(String));
    expect(errors.status).toEqual(expect.any(String));
  });

  it('handles an error with no issues gracefully', () => {
    const errors = parseValidationErrors({});
    expect(errors).toEqual({});
  });

  it('uses _root for issues with no path', () => {
    // Create a schema that produces a root-level error
    const { z } = require('zod');
    const rootSchema = z.string();
    const result = rootSchema.safeParse(123);
    const errors = parseValidationErrors(result.error);
    expect(errors._root).toBeDefined();
  });
});

// ── SME_ID_REGEX ─────────────────────────────────────────────────────────────

describe('SME_ID_REGEX', () => {
  it('matches valid smeId values', () => {
    expect(SME_ID_REGEX.test('sme-001')).toBe(true);
    expect(SME_ID_REGEX.test('abc_123')).toBe(true);
    expect(SME_ID_REGEX.test('ABC')).toBe(true);
    expect(SME_ID_REGEX.test('test-id-here')).toBe(true);
    expect(SME_ID_REGEX.test('a'.repeat(128))).toBe(true);
  });

  it('rejects invalid smeId values', () => {
    expect(SME_ID_REGEX.test('')).toBe(false);
    expect(SME_ID_REGEX.test('sme 001')).toBe(false);
    expect(SME_ID_REGEX.test('sme@001')).toBe(false);
    expect(SME_ID_REGEX.test('a'.repeat(129))).toBe(false);
  });
});
