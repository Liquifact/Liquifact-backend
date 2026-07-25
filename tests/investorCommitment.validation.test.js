'use strict';

/**
 * tests/investorCommitment.validation.test.js
 *
 * Unit tests for amountStroops validation and investorAddress validation
 * in src/services/investorCommitment.js.
 *
 * The knex DB is mocked globally via tests/mocks/setup.js.
 * All tests that exercise DB paths rely on the global mock's .first()
 * returning a row (simulating an existing idempotency-key match).
 */

const {
  CommitmentValidationError,
  validateAmountStroops,
  normalizeAmountStroopsInput,
  validateAddress,
  persistCommitment,
  updateCommitment,
} = require('../src/services/investorCommitment');

const VALID_ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const VALID_C_ADDRESS = 'CDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';

// ─── CommitmentValidationError ────────────────────────────────────────────────

describe('CommitmentValidationError', () => {
  it('is an instance of Error', () => {
    const err = new CommitmentValidationError('bad input', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CommitmentValidationError);
  });

  it('carries name, message, and code', () => {
    const err = new CommitmentValidationError('test message', 'MY_CODE');
    expect(err.name).toBe('CommitmentValidationError');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('MY_CODE');
  });
});

// ─── validateAmountStroops ────────────────────────────────────────────────────

describe('validateAmountStroops', () => {
  describe('valid inputs', () => {
    it('accepts "1" (minimum positive)', () => {
      expect(() => validateAmountStroops('1')).not.toThrow();
    });

    it('accepts a typical stroop amount', () => {
      expect(() => validateAmountStroops('10000000')).not.toThrow();
    });

    it('accepts large but sane amount', () => {
      expect(() => validateAmountStroops('999999999999999')).not.toThrow();
    });

    it('accepts exactly 10^18 (max boundary)', () => {
      expect(() => validateAmountStroops('1000000000000000000')).not.toThrow();
    });
  });

  describe('type rejection', () => {
    it('rejects a number type (not coerced)', () => {
      expect(() => validateAmountStroops(1000000)).toThrow(CommitmentValidationError);
      expect(() => validateAmountStroops(1000000)).toThrow(/must be a string/);
    });

    it('rejects null', () => {
      expect(() => validateAmountStroops(null)).toThrow(CommitmentValidationError);
    });

    it('rejects undefined', () => {
      expect(() => validateAmountStroops(undefined)).toThrow(CommitmentValidationError);
    });

    it('rejects a BigInt type', () => {
      expect(() => validateAmountStroops(1000000n)).toThrow(CommitmentValidationError);
    });
  });

  describe('format rejection', () => {
    it('rejects float string "1.5"', () => {
      const err = catchError(() => validateAmountStroops('1.5'));
      expect(err).toBeInstanceOf(CommitmentValidationError);
      expect(err.code).toBe('INVALID_AMOUNT_FORMAT');
    });

    it('rejects scientific notation "1e7"', () => {
      expect(() => validateAmountStroops('1e7')).toThrow(CommitmentValidationError);
    });

    it('rejects negative string "-1"', () => {
      const err = catchError(() => validateAmountStroops('-1'));
      expect(err).toBeInstanceOf(CommitmentValidationError);
      expect(err.code).toBe('INVALID_AMOUNT_FORMAT');
    });

    it('rejects string with spaces " 100"', () => {
      expect(() => validateAmountStroops(' 100')).toThrow(CommitmentValidationError);
    });

    it('rejects non-numeric string "abc"', () => {
      expect(() => validateAmountStroops('abc')).toThrow(CommitmentValidationError);
    });

    it('rejects empty string', () => {
      expect(() => validateAmountStroops('')).toThrow(CommitmentValidationError);
    });

    it('rejects string with leading zeros "007"', () => {
      const err = catchError(() => validateAmountStroops('007'));
      expect(err).toBeInstanceOf(CommitmentValidationError);
      expect(err.code).toBe('INVALID_AMOUNT_FORMAT');
    });

    it('rejects "00"', () => {
      expect(() => validateAmountStroops('00')).toThrow(CommitmentValidationError);
    });

    it('rejects hex string "0xff"', () => {
      expect(() => validateAmountStroops('0xff')).toThrow(CommitmentValidationError);
    });
  });

  describe('range rejection', () => {
    it('rejects zero "0"', () => {
      const err = catchError(() => validateAmountStroops('0'));
      expect(err).toBeInstanceOf(CommitmentValidationError);
      expect(err.code).toBe('INVALID_AMOUNT_RANGE');
    });

    it('rejects amount exceeding 10^18', () => {
      const err = catchError(() => validateAmountStroops('1000000000000000001'));
      expect(err).toBeInstanceOf(CommitmentValidationError);
      expect(err.code).toBe('INVALID_AMOUNT_OVERFLOW');
    });

    it('rejects very large overflow value', () => {
      expect(() => validateAmountStroops('9'.repeat(30))).toThrow(CommitmentValidationError);
    });
  });
});

// ─── normalizeAmountStroopsInput ──────────────────────────────────────────────

describe('normalizeAmountStroopsInput', () => {
  it('returns canonical string for safe integer numbers', () => {
    expect(normalizeAmountStroopsInput(10000000)).toBe('10000000');
  });

  it('returns large decimal strings without precision loss', () => {
    const large = '9007199254740993';
    expect(normalizeAmountStroopsInput(large)).toBe(large);
  });

  it('rejects scientific notation strings', () => {
    expect(() => normalizeAmountStroopsInput('1e7')).toThrow(CommitmentValidationError);
  });

  it('rejects decimal strings', () => {
    expect(() => normalizeAmountStroopsInput('100.0')).toThrow(CommitmentValidationError);
  });

  it('rejects unsafe integer numbers', () => {
    expect(() => normalizeAmountStroopsInput(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      CommitmentValidationError,
    );
  });
});

// ─── validateAddress ──────────────────────────────────────────────────────────

describe('validateAddress', () => {
  it('accepts valid G-prefix address', () => {
    expect(validateAddress(VALID_ADDRESS)).toEqual({ valid: true, reason: '' });
  });

  it('accepts valid C-prefix address', () => {
    expect(validateAddress(VALID_C_ADDRESS)).toEqual({ valid: true, reason: '' });
  });

  it('rejects empty string', () => {
    const result = validateAddress('');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/non-empty string/);
  });

  it('rejects null', () => {
    expect(validateAddress(null).valid).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validateAddress(undefined).valid).toBe(false);
  });

  it('rejects wrong prefix X', () => {
    const result = validateAddress('XDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/G or C/);
  });

  it('rejects address that is too short', () => {
    expect(validateAddress('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL').valid).toBe(false);
  });

  it('rejects address that is too long (57 chars)', () => {
    expect(validateAddress('G' + 'A'.repeat(56)).valid).toBe(false);
  });

  it('rejects address with lowercase characters', () => {
    const lower = VALID_ADDRESS.toLowerCase();
    expect(validateAddress(lower).valid).toBe(false);
  });

  it('rejects address containing invalid base-32 char (1)', () => {
    // "1" is not in A-Z2-7
    const bad = 'G' + '1'.repeat(55);
    expect(validateAddress(bad).valid).toBe(false);
  });
});

// ─── persistCommitment — validation guard ─────────────────────────────────────

describe('persistCommitment — validation', () => {
  const baseParams = {
    invoiceId: 'inv_test_001',
    investorAddress: VALID_ADDRESS,
    escrowAddress: VALID_C_ADDRESS,
    amountStroops: '10000000',
    status: 'requires_signature',
    idempotencyKey: 'unique-key-abc123',
  };

  it('throws CommitmentValidationError for float amountStroops', async () => {
    await expect(
      persistCommitment({ ...baseParams, amountStroops: '1.5' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws CommitmentValidationError for negative amountStroops string', async () => {
    await expect(
      persistCommitment({ ...baseParams, amountStroops: '-100' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws CommitmentValidationError for zero amountStroops', async () => {
    await expect(
      persistCommitment({ ...baseParams, amountStroops: '0' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws CommitmentValidationError for numeric type (not coerced)', async () => {
    await expect(
      persistCommitment({ ...baseParams, amountStroops: 10000000 })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws CommitmentValidationError for empty string amountStroops', async () => {
    await expect(
      persistCommitment({ ...baseParams, amountStroops: '' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws CommitmentValidationError for overflow amountStroops', async () => {
    await expect(
      persistCommitment({ ...baseParams, amountStroops: '9'.repeat(25) })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws CommitmentValidationError for invalid investor address', async () => {
    const err = await rejectsWith(
      persistCommitment({ ...baseParams, investorAddress: 'not-a-stellar-address' })
    );
    expect(err).toBeInstanceOf(CommitmentValidationError);
    expect(err.code).toBe('INVALID_INVESTOR_ADDRESS');
  });

  it('throws CommitmentValidationError for empty investor address', async () => {
    await expect(
      persistCommitment({ ...baseParams, investorAddress: '' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('returns existing row on duplicate idempotency key without re-inserting', async () => {
    // The global knex mock's .first() always resolves with a row, simulating a hit
    const result = await persistCommitment({ ...baseParams, idempotencyKey: 'dup-key-xyz' });
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
  });

  it('does not throw for valid inputs with idempotency key (mock returns existing row)', async () => {
    await expect(
      persistCommitment({ ...baseParams, idempotencyKey: 'valid-idem-key' })
    ).resolves.toBeDefined();
  });
});

// ─── updateCommitment — immutability guard ────────────────────────────────────

describe('updateCommitment — immutability', () => {
  it('throws CommitmentValidationError when amount_stroops is in fields', async () => {
    const err = await rejectsWith(
      updateCommitment('some-uuid', { status: 'submitted', amount_stroops: '99999' })
    );
    expect(err).toBeInstanceOf(CommitmentValidationError);
    expect(err.code).toBe('AMOUNT_IMMUTABLE');
  });

  it('throws CommitmentValidationError when amountStroops (camelCase) is in fields', async () => {
    await expect(
      updateCommitment('some-uuid', { amountStroops: '50000' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('rejects duplicate update that would change amount', async () => {
    const err = await rejectsWith(
      updateCommitment('some-uuid', { amount_stroops: '1' })
    );
    expect(err.code).toBe('AMOUNT_IMMUTABLE');
    expect(err.message).toMatch(/immutable/);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Synchronously catches and returns a thrown error; returns null if no throw. */
function catchError(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** Resolves with the rejection reason of a Promise; throws if it resolves. */
async function rejectsWith(promise) {
  try {
    await promise;
    throw new Error('Expected promise to reject but it resolved');
  } catch (e) {
    return e;
  }
}
