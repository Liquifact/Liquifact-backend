'use strict';

/**
 * tests/monetary.test.js
 *
 * Comprehensive unit tests for monetary precision utilities.
 * Covers:
 *   - Input validation (type, format, scale, range)
 *   - Canonical decimal normalization
 *   - BigInt arithmetic (add, subtract, multiply)
 *   - Comparison operations
 *   - Derived calculations (funded percent)
 *   - Edge cases (zero, negative, overflow, precision loss)
 */

const {
  MAX_SCALE,
  SCALE_FACTOR,
  MAX_MONETARY_UNITS,
  MonetaryValidationError,
  validateMonetaryString,
  normalizeMonetaryInput,
  formatCanonicalMonetary,
  parseMonetaryToUnits,
  toCanonicalDecimal,
  addMonetary,
  subtractMonetary,
  multiplyMonetary,
  areMonetaryEqual,
  compareMonetary,
  computeFundedPercentPrecise,
} = require('../src/utils/monetary');

// ─── Constants ───────────────────────────────────────────────────────────────

describe('Monetary Constants', () => {
  it('MAX_SCALE is 2 (matches DECIMAL(15,2))', () => {
    expect(MAX_SCALE).toBe(2);
  });

  it('SCALE_FACTOR is 100 (10^2)', () => {
    expect(SCALE_FACTOR).toBe(100n);
  });

  it('MAX_MONETARY_UNITS is 99999999999999', () => {
    expect(MAX_MONETARY_UNITS).toBe(99999999999999n);
  });
});

// ─── MonetaryValidationError ─────────────────────────────────────────────────

describe('MonetaryValidationError', () => {
  it('is an instance of Error', () => {
    const err = new MonetaryValidationError('bad input', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MonetaryValidationError);
  });

  it('carries name, message, and code', () => {
    const err = new MonetaryValidationError('test message', 'MY_CODE');
    expect(err.name).toBe('MonetaryValidationError');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('MY_CODE');
  });
});

// ─── validateMonetaryString ──────────────────────────────────────────────────

describe('validateMonetaryString', () => {
  describe('valid inputs', () => {
    it('accepts "1" (minimum positive integer)', () => {
      expect(() => validateMonetaryString('1')).not.toThrow();
    });

    it('accepts "0.01" (minimum positive with cents)', () => {
      expect(() => validateMonetaryString('0.01')).not.toThrow();
    });

    it('accepts "123.45" (typical monetary value)', () => {
      expect(() => validateMonetaryString('123.45')).not.toThrow();
    });

    it('accepts "99999999999999.99" (max DECIMAL(15,2))', () => {
      expect(() => validateMonetaryString('99999999999999.99')).not.toThrow();
    });

    it('accepts "100" (whole number)', () => {
      expect(() => validateMonetaryString('100')).not.toThrow();
    });

    it('accepts "0.1" (one decimal place)', () => {
      expect(() => validateMonetaryString('0.1')).not.toThrow();
    });

    it('accepts "1234.5" (mixed)', () => {
      expect(() => validateMonetaryString('1234.5')).not.toThrow();
    });
  });

  describe('type rejection', () => {
    it('rejects number type', () => {
      expect(() => validateMonetaryString(100)).toThrow(MonetaryValidationError);
      expect(() => validateMonetaryString(100)).toThrow(/must be a string/);
    });

    it('rejects null', () => {
      expect(() => validateMonetaryString(null)).toThrow(MonetaryValidationError);
    });

    it('rejects undefined', () => {
      expect(() => validateMonetaryString(undefined)).toThrow(MonetaryValidationError);
    });

    it('rejects boolean', () => {
      expect(() => validateMonetaryString(true)).toThrow(MonetaryValidationError);
    });

    it('rejects object', () => {
      expect(() => validateMonetaryString({})).toThrow(MonetaryValidationError);
    });

    it('rejects array', () => {
      expect(() => validateMonetaryString([])).toThrow(MonetaryValidationError);
    });

    it('rejects BigInt', () => {
      expect(() => validateMonetaryString(100n)).toThrow(MonetaryValidationError);
    });
  });

  describe('format rejection', () => {
    it('rejects empty string', () => {
      const err = catchError(() => validateMonetaryString(''));
      expect(err).toBeInstanceOf(MonetaryValidationError);
      expect(err.code).toBe('EMPTY_VALUE');
    });

    it('rejects negative string "-1"', () => {
      expect(() => validateMonetaryString('-1')).toThrow(MonetaryValidationError);
    });

    it('rejects scientific notation "1e7"', () => {
      expect(() => validateMonetaryString('1e7')).toThrow(MonetaryValidationError);
    });

    it('rejects string with spaces " 100"', () => {
      expect(() => validateMonetaryString(' 100')).toThrow(MonetaryValidationError);
    });

    it('rejects string with trailing spaces "100 "', () => {
      expect(() => validateMonetaryString('100 ')).toThrow(MonetaryValidationError);
    });

    it('rejects non-numeric string "abc"', () => {
      expect(() => validateMonetaryString('abc')).toThrow(MonetaryValidationError);
    });

    it('rejects string with leading zeros "007"', () => {
      const err = catchError(() => validateMonetaryString('007'));
      expect(err).toBeInstanceOf(MonetaryValidationError);
      expect(err.code).toBe('INVALID_FORMAT');
    });

    it('rejects "00"', () => {
      expect(() => validateMonetaryString('00')).toThrow(MonetaryValidationError);
    });

    it('rejects hex string "0xff"', () => {
      expect(() => validateMonetaryString('0xff')).toThrow(MonetaryValidationError);
    });

    it('rejects too many fractional digits "123.456"', () => {
      const err = catchError(() => validateMonetaryString('123.456'));
      expect(err).toBeInstanceOf(MonetaryValidationError);
      // Regex rejects 3 fractional digits as INVALID_FORMAT before scale check
      expect(err.code).toMatch(/INVALID_(FORMAT|SCALE)/);
    });

    it('rejects "123.4567" (4 fractional digits)', () => {
      expect(() => validateMonetaryString('123.4567')).toThrow(MonetaryValidationError);
    });

    it('rejects trailing decimal point "123."', () => {
      expect(() => validateMonetaryString('123.')).toThrow(MonetaryValidationError);
    });

    it('rejects leading decimal point ".45"', () => {
      expect(() => validateMonetaryString('.45')).toThrow(MonetaryValidationError);
    });
  });

  describe('range rejection', () => {
    it('rejects zero "0"', () => {
      const err = catchError(() => validateMonetaryString('0'));
      expect(err).toBeInstanceOf(MonetaryValidationError);
      expect(err.code).toBe('INVALID_RANGE');
    });

    it('rejects zero with decimals "0.00"', () => {
      expect(() => validateMonetaryString('0.00')).toThrow(MonetaryValidationError);
    });

    it('rejects amount exceeding max', () => {
      const err = catchError(() => validateMonetaryString('999999999999999.99'));
      expect(err).toBeInstanceOf(MonetaryValidationError);
      expect(err.code).toBe('INVALID_RANGE');
    });
  });

  describe('custom field name', () => {
    it('uses custom field name in error message', () => {
      const err = catchError(() => validateMonetaryString('abc', 'totalAmount'));
      expect(err.message).toContain('totalAmount');
    });
  });
});

// ─── normalizeMonetaryInput ──────────────────────────────────────────────────

describe('normalizeMonetaryInput', () => {
  describe('number inputs', () => {
    it('converts integer to canonical string', () => {
      expect(normalizeMonetaryInput(100)).toBe('100.00');
    });

    it('converts float to canonical string', () => {
      expect(normalizeMonetaryInput(123.45)).toBe('123.45');
    });

    it('rounds to 2 decimal places', () => {
      expect(normalizeMonetaryInput(123.456)).toBe('123.46');
    });

    it('handles IEEE 754 drift', () => {
      expect(normalizeMonetaryInput(0.1 + 0.2)).toBe('0.30');
    });

    it('rejects NaN', () => {
      expect(() => normalizeMonetaryInput(NaN)).toThrow(MonetaryValidationError);
    });

    it('rejects Infinity', () => {
      expect(() => normalizeMonetaryInput(Infinity)).toThrow(MonetaryValidationError);
    });

    it('rejects negative', () => {
      expect(() => normalizeMonetaryInput(-100)).toThrow(MonetaryValidationError);
    });

    it('rejects zero', () => {
      expect(() => normalizeMonetaryInput(0)).toThrow(MonetaryValidationError);
    });
  });

  describe('string inputs', () => {
    it('returns canonical string for valid input', () => {
      expect(normalizeMonetaryInput('123.45')).toBe('123.45');
    });

    it('returns canonical string for integer string', () => {
      expect(normalizeMonetaryInput('100')).toBe('100');
    });

    it('rejects invalid format', () => {
      expect(() => normalizeMonetaryInput('abc')).toThrow(MonetaryValidationError);
    });

    it('rejects too many decimals', () => {
      expect(() => normalizeMonetaryInput('123.456')).toThrow(MonetaryValidationError);
    });
  });

  describe('other types', () => {
    it('rejects null', () => {
      expect(() => normalizeMonetaryInput(null)).toThrow(MonetaryValidationError);
    });

    it('rejects undefined', () => {
      expect(() => normalizeMonetaryInput(undefined)).toThrow(MonetaryValidationError);
    });

    it('rejects object', () => {
      expect(() => normalizeMonetaryInput({})).toThrow(MonetaryValidationError);
    });

    it('rejects boolean', () => {
      expect(() => normalizeMonetaryInput(true)).toThrow(MonetaryValidationError);
    });
  });
});

// ─── formatCanonicalMonetary ─────────────────────────────────────────────────

describe('formatCanonicalMonetary', () => {
  it('formats whole units', () => {
    expect(formatCanonicalMonetary(10000n)).toBe('100');
  });

  it('formats with cents', () => {
    expect(formatCanonicalMonetary(12345n)).toBe('123.45');
  });

  it('formats zero cents', () => {
    expect(formatCanonicalMonetary(12300n)).toBe('123');
  });

  it('formats single cent', () => {
    expect(formatCanonicalMonetary(10001n)).toBe('100.01');
  });

  it('formats large amounts', () => {
    expect(formatCanonicalMonetary(9999999999999999n)).toBe('99999999999999.99');
  });

  it('formats zero', () => {
    expect(formatCanonicalMonetary(0n)).toBe('0');
  });
});

// ─── parseMonetaryToUnits ────────────────────────────────────────────────────

describe('parseMonetaryToUnits', () => {
  it('parses whole number', () => {
    expect(parseMonetaryToUnits('100')).toBe(10000n);
  });

  it('parses with cents', () => {
    expect(parseMonetaryToUnits('123.45')).toBe(12345n);
  });

  it('parses single decimal', () => {
    expect(parseMonetaryToUnits('123.4')).toBe(12340n);
  });

  it('parses zero cents', () => {
    expect(parseMonetaryToUnits('123.00')).toBe(12300n);
  });

  it('parses minimum value', () => {
    expect(parseMonetaryToUnits('0.01')).toBe(1n);
  });

  it('parses max value', () => {
    expect(parseMonetaryToUnits('99999999999999.99')).toBe(9999999999999999n);
  });

  it('throws for invalid input', () => {
    expect(() => parseMonetaryToUnits('abc')).toThrow(MonetaryValidationError);
  });
});

// ─── toCanonicalDecimal ──────────────────────────────────────────────────────

describe('toCanonicalDecimal', () => {
  it('converts integer', () => {
    expect(toCanonicalDecimal(100)).toBe('100.00');
  });

  it('converts float', () => {
    expect(toCanonicalDecimal(123.45)).toBe('123.45');
  });

  it('rounds to 2 dp', () => {
    expect(toCanonicalDecimal(123.456)).toBe('123.46');
  });

  it('handles IEEE 754 drift', () => {
    expect(toCanonicalDecimal(0.1 + 0.2)).toBe('0.30');
  });

  it('rejects NaN', () => {
    expect(() => toCanonicalDecimal(NaN)).toThrow(MonetaryValidationError);
  });

  it('rejects Infinity', () => {
    expect(() => toCanonicalDecimal(Infinity)).toThrow(MonetaryValidationError);
  });

  it('rejects negative', () => {
    expect(() => toCanonicalDecimal(-100)).toThrow(MonetaryValidationError);
  });

  it('rejects zero', () => {
    expect(() => toCanonicalDecimal(0)).toThrow(MonetaryValidationError);
  });
});

// ─── addMonetary ─────────────────────────────────────────────────────────────

describe('addMonetary', () => {
  it('adds two amounts', () => {
    expect(addMonetary('100.00', '50.00')).toBe('150');
  });

  it('adds with cents', () => {
    expect(addMonetary('100.50', '50.25')).toBe('150.75');
  });

  it('adds with carry', () => {
    expect(addMonetary('99.99', '0.01')).toBe('100');
  });

  it('adds large amounts', () => {
    expect(addMonetary('99999999999999.99', '0.01')).toBe('100000000000000');
  });

  it('adds zero', () => {
    expect(addMonetary('100.00', '0.01')).toBe('100.01');
  });

  it('throws for invalid input', () => {
    expect(() => addMonetary('abc', '100')).toThrow(MonetaryValidationError);
  });
});

// ─── subtractMonetary ────────────────────────────────────────────────────────

describe('subtractMonetary', () => {
  it('subtracts two amounts', () => {
    expect(subtractMonetary('100.00', '50.00')).toBe('50');
  });

  it('subtracts with cents', () => {
    expect(subtractMonetary('100.50', '50.25')).toBe('50.25');
  });

  it('subtracts to zero cents', () => {
    expect(subtractMonetary('100.00', '100.00')).toBe('0');
  });

  it('subtracts to exact', () => {
    expect(subtractMonetary('100.00', '99.99')).toBe('0.01');
  });

  it('throws for negative result', () => {
    expect(() => subtractMonetary('50.00', '100.00')).toThrow(MonetaryValidationError);
  });

  it('throws for invalid input', () => {
    expect(() => subtractMonetary('abc', '100')).toThrow(MonetaryValidationError);
  });
});

// ─── multiplyMonetary ────────────────────────────────────────────────────────

describe('multiplyMonetary', () => {
  it('multiplies by integer', () => {
    expect(multiplyMonetary('100.00', 3)).toBe('300');
  });

  it('multiplies by zero', () => {
    expect(multiplyMonetary('100.00', 0)).toBe('0');
  });

  it('multiplies by one', () => {
    expect(multiplyMonetary('100.00', 1)).toBe('100');
  });

  it('multiplies by BigInt', () => {
    expect(multiplyMonetary('100.00', 3n)).toBe('300');
  });

  it('throws for negative factor', () => {
    expect(() => multiplyMonetary('100.00', -1)).toThrow(MonetaryValidationError);
  });

  it('throws for non-integer factor', () => {
    expect(() => multiplyMonetary('100.00', 1.5)).toThrow(MonetaryValidationError);
  });

  it('throws for overflow', () => {
    expect(() => multiplyMonetary('99999999999999.99', 2)).toThrow(MonetaryValidationError);
  });
});

// ─── areMonetaryEqual ────────────────────────────────────────────────────────

describe('areMonetaryEqual', () => {
  it('returns true for equal amounts', () => {
    expect(areMonetaryEqual('100.00', '100.00')).toBe(true);
  });

  it('returns true for equivalent forms', () => {
    expect(areMonetaryEqual('100', '100.00')).toBe(true);
  });

  it('returns false for different amounts', () => {
    expect(areMonetaryEqual('100.00', '100.01')).toBe(false);
  });

  it('returns false for invalid input', () => {
    expect(areMonetaryEqual('abc', '100')).toBe(false);
  });
});

// ─── compareMonetary ─────────────────────────────────────────────────────────

describe('compareMonetary', () => {
  it('returns 0 for equal amounts', () => {
    expect(compareMonetary('100.00', '100.00')).toBe(0);
  });

  it('returns -1 when a < b', () => {
    expect(compareMonetary('50.00', '100.00')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareMonetary('100.00', '50.00')).toBe(1);
  });

  it('compares with precision', () => {
    expect(compareMonetary('100.00', '100.01')).toBe(-1);
    expect(compareMonetary('100.01', '100.00')).toBe(1);
  });

  it('throws for invalid input', () => {
    expect(() => compareMonetary('abc', '100')).toThrow(MonetaryValidationError);
  });
});

// ─── computeFundedPercentPrecise ─────────────────────────────────────────────

describe('computeFundedPercentPrecise', () => {
  it('computes 50%', () => {
    expect(computeFundedPercentPrecise('500.00', '1000.00')).toBe(50);
  });

  it('computes 100%', () => {
    expect(computeFundedPercentPrecise('1000.00', '1000.00')).toBe(100);
  });

  it('computes 0%', () => {
    // Zero amount is rejected by validateMonetaryString, so we use a tiny amount
    expect(computeFundedPercentPrecise('0.01', '1000.00')).toBe(0);
  });

  it('computes 33.33% (repeating decimal)', () => {
    expect(computeFundedPercentPrecise('1.00', '3.00')).toBe(33.33);
  });

  it('computes 66.67% (repeating decimal)', () => {
    // 2/3 = 0.6666... * 100 = 66.66... rounds to 66.67 with half-up rounding
    expect(computeFundedPercentPrecise('2.00', '3.00')).toBe(66.67);
  });

  it('computes over-funded (> 100%)', () => {
    expect(computeFundedPercentPrecise('1500.00', '1000.00')).toBe(150);
  });

  it('returns null for zero total', () => {
    expect(computeFundedPercentPrecise('100.00', '0.00')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(computeFundedPercentPrecise('abc', '100.00')).toBeNull();
  });

  it('handles large amounts precisely', () => {
    // 33333.33 / 99999.99 = 0.3333... = 33.33%
    expect(computeFundedPercentPrecise('33333.33', '99999.99')).toBe(33.33);
  });

  it('handles tiny amounts', () => {
    expect(computeFundedPercentPrecise('0.01', '100.00')).toBe(0.01);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Synchronously catches and returns a thrown error; returns null if no throw. */
function catchError(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
