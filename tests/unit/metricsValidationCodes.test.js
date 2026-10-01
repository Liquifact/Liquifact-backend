'use strict';

/**
 * @fileoverview Focused tests for src/constants/metricsValidationCodes.js
 *
 * Scenarios covered
 * ─────────────────
 * Immutability invariants
 *   - Every domain group is frozen (Object.isFrozen)
 *   - VALIDATION_CODES (flat registry) is frozen
 *   - Attempting to write a property in strict mode throws TypeError
 *   - Attempting to add a new property throws TypeError
 *   - Attempting to delete a property throws TypeError
 *
 * Correct string values
 *   - Each code's string value matches its key name exactly (self-describing)
 *   - Spot-check a representative sample from every domain group
 *
 * Shape invariants
 *   - All exported names are present in module.exports
 *   - Every group value is a plain object (not null, not array)
 *   - Every code value is a non-empty string
 *
 * No duplicates across groups
 *   - All code strings in VALIDATION_CODES are globally unique (no two domains
 *     accidentally share a string)
 *
 * All expected codes present
 *   - INVOICE_SM_CODES contains all 11 state-machine codes
 *   - CONFIG_CODES contains all 4 config codes
 *   - STORAGE_CODES contains all 6 storage codes
 *   - ESCROW_CODES contains all 6 escrow codes
 *   - SME_CODES contains all 4 SME codes
 *   - WEBHOOK_CODES contains all 5 webhook codes
 *   - METRICS_AUTH_CODES contains all 3 metrics auth codes
 *
 * Flat registry (VALIDATION_CODES)
 *   - Contains every code from every domain group (union)
 *   - Key name equals value (self-describing)
 *   - Total code count equals sum of all domain group sizes
 *
 * Boundary and misuse scenarios
 *   - Code strings are pure ASCII uppercase with underscores (no spaces, no
 *     lowercase, no special characters)
 *   - Codes from different domains never collide even when imported separately
 *   - Spread into a new object does NOT propagate the freeze to the new object
 *   - Re-requiring the module returns the same frozen reference (module cache)
 *   - Accessing an undefined code returns undefined (no throw)
 *
 * Regression: callers can use codes as error.code values
 *   - An Error constructed with a code from INVOICE_SM_CODES compares equal
 *     using the VALIDATION_CODES flat registry
 *   - An Error constructed with a code from CONFIG_CODES behaves the same
 */

const {
  INVOICE_SM_CODES,
  CONFIG_CODES,
  STORAGE_CODES,
  ESCROW_CODES,
  SME_CODES,
  WEBHOOK_CODES,
  METRICS_AUTH_CODES,
  VALIDATION_CODES,
} = require('../../src/constants/metricsValidationCodes');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect every code string from a group object into an array. */
function values(group) {
  return Object.values(group);
}

/** Assert that a write to a frozen object throws TypeError in strict mode. */
function assertWriteThrows(obj, key) {
  expect(() => {
    'use strict';
    obj[key] = 'TAMPERED';
  }).toThrow(TypeError);
}

/** Assert that adding a new key to a frozen object throws TypeError in strict mode. */
function assertAddThrows(obj) {
  expect(() => {
    'use strict';
    obj.__NEW_KEY__ = 'injected';
  }).toThrow(TypeError);
}

/** Assert that deleting a key from a frozen object throws TypeError in strict mode. */
function assertDeleteThrows(obj, key) {
  expect(() => {
    'use strict';
    delete obj[key];
  }).toThrow(TypeError);
}

// ---------------------------------------------------------------------------
// Immutability invariants
// ---------------------------------------------------------------------------

describe('Immutability — Object.isFrozen', () => {
  test('INVOICE_SM_CODES is frozen', () => {
    expect(Object.isFrozen(INVOICE_SM_CODES)).toBe(true);
  });

  test('CONFIG_CODES is frozen', () => {
    expect(Object.isFrozen(CONFIG_CODES)).toBe(true);
  });

  test('STORAGE_CODES is frozen', () => {
    expect(Object.isFrozen(STORAGE_CODES)).toBe(true);
  });

  test('ESCROW_CODES is frozen', () => {
    expect(Object.isFrozen(ESCROW_CODES)).toBe(true);
  });

  test('SME_CODES is frozen', () => {
    expect(Object.isFrozen(SME_CODES)).toBe(true);
  });

  test('WEBHOOK_CODES is frozen', () => {
    expect(Object.isFrozen(WEBHOOK_CODES)).toBe(true);
  });

  test('METRICS_AUTH_CODES is frozen', () => {
    expect(Object.isFrozen(METRICS_AUTH_CODES)).toBe(true);
  });

  test('VALIDATION_CODES (flat registry) is frozen', () => {
    expect(Object.isFrozen(VALIDATION_CODES)).toBe(true);
  });
});

describe('Immutability — writes throw TypeError in strict mode', () => {
  test('cannot overwrite an existing INVOICE_SM_CODES key', () => {
    assertWriteThrows(INVOICE_SM_CODES, 'INVALID_TRANSITION');
  });

  test('cannot overwrite an existing CONFIG_CODES key', () => {
    assertWriteThrows(CONFIG_CODES, 'CONFIG_MISSING_FIELD');
  });

  test('cannot overwrite an existing STORAGE_CODES key', () => {
    assertWriteThrows(STORAGE_CODES, 'INVALID_FILENAME');
  });

  test('cannot overwrite an existing ESCROW_CODES key', () => {
    assertWriteThrows(ESCROW_CODES, 'INVALID_CONTRACT_ID');
  });

  test('cannot overwrite an existing SME_CODES key', () => {
    assertWriteThrows(SME_CODES, 'SME_NOT_FOUND');
  });

  test('cannot overwrite an existing WEBHOOK_CODES key', () => {
    assertWriteThrows(WEBHOOK_CODES, 'WEBHOOK_DELIVERY_FAILED');
  });

  test('cannot overwrite an existing METRICS_AUTH_CODES key', () => {
    assertWriteThrows(METRICS_AUTH_CODES, 'METRICS_AUTH_REQUIRED');
  });

  test('cannot overwrite an existing VALIDATION_CODES key', () => {
    assertWriteThrows(VALIDATION_CODES, 'INVALID_TRANSITION');
  });
});

describe('Immutability — adding new keys throws TypeError in strict mode', () => {
  test('cannot add new key to INVOICE_SM_CODES', () => {
    assertAddThrows(INVOICE_SM_CODES);
  });

  test('cannot add new key to CONFIG_CODES', () => {
    assertAddThrows(CONFIG_CODES);
  });

  test('cannot add new key to VALIDATION_CODES', () => {
    assertAddThrows(VALIDATION_CODES);
  });
});

describe('Immutability — deleting keys throws TypeError in strict mode', () => {
  test('cannot delete a key from INVOICE_SM_CODES', () => {
    assertDeleteThrows(INVOICE_SM_CODES, 'INVALID_TRANSITION');
  });

  test('cannot delete a key from VALIDATION_CODES', () => {
    assertDeleteThrows(VALIDATION_CODES, 'INVALID_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Correct string values — all codes are self-describing (key === value)
// ---------------------------------------------------------------------------

describe('String values — each code value equals its key name', () => {
  const groups = {
    INVOICE_SM_CODES,
    CONFIG_CODES,
    STORAGE_CODES,
    ESCROW_CODES,
    SME_CODES,
    WEBHOOK_CODES,
    METRICS_AUTH_CODES,
  };

  for (const [groupName, group] of Object.entries(groups)) {
    for (const [key, value] of Object.entries(group)) {
      test(`${groupName}.${key} === '${key}'`, () => {
        expect(value).toBe(key);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Shape invariants
// ---------------------------------------------------------------------------

describe('Shape invariants', () => {
  test('every exported name is present', () => {
    const mod = require('../../src/constants/metricsValidationCodes');
    expect(mod).toHaveProperty('INVOICE_SM_CODES');
    expect(mod).toHaveProperty('CONFIG_CODES');
    expect(mod).toHaveProperty('STORAGE_CODES');
    expect(mod).toHaveProperty('ESCROW_CODES');
    expect(mod).toHaveProperty('SME_CODES');
    expect(mod).toHaveProperty('WEBHOOK_CODES');
    expect(mod).toHaveProperty('METRICS_AUTH_CODES');
    expect(mod).toHaveProperty('VALIDATION_CODES');
  });

  test('every group is a plain non-null non-array object', () => {
    const groups = [
      INVOICE_SM_CODES, CONFIG_CODES, STORAGE_CODES,
      ESCROW_CODES, SME_CODES, WEBHOOK_CODES, METRICS_AUTH_CODES,
      VALIDATION_CODES,
    ];
    for (const g of groups) {
      expect(g !== null).toBe(true);
      expect(typeof g).toBe('object');
      expect(Array.isArray(g)).toBe(false);
    }
  });

  test('every code value is a non-empty string', () => {
    for (const value of Object.values(VALIDATION_CODES)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// All expected codes present
// ---------------------------------------------------------------------------

describe('INVOICE_SM_CODES — all 11 expected codes present', () => {
  const expected = [
    'INVALID_TRANSITION',
    'TERMINAL_STATE',
    'ALREADY_IN_TARGET_STATE',
    'INVALID_CURRENT_STATE',
    'INVALID_TARGET_STATE',
    'MISSING_INVOICE_ID',
    'MISSING_CURRENT_STATE',
    'MISSING_TARGET_STATE',
    'MISSING_ACTOR',
    'MISSING_TRANSITION_REASON',
    'TRANSITION_REASON_TOO_LONG',
  ];

  test('contains exactly 11 codes', () => {
    expect(Object.keys(INVOICE_SM_CODES)).toHaveLength(11);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(INVOICE_SM_CODES).toHaveProperty(code);
    });
  }
});

describe('CONFIG_CODES — all 4 expected codes present', () => {
  const expected = [
    'CONFIG_MISSING_FIELD',
    'CONFIG_VALIDATION_ERROR',
    'CONFIG_PARSE_ERROR',
    'CONFIG_UNEXPECTED_ERROR',
  ];

  test('contains exactly 4 codes', () => {
    expect(Object.keys(CONFIG_CODES)).toHaveLength(4);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(CONFIG_CODES).toHaveProperty(code);
    });
  }
});

describe('STORAGE_CODES — all 6 expected codes present', () => {
  const expected = [
    'INVALID_FILENAME',
    'INVALID_MIME_TYPE',
    'FILE_TOO_LARGE',
    'INVALID_TENANT_ID',
    'INVALID_INVOICE_ID',
    'PRESIGNED_URL_EXPIRY_OUT_OF_RANGE',
  ];

  test('contains exactly 6 codes', () => {
    expect(Object.keys(STORAGE_CODES)).toHaveLength(6);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(STORAGE_CODES).toHaveProperty(code);
    });
  }
});

describe('ESCROW_CODES — all 6 expected codes present', () => {
  const expected = [
    'INVALID_CONTRACT_ID',
    'RPC_ERROR',
    'ESCROW_NOT_FOUND',
    'ESCROW_ALREADY_LINKED',
    'INVALID_ASSET',
    'RECONCILIATION_MISMATCH',
  ];

  test('contains exactly 6 codes', () => {
    expect(Object.keys(ESCROW_CODES)).toHaveLength(6);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(ESCROW_CODES).toHaveProperty(code);
    });
  }
});

describe('SME_CODES — all 4 expected codes present', () => {
  const expected = [
    'SME_NOT_FOUND',
    'SME_KYC_REQUIRED',
    'SME_KYC_REJECTED',
    'SME_METRICS_UNAVAILABLE',
  ];

  test('contains exactly 4 codes', () => {
    expect(Object.keys(SME_CODES)).toHaveLength(4);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(SME_CODES).toHaveProperty(code);
    });
  }
});

describe('WEBHOOK_CODES — all 5 expected codes present', () => {
  const expected = [
    'WEBHOOK_DELIVERY_FAILED',
    'WEBHOOK_SIGNATURE_INVALID',
    'WEBHOOK_TIMESTAMP_STALE',
    'WEBHOOK_PAYLOAD_INVALID',
    'WEBHOOK_TENANT_NOT_FOUND',
  ];

  test('contains exactly 5 codes', () => {
    expect(Object.keys(WEBHOOK_CODES)).toHaveLength(5);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(WEBHOOK_CODES).toHaveProperty(code);
    });
  }
});

describe('METRICS_AUTH_CODES — all 3 expected codes present', () => {
  const expected = [
    'METRICS_AUTH_REQUIRED',
    'METRICS_INVALID_TOKEN',
    'METRICS_NON_LOOPBACK_DENIED',
  ];

  test('contains exactly 3 codes', () => {
    expect(Object.keys(METRICS_AUTH_CODES)).toHaveLength(3);
  });

  for (const code of expected) {
    test(`contains ${code}`, () => {
      expect(METRICS_AUTH_CODES).toHaveProperty(code);
    });
  }
});

// ---------------------------------------------------------------------------
// No duplicates across groups
// ---------------------------------------------------------------------------

describe('Global uniqueness — no two domains share a code string', () => {
  test('all code strings in VALIDATION_CODES are globally unique', () => {
    const allValues = Object.values(VALIDATION_CODES);
    const unique = new Set(allValues);
    expect(unique.size).toBe(allValues.length);
  });

  test('INVOICE_SM_CODES codes do not appear in CONFIG_CODES', () => {
    const configValues = new Set(values(CONFIG_CODES));
    for (const v of values(INVOICE_SM_CODES)) {
      expect(configValues.has(v)).toBe(false);
    }
  });

  test('STORAGE_CODES codes do not appear in ESCROW_CODES', () => {
    const escrowValues = new Set(values(ESCROW_CODES));
    for (const v of values(STORAGE_CODES)) {
      expect(escrowValues.has(v)).toBe(false);
    }
  });

  test('SME_CODES codes do not appear in WEBHOOK_CODES', () => {
    const webhookValues = new Set(values(WEBHOOK_CODES));
    for (const v of values(SME_CODES)) {
      expect(webhookValues.has(v)).toBe(false);
    }
  });

  test('METRICS_AUTH_CODES codes do not appear in any other group', () => {
    const others = new Set([
      ...values(INVOICE_SM_CODES),
      ...values(CONFIG_CODES),
      ...values(STORAGE_CODES),
      ...values(ESCROW_CODES),
      ...values(SME_CODES),
      ...values(WEBHOOK_CODES),
    ]);
    for (const v of values(METRICS_AUTH_CODES)) {
      expect(others.has(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Flat registry (VALIDATION_CODES)
// ---------------------------------------------------------------------------

describe('VALIDATION_CODES flat registry', () => {
  test('contains every code from every domain group', () => {
    const allGroupValues = [
      ...values(INVOICE_SM_CODES),
      ...values(CONFIG_CODES),
      ...values(STORAGE_CODES),
      ...values(ESCROW_CODES),
      ...values(SME_CODES),
      ...values(WEBHOOK_CODES),
      ...values(METRICS_AUTH_CODES),
    ];
    for (const code of allGroupValues) {
      expect(VALIDATION_CODES).toHaveProperty(code, code);
    }
  });

  test('total code count equals sum of all domain group sizes', () => {
    const expectedCount =
      Object.keys(INVOICE_SM_CODES).length +
      Object.keys(CONFIG_CODES).length +
      Object.keys(STORAGE_CODES).length +
      Object.keys(ESCROW_CODES).length +
      Object.keys(SME_CODES).length +
      Object.keys(WEBHOOK_CODES).length +
      Object.keys(METRICS_AUTH_CODES).length;

    expect(Object.keys(VALIDATION_CODES)).toHaveLength(expectedCount);
  });

  test('every key in VALIDATION_CODES has value === key (self-describing)', () => {
    for (const [k, v] of Object.entries(VALIDATION_CODES)) {
      expect(v).toBe(k);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary and misuse scenarios
// ---------------------------------------------------------------------------

describe('Boundary scenarios', () => {
  test('all code strings are uppercase ASCII with underscores only', () => {
    const allowedPattern = /^[A-Z][A-Z0-9_]*$/;
    for (const value of Object.values(VALIDATION_CODES)) {
      expect(allowedPattern.test(value)).toBe(true);
    }
  });

  test('no code string contains a space', () => {
    for (const value of Object.values(VALIDATION_CODES)) {
      expect(value.includes(' ')).toBe(false);
    }
  });

  test('no code string contains lowercase letters', () => {
    for (const value of Object.values(VALIDATION_CODES)) {
      expect(value).toBe(value.toUpperCase());
    }
  });

  test('spreading a frozen group into a new object does NOT freeze the copy', () => {
    const copy = { ...INVOICE_SM_CODES };
    expect(Object.isFrozen(copy)).toBe(false);
    // The copy is mutable — it is NOT the original constant
    copy.NEW_CODE = 'whatever';
    expect(copy.NEW_CODE).toBe('whatever');
    // The original is still intact and unchanged
    expect(INVOICE_SM_CODES.NEW_CODE).toBeUndefined();
  });

  test('re-requiring the module returns the exact same frozen reference', () => {
    const mod2 = require('../../src/constants/metricsValidationCodes');
    expect(mod2.INVOICE_SM_CODES).toBe(INVOICE_SM_CODES);
    expect(mod2.VALIDATION_CODES).toBe(VALIDATION_CODES);
  });

  test('accessing a non-existent code returns undefined (no throw)', () => {
    expect(() => {
      const _ = INVOICE_SM_CODES.COMPLETELY_MADE_UP;
      void _;
    }).not.toThrow();
    expect(INVOICE_SM_CODES.COMPLETELY_MADE_UP).toBeUndefined();
  });

  test('VALIDATION_CODES is not extensible (Object.isExtensible)', () => {
    expect(Object.isExtensible(VALIDATION_CODES)).toBe(false);
  });

  test('each domain group is not extensible', () => {
    const groups = [
      INVOICE_SM_CODES, CONFIG_CODES, STORAGE_CODES,
      ESCROW_CODES, SME_CODES, WEBHOOK_CODES, METRICS_AUTH_CODES,
    ];
    for (const g of groups) {
      expect(Object.isExtensible(g)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — callers can use codes as error.code values
// ---------------------------------------------------------------------------

describe('Regression — Error integration', () => {
  test('an Error with code from INVOICE_SM_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('bad transition'), {
      code: INVOICE_SM_CODES.INVALID_TRANSITION,
    });
    expect(err.code).toBe(VALIDATION_CODES.INVALID_TRANSITION);
    expect(err.code).toBe('INVALID_TRANSITION');
  });

  test('an Error with code from CONFIG_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('missing config'), {
      code: CONFIG_CODES.CONFIG_MISSING_FIELD,
    });
    expect(err.code).toBe(VALIDATION_CODES.CONFIG_MISSING_FIELD);
    expect(err.code).toBe('CONFIG_MISSING_FIELD');
  });

  test('an Error with code from STORAGE_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('bad file'), {
      code: STORAGE_CODES.INVALID_FILENAME,
    });
    expect(err.code).toBe(VALIDATION_CODES.INVALID_FILENAME);
  });

  test('an Error with code from ESCROW_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('rpc down'), {
      code: ESCROW_CODES.RPC_ERROR,
    });
    expect(err.code).toBe(VALIDATION_CODES.RPC_ERROR);
  });

  test('an Error with code from SME_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('kyc needed'), {
      code: SME_CODES.SME_KYC_REQUIRED,
    });
    expect(err.code).toBe(VALIDATION_CODES.SME_KYC_REQUIRED);
  });

  test('an Error with code from WEBHOOK_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('sig mismatch'), {
      code: WEBHOOK_CODES.WEBHOOK_SIGNATURE_INVALID,
    });
    expect(err.code).toBe(VALIDATION_CODES.WEBHOOK_SIGNATURE_INVALID);
  });

  test('an Error with code from METRICS_AUTH_CODES matches via VALIDATION_CODES', () => {
    const err = Object.assign(new Error('no auth'), {
      code: METRICS_AUTH_CODES.METRICS_AUTH_REQUIRED,
    });
    expect(err.code).toBe(VALIDATION_CODES.METRICS_AUTH_REQUIRED);
  });

  test('switch statement on err.code works with named constants', () => {
    const err = Object.assign(new Error('terminal'), {
      code: INVOICE_SM_CODES.TERMINAL_STATE,
    });

    let handled = false;
    switch (err.code) {
      case INVOICE_SM_CODES.TERMINAL_STATE:
        handled = true;
        break;
      default:
        break;
    }
    expect(handled).toBe(true);
  });

  test('codes from separate domain imports are equal to the flat registry', () => {
    // Simulate two different modules that imported different groups
    const fromStateMachine = INVOICE_SM_CODES.ALREADY_IN_TARGET_STATE;
    const fromFlat = VALIDATION_CODES.ALREADY_IN_TARGET_STATE;
    expect(fromStateMachine).toBe(fromFlat);
  });
});
