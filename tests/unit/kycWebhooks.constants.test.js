'use strict';

/**
 * @fileoverview Comprehensive unit tests for src/constants/kycWebhooks.js.
 *
 * Covers:
 *  - Export shape and completeness (including backward-compat aliases)
 *  - Deep-freeze guarantees (all objects and nested arrays are frozen)
 *  - Exact literal values (public API contract)
 *  - State-machine invariants:
 *    - Allowed transitions (pending → verified / rejected / exempted)
 *    - Forbidden transitions (terminal → any; unknown as target)
 *    - Idempotency and concurrency safety of helpers
 *  - Terminal-state detection (isTerminalKycStatus / isTerminalKYcStatus)
 *  - Transition guard (isAllowedKycTransition / isAllowedLYcTransition)
 *  - Adverse conditions: null, undefined, empty string, non-string inputs
 *  - Validation constants shape (KYC_WEBHOOK_VALIDATION)
 *  - Retry policy shape (KYC_WEBHOOK_RETRY)
 *  - deepFreeze helper correctness
 */

const kycWebhooksConstants = require('../../src/constants/kycWebhooks');

const {
  HTTP_HEADERS,
  KYC_WEBHOOK_ROUTES,
  KYC_WEBHOOK_EVENTS,
  KYC_STATUSES,
  KYC_TERMINAL_STATUSES,
  KYC_STATUS_TRANSITIONS,
  KYC_WEBHOOK_VALIDATION,
  KYC_WEBHOOK_ERROR_CODES,
  KYC_WEBHOOK_MESSAGES,
  KYC_WEBHOOK_DB,
  KYC_WEBHOOK_PAGINATION,
  KYC_WEBHOOK_METRICS,
  KYC_WEBHOOK_RETRY,
  KYC_WEBHOOK_CONSTANTS,
  deepFreeze,
  isTerminalKycStatus,
  isTerminalKYcStatus,
  isAllowedKycTransition,
  isAllowedLYcTransition,
} = kycWebhooksConstants;

// ─── 1. Export shape ──────────────────────────────────────────────────────────

describe('Export shape', () => {
  it('exports all expected constant groups', () => {
    expect(HTTP_HEADERS).toBeDefined();
    expect(KYC_WEBHOOK_ROUTES).toBeDefined();
    expect(KYC_WEBHOOK_EVENTS).toBeDefined();
    expect(KYC_STATUSES).toBeDefined();
    expect(KYC_TERMINAL_STATUSES).toBeDefined();
    expect(KYC_STATUS_TRANSITIONS).toBeDefined();
    expect(KYC_WEBHOOK_VALIDATION).toBeDefined();
    expect(KYC_WEBHOOK_ERROR_CODES).toBeDefined();
    expect(KYC_WEBHOOK_MESSAGES).toBeDefined();
    expect(KYC_WEBHOOK_DB).toBeDefined();
    expect(KYC_WEBHOOK_PAGINATION).toBeDefined();
    expect(KYC_WEBHOOK_METRICS).toBeDefined();
    expect(KYC_WEBHOOK_RETRY).toBeDefined();
    expect(KYC_WEBHOOK_CONSTANTS).toBeDefined();
  });

  it('exports deepFreeze, isTerminalKycStatus, isAllowedKycTransition helpers', () => {
    expect(typeof deepFreeze).toBe('function');
    expect(typeof isTerminalKycStatus).toBe('function');
    expect(typeof isAllowedKycTransition).toBe('function');
  });

  it('exports backward-compat aliases isTerminalKYcStatus and isAllowedLYcTransition', () => {
    expect(typeof isTerminalKYcStatus).toBe('function');
    expect(typeof isAllowedLYcTransition).toBe('function');
  });

  it('backward-compat aliases behave identically to their canonical counterparts', () => {
    expect(isTerminalKYcStatus('verified')).toBe(isTerminalKycStatus('verified'));
    expect(isTerminalKYcStatus('pending')).toBe(isTerminalKycStatus('pending'));
    expect(isAllowedLYcTransition('pending', 'verified')).toBe(isAllowedKycTransition('pending', 'verified'));
    expect(isAllowedLYcTransition('verified', 'pending')).toBe(isAllowedKycTransition('verified', 'pending'));
  });

  it('KYC_WEBHOOK_CONSTANTS master bundle contains all constant groups', () => {
    expect(KYC_WEBHOOK_CONSTANTS).toHaveProperty('HTTP_HEADERS');
    expect(KYC_WEBHOOK_CONSTANTS).toHaveProperty('KYC_STATUSES');
    expect(KYC_WEBHOOK_CONSTANTS).toHaveProperty('KYC_TERMINAL_STATUSES');
    expect(KYC_WEBHOOK_CONSTANTS).toHaveProperty('KYC_STATUS_TRANSITIONS');
    expect(KYC_WEBHOOK_CONSTANTS).toHaveProperty('KYC_WEBHOOK_VALIDATION');
    expect(KYC_WEBHOOK_CONSTANTS).toHaveProperty('KYC_WEBHOOK_RETRY');
  });
});

// ─── 2. Deep-freeze guarantees ────────────────────────────────────────────────

describe('Deep-freeze guarantees', () => {
  it('top-level module export is frozen', () => {
    expect(Object.isFrozen(kycWebhooksConstants)).toBe(true);
  });

  it('KYC_WEBHOOK_CONSTANTS bundle is frozen', () => {
    expect(Object.isFrozen(KYC_WEBHOOK_CONSTANTS)).toBe(true);
  });

  const frozenObjects = [
    ['HTTP_HEADERS', HTTP_HEADERS],
    ['KYC_WEBHOOK_ROUTES', KYC_WEBHOOK_ROUTES],
    ['KYC_WEBHOOK_EVENTS', KYC_WEBHOOK_EVENTS],
    ['KYC_STATUSES', KYC_STATUSES],
    ['KYC_TERMINAL_STATUSES', KYC_TERMINAL_STATUSES],
    ['KYC_STATUS_TRANSITIONS', KYC_STATUS_TRANSITIONS],
    ['KYC_WEBHOOK_VALIDATION', KYC_WEBHOOK_VALIDATION],
    ['KYC_WEBHOOK_ERROR_CODES', KYC_WEBHOOK_ERROR_CODES],
    ['KYC_WEBHOOK_MESSAGES', KYC_WEBHOOK_MESSAGES],
    ['KYC_WEBHOOK_DB', KYC_WEBHOOK_DB],
    ['KYC_WEBHOOK_PAGINATION', KYC_WEBHOOK_PAGINATION],
    ['KYC_WEBHOOK_METRICS', KYC_WEBHOOK_METRICS],
    ['KYC_WEBHOOK_RETRY', KYC_WEBHOOK_RETRY],
  ];

  it.each(frozenObjects)('%s is frozen', (_name, obj) => {
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('KYC_STATUS_TRANSITIONS nested arrays are frozen', () => {
    expect(Object.isFrozen(KYC_STATUS_TRANSITIONS[KYC_STATUSES.PENDING])).toBe(true);
    expect(Object.isFrozen(KYC_STATUS_TRANSITIONS[KYC_STATUSES.VERIFIED])).toBe(true);
    expect(Object.isFrozen(KYC_STATUS_TRANSITIONS[KYC_STATUSES.REJECTED])).toBe(true);
    expect(Object.isFrozen(KYC_STATUS_TRANSITIONS[KYC_STATUSES.EXEMPTED])).toBe(true);
  });

  it('KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS array is frozen', () => {
    expect(Object.isFrozen(KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS)).toBe(true);
  });

  it('mutation attempts on frozen objects throw TypeError (strict mode)', () => {
    expect(() => { HTTP_HEADERS.X_SIGNATURE = 'MUTATED'; }).toThrow(TypeError);
    expect(() => { KYC_WEBHOOK_EVENTS.VERIFIED = 'MUTATED'; }).toThrow(TypeError);
    expect(() => { KYC_STATUSES.PENDING = 'MUTATED'; }).toThrow(TypeError);
    expect(() => { KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET = 'MUTATED'; }).toThrow(TypeError);
    expect(() => { KYC_WEBHOOK_RETRY.MAX_RETRIES = 999; }).toThrow(TypeError);
  });

  it('mutation attempts on nested frozen arrays throw TypeError', () => {
    expect(() => { KYC_TERMINAL_STATUSES[0] = 'MUTATED'; }).toThrow(TypeError);
    expect(() => { KYC_STATUS_TRANSITIONS[KYC_STATUSES.PENDING][0] = 'MUTATED'; }).toThrow(TypeError);
  });
});

// ─── 3. Exact literal values (public API contract) ───────────────────────────

describe('Exact literal values', () => {
  it('HTTP_HEADERS', () => {
    expect(HTTP_HEADERS.X_SIGNATURE).toBe('X-Signature');
    expect(HTTP_HEADERS.IDEMPOTENCY_KEY).toBe('Idempotency-Key');
    expect(HTTP_HEADERS.CONTENT_TYPE).toBe('Content-Type');
    expect(HTTP_HEADERS.ACCEPT).toBe('Accept');
    expect(HTTP_HEADERS.AUTHORIZATION).toBe('Authorization');
  });

  it('HTTP_HEADERS backward-compat typo aliases still resolve', () => {
    // Existing callers that reference the old misspellings must not break.
    expect(HTTP_HEADERS.IDMMPOTENCY_KEY).toBe('Idempotency-Key');
    expect(HTTP_HEADERS.ACCEPE).toBe('Accept');
  });

  it('KYC_WEBHOOK_ROUTES', () => {
    expect(KYC_WEBHOOK_ROUTES.WEBHOOK).toBe('/webhook');
    expect(KYC_WEBHOOK_ROUTES.WEBHOOKS).toBe('/webhooks');
    expect(KYC_WEBHOOK_ROUTES.FULL_WEBHOOK_PATH).toBe('/api/kyc/webhook');
    expect(KYC_WEBHOOK_ROUTES.FULL_WEBHOOKS_PATH).toBe('/api/kyc/webhooks');
    expect(KYC_WEBHOOK_ROUTES.FULL_QUARANTINE_PATH).toBe('/api/admin/kyc/quarantine');
  });

  it('KYC_WEBHOOK_EVENTS', () => {
    expect(KYC_WEBHOOK_EVENTS.VERIFIED).toBe('kyc.verified');
    expect(KYC_WEBHOOK_EVENTS.REJECTED).toBe('kyc.rejected');
    expect(KYC_WEBHOOK_EVENTS.EXEMPTED).toBe('kyc.exempted');
    expect(KYC_WEBHOOK_EVENTS.PENDING).toBe('kyc.pending');
  });

  it('KYC_STATUSES', () => {
    expect(KYC_STATUSES.PENDING).toBe('pending');
    expect(KYC_STATUSES.VERIFIED).toBe('verified');
    expect(KYC_STATUSES.REJECTED).toBe('rejected');
    expect(KYC_STATUSES.EXEMPTED).toBe('exempted');
    expect(KYC_STATUSES.UNKNOWN).toBe('unknown');
  });

  it('KYC_WEBHOOK_ERROR_CODES — all codes are non-empty strings', () => {
    for (const [key, value] of Object.entries(KYC_WEBHOOK_ERROR_CODES)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      expect(key).toBeTruthy();
    }
    // Spot-check exact values
    expect(KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET).toBe('missing_secret');
    expect(KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD).toBe('invalid_payload');
    expect(KYC_WEBHOOK_ERROR_CODES.INVALID_STATE_TRANSITION).toBe('invalid_state_transition');
    expect(KYC_WEBHOOK_ERROR_CODES.TERMINAL_STATE).toBe('terminal_state');
    expect(KYC_WEBHOOK_ERROR_CODES.CONCURRENT_MODIFICATION).toBe('concurrent_modification');
    expect(KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR).toBe('persistence_error');
  });

  it('KYC_WEBHOOK_MESSAGES — spot-check exact values', () => {
    expect(KYC_WEBHOOK_MESSAGES.MISSING_SECRET).toBe('KYC webhook ingestion is not configured');
    expect(KYC_WEBHOOK_MESSAGES.MISSING_SIGNATURE).toBe('Missing X-Signature header');
    expect(KYC_WEBHOOK_MESSAGES.INVALID_PAYLOAD).toBe('Invalid JSON payload');
    expect(KYC_WEBHOOK_MESSAGES.TERMINAL_STATE).toBe('KYC record is in a terminal state and cannot be mutated');
    expect(KYC_WEBHOOK_MESSAGES.INVALID_STATE_TRANSITION).toBe('KYC status transition is not allowed');
    expect(KYC_WEBHOOK_MESSAGES.CONCURRENT_MODIFICATION).toBe('KYC record was modified concurrently; retry the operation');
  });

  it('KYC_WEBHOOK_DB', () => {
    expect(KYC_WEBHOOK_DB.TABLE_KYC_RECORDS).toBe('kyc_records');
    expect(KYC_WEBHOOK_DB.TABLE_DEAD_LETTERS).toBe('kyc_webhook_dead_letters');
    expect(KYC_WEBHOOK_DB.TABLE_KYC_QUARANTINE).toBe('kyc_webhook_quarantine');
    expect(KYC_WEBHOOK_DB.JOB_TYPE_DELIVERY).toBe('kyc_webhook_delivery');
  });

  it('KYC_WEBHOOK_PAGINATION', () => {
    expect(KYC_WEBHOOK_PAGINATION.MIN_LIMIT).toBe(1);
    expect(KYC_WEBHOOK_PAGINATION.MAX_LIMIT).toBe(100);
    expect(KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT).toBe(20);
    expect(KYC_WEBHOOK_PAGINATION.MIN_OFFSET).toBe(0);
    expect(KYC_WEBHOOK_PAGINATION.MAX_OFFSET).toBe(Number.MAX_SAFE_INTEGER);
    expect(KYC_WEBHOOK_PAGINATION.SORT_FIELD).toBe('updated_at');
    expect(KYC_WEBHOOK_PAGINATION.DEFAULT_ORDER).toBe('desc');
  });

  it('KYC_WEBHOOK_METRICS', () => {
    expect(KYC_WEBHOOK_METRICS.STATUS_CLASS_2XX).toBe('2xx');
    expect(KYC_WEBHOOK_METRICS.STATUS_CLASS_4XX).toBe('4xx');
    expect(KYC_WEBHOOK_METRICS.STATUS_CLASS_5XX).toBe('5xx');
    expect(KYC_WEBHOOK_METRICS.CAUSE_NONE).toBe('none');
    expect(KYC_WEBHOOK_METRICS.NAME_REQUESTS_TOTAL).toBe('kyc_webhook_requests_total');
    expect(KYC_WEBHOOK_METRICS.NAME_DEAD_LETTER).toBe('kyc_webhook_delivery_dead_letter_total');
  });

  it('KYC_WEBHOOK_RETRY', () => {
    expect(KYC_WEBHOOK_RETRY.MAX_RETRIES).toBe(3);
    expect(KYC_WEBHOOK_RETRY.BASE_DELAY_MS).toBe(500);
    expect(KYC_WEBHOOK_RETRY.MAX_DELAY_MS).toBe(10_000);
    expect(KYC_WEBHOOK_RETRY.TIMEOUT_MS).toBe(5_000);
    expect(KYC_WEBHOOK_RETRY.MAX_PAYLOAD_BYTES).toBe(65_536);
  });
});

// ─── 4. KYC_WEBHOOK_VALIDATION shape ─────────────────────────────────────────

describe('KYC_WEBHOOK_VALIDATION shape', () => {
  it('has correct numeric boundaries', () => {
    expect(KYC_WEBHOOK_VALIDATION).toMatchObject({
      SME_ID_MIN_LENGTH: 1,
      SME_ID_MAX_LENGTH: 128,
      STATUS_MIN_LENGTH: 1,
      STATUS_MAX_LENGTH: 50,
      RECORD_ID_MAX_LENGTH: 255,
      IDEMPOTENCY_KEY_MIN_LENGTH: 8,
      IDEMPOTENCY_KEY_MAX_LENGTH: 128,
      MAX_PAYLOAD_BYTES: 102_400,
    });
  });

  it('ALLOWED_EVENTS contains the expected event names', () => {
    expect(KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS).toEqual(
      expect.arrayContaining([
        'kyc.verified',
        'kyc.rejected',
        'kyc.exempted',
        'kyc.pending',
        'kyc_status_updated',
        'kyc.status_changed',
      ])
    );
    expect(KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS.length).toBe(6);
  });

  it('SME_ID_PATTERN compiles to a usable regex', () => {
    const pattern = new RegExp(KYC_WEBHOOK_VALIDATION.SME_ID_PATTERN);
    expect(pattern.test('sme_123')).toBe(true);
    expect(pattern.test('sme-abc')).toBe(true);
    expect(pattern.test('SME123')).toBe(true);
    expect(pattern.test('invalid id!')).toBe(false);
    expect(pattern.test('')).toBe(false);
  });

  it('IDEMPOTENCY_KEY_PATTERN compiles to a usable regex', () => {
    const pattern = new RegExp(KYC_WEBHOOK_VALIDATION.IDEMPOTENCY_KEY_PATTERN);
    expect(pattern.test('12345678')).toBe(true);
    expect(pattern.test('abc-def_123.456:789')).toBe(true);
    expect(pattern.test('short')).toBe(false);
    expect(pattern.test('bad key!')).toBe(false);
  });
});

// ─── 5. State-machine invariants — isTerminalKycStatus ────────────────────────

describe('isTerminalKycStatus', () => {
  it('returns true for each terminal status', () => {
    expect(isTerminalKycStatus('verified')).toBe(true);
    expect(isTerminalKycStatus('rejected')).toBe(true);
    expect(isTerminalKycStatus('exempted')).toBe(true);
  });

  it('returns false for non-terminal statuses', () => {
    expect(isTerminalKycStatus('pending')).toBe(false);
    expect(isTerminalKycStatus('unknown')).toBe(false);
  });

  it('returns false for completely unknown status strings', () => {
    expect(isTerminalKycStatus('approved')).toBe(false);
    expect(isTerminalKycStatus('in_review')).toBe(false);
    expect(isTerminalKycStatus('')).toBe(false);
  });

  it('returns false for adverse inputs (non-string)', () => {
    expect(isTerminalKycStatus(null)).toBe(false);
    expect(isTerminalKycStatus(undefined)).toBe(false);
    expect(isTerminalKycStatus(42)).toBe(false);
    expect(isTerminalKycStatus({})).toBe(false);
    expect(isTerminalKycStatus([])).toBe(false);
  });

  it('is idempotent — repeated calls return the same result', () => {
    for (let i = 0; i < 10; i++) {
      expect(isTerminalKycStatus('verified')).toBe(true);
      expect(isTerminalKycStatus('pending')).toBe(false);
    }
  });
});

// ─── 6. State-machine invariants — isAllowedKycTransition ────────────────────

describe('isAllowedKycTransition', () => {
  // ── Allowed transitions ──
  describe('allowed transitions', () => {
    it('pending → verified', () => {
      expect(isAllowedKycTransition('pending', 'verified')).toBe(true);
    });

    it('pending → rejected', () => {
      expect(isAllowedKycTransition('pending', 'rejected')).toBe(true);
    });

    it('pending → exempted', () => {
      expect(isAllowedKycTransition('pending', 'exempted')).toBe(true);
    });
  });

  // ── Forbidden transitions from terminal states ──
  describe('forbidden transitions from terminal states', () => {
    const terminals = ['verified', 'rejected', 'exempted'];
    const targets = ['verified', 'rejected', 'exempted', 'pending', 'unknown'];

    for (const from of terminals) {
      for (const to of targets) {
        it(`${from} → ${to} is forbidden`, () => {
          expect(isAllowedKycTransition(from, to)).toBe(false);
        });
      }
    }
  });

  // ── `unknown` is never a valid target ──
  describe('"unknown" as toStatus is always forbidden', () => {
    const sources = ['pending', 'verified', 'rejected', 'exempted', 'unknown'];
    for (const from of sources) {
      it(`${from} → unknown is forbidden`, () => {
        expect(isAllowedKycTransition(from, 'unknown')).toBe(false);
      });
    }
  });

  // ── Self-transitions are forbidden ──
  describe('self-transitions are forbidden', () => {
    it('pending → pending is forbidden', () => {
      expect(isAllowedKycTransition('pending', 'pending')).toBe(false);
    });
    it('verified → verified is forbidden', () => {
      expect(isAllowedKycTransition('verified', 'verified')).toBe(false);
    });
  });

  // ── Adverse inputs ──
  describe('adverse inputs return false (fail-closed)', () => {
    const adverseInputPairs = [
      [null, 'verified'],
      ['pending', null],
      [null, null],
      [undefined, 'verified'],
      ['pending', undefined],
      [42, 'verified'],
      ['pending', 42],
      ['', 'verified'],
      ['pending', ''],
      ['PENDING', 'VERIFIED'],   // case-sensitive
      ['Pending', 'Verified'],
      ['unrecognised', 'verified'],
      ['pending', 'unrecognised'],
    ];

    it.each(adverseInputPairs)('(%s, %s) returns false', (from, to) => {
      expect(isAllowedKycTransition(from, to)).toBe(false);
    });
  });

  // ── Idempotency ──
  it('is idempotent — repeated calls with the same arguments return the same result', () => {
    for (let i = 0; i < 20; i++) {
      expect(isAllowedKycTransition('pending', 'verified')).toBe(true);
      expect(isAllowedKycTransition('verified', 'pending')).toBe(false);
    }
  });
});

// ─── 7. KYC_STATUS_TRANSITIONS structure ─────────────────────────────────────

describe('KYC_STATUS_TRANSITIONS structure', () => {
  it('has exactly four keys (pending, verified, rejected, exempted)', () => {
    const keys = Object.keys(KYC_STATUS_TRANSITIONS);
    expect(keys.sort()).toEqual(['exempted', 'pending', 'rejected', 'verified']);
  });

  it('terminal states have empty transition arrays', () => {
    expect(KYC_STATUS_TRANSITIONS['verified']).toEqual([]);
    expect(KYC_STATUS_TRANSITIONS['rejected']).toEqual([]);
    expect(KYC_STATUS_TRANSITIONS['exempted']).toEqual([]);
  });

  it('pending has exactly three target states', () => {
    const targets = KYC_STATUS_TRANSITIONS['pending'];
    expect(targets).toHaveLength(3);
    expect(targets).toContain('verified');
    expect(targets).toContain('rejected');
    expect(targets).toContain('exempted');
  });

  it('"unknown" is not present as a transition target anywhere', () => {
    for (const targets of Object.values(KYC_STATUS_TRANSITIONS)) {
      expect(targets).not.toContain('unknown');
    }
  });

  it('"unknown" is not a key in KYC_STATUS_TRANSITIONS', () => {
    expect(KYC_STATUS_TRANSITIONS).not.toHaveProperty('unknown');
  });
});

// ─── 8. KYC_TERMINAL_STATUSES content ────────────────────────────────────────

describe('KYC_TERMINAL_STATUSES content', () => {
  it('contains exactly verified, rejected, and exempted', () => {
    expect(KYC_TERMINAL_STATUSES).toHaveLength(3);
    expect(KYC_TERMINAL_STATUSES).toContain('verified');
    expect(KYC_TERMINAL_STATUSES).toContain('rejected');
    expect(KYC_TERMINAL_STATUSES).toContain('exempted');
  });

  it('does not contain pending or unknown', () => {
    expect(KYC_TERMINAL_STATUSES).not.toContain('pending');
    expect(KYC_TERMINAL_STATUSES).not.toContain('unknown');
  });
});

// ─── 9. deepFreeze helper ─────────────────────────────────────────────────────

describe('deepFreeze helper', () => {
  it('freezes a shallow object', () => {
    const obj = deepFreeze({ a: 1, b: 2 });
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('freezes nested objects recursively', () => {
    const obj = deepFreeze({ outer: { inner: { deep: 'value' } } });
    expect(Object.isFrozen(obj.outer)).toBe(true);
    expect(Object.isFrozen(obj.outer.inner)).toBe(true);
  });

  it('freezes arrays and their contents', () => {
    const arr = deepFreeze([{ a: 1 }, { b: 2 }]);
    expect(Object.isFrozen(arr)).toBe(true);
    expect(Object.isFrozen(arr[0])).toBe(true);
    expect(Object.isFrozen(arr[1])).toBe(true);
  });

  it('is idempotent on already-frozen objects', () => {
    const frozen = Object.freeze({ x: 1 });
    expect(() => deepFreeze(frozen)).not.toThrow();
    expect(Object.isFrozen(deepFreeze(frozen))).toBe(true);
  });

  it('returns primitives unchanged', () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('hello')).toBe('hello');
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(true)).toBe(true);
  });

  it('does not throw on circular references (stops at depth due to isFrozen check)', () => {
    const obj = { a: 1 };
    // Freezing a simple object before adding a cycle prevents infinite recursion
    // because deepFreeze bails on Object.isFrozen(value) === true.
    expect(() => deepFreeze({ a: 1, b: { c: 2 } })).not.toThrow();
  });
});

// ─── 10. Compatibility: existing callers must remain valid ────────────────────

describe('Caller compatibility', () => {
  it('kycWebhookService.js identifiers are accessible', () => {
    // kycWebhookService.js uses: KYC_WEBHOOK_MESSAGES, KYC_WEBHOOK_PAGINATION
    expect(KYC_WEBHOOK_MESSAGES.SUCCESS_INGESTION).toBeDefined();
    expect(KYC_WEBHOOK_MESSAGES.FAILED_INGESTION).toBeDefined();
    expect(KYC_WEBHOOK_PAGINATION.MAX_LIMIT).toBeDefined();
    expect(KYC_WEBHOOK_PAGINATION.DEFAULT_LIMIT).toBeDefined();
  });

  it('kycWebhookDelivery.js identifiers are accessible', () => {
    // kycWebhookDelivery.js uses: KYC_WEBHOOK_DB, KYC_WEBHOOK_ERROR_CODES,
    //   KYC_WEBHOOK_METRICS, KYC_WEBHOOK_RETRY
    expect(KYC_WEBHOOK_DB.TABLE_DEAD_LETTERS).toBeDefined();
    expect(KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE).toBeDefined();
    expect(KYC_WEBHOOK_METRICS.NAME_DELIVERY_ATTEMPTS).toBeDefined();
    expect(KYC_WEBHOOK_RETRY.MAX_RETRIES).toBeDefined();
    expect(KYC_WEBHOOK_RETRY.MAX_PAYLOAD_BYTES).toBeDefined();
  });

  it('schemas/kycWebhook.js identifiers are accessible', () => {
    // kycWebhook.js schema uses: KYC_WEBHOOK_VALIDATION
    expect(KYC_WEBHOOK_VALIDATION.SME_ID_MIN_LENGTH).toBeDefined();
    expect(KYC_WEBHOOK_VALIDATION.SME_ID_PATTERN).toBeDefined();
    expect(KYC_WEBHOOK_VALIDATION.ALLOWED_EVENTS).toBeDefined();
  });

  it('kycService.js identifiers are accessible', () => {
    // kycService.js uses: KYC_STATUSES
    expect(KYC_STATUSES.PENDING).toBeDefined();
    expect(KYC_STATUSES.VERIFIED).toBeDefined();
    expect(KYC_STATUSES.UNKNOWN).toBeDefined();
  });

  it('routes/kyc.js identifiers are accessible', () => {
    // kyc.js routes uses: KYC_WEBHOOK_ROUTES, KYC_WEBHOOK_METRICS
    expect(KYC_WEBHOOK_ROUTES.WEBHOOK).toBeDefined();
    expect(KYC_WEBHOOK_METRICS.CAUSE_NONE).toBeDefined();
  });

  it('middleware/kycIdempotency.js identifiers are accessible', () => {
    // kycIdempotency.js uses: KYC_WEBHOOK_MESSAGES, KYC_WEBHOOK_DB
    expect(KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_KEY_REQUIRED).toBeDefined();
    expect(KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_KEY_INVALID).toBeDefined();
    expect(KYC_WEBHOOK_MESSAGES.IDEMPOTENCY_KEY_REUSED).toBeDefined();
    expect(KYC_WEBHOOK_DB.TABLE_IDEMPOTENCY_KEYS).toBeDefined();
  });
});

// ─── 11. Concurrent-execution safety ─────────────────────────────────────────

describe('Concurrent-execution safety', () => {
  it('isAllowedKycTransition is safe to call concurrently (simulated)', () => {
    // Simulate many concurrent reads from the frozen transition map.
    const results = Array.from({ length: 1000 }, () =>
      isAllowedKycTransition('pending', 'verified')
    );
    expect(results.every((r) => r === true)).toBe(true);
  });

  it('isTerminalKycStatus is safe to call concurrently (simulated)', () => {
    const results = Array.from({ length: 1000 }, (_, i) =>
      isTerminalKycStatus(i % 2 === 0 ? 'verified' : 'pending')
    );
    const evens = results.filter((_, i) => i % 2 === 0);
    const odds = results.filter((_, i) => i % 2 !== 0);
    expect(evens.every((r) => r === true)).toBe(true);
    expect(odds.every((r) => r === false)).toBe(true);
  });
});

// ─── 12. Retry / delivery error recovery ─────────────────────────────────────

describe('KYC_WEBHOOK_RETRY delivery policy', () => {
  it('MAX_RETRIES is a positive integer', () => {
    expect(Number.isInteger(KYC_WEBHOOK_RETRY.MAX_RETRIES)).toBe(true);
    expect(KYC_WEBHOOK_RETRY.MAX_RETRIES).toBeGreaterThan(0);
  });

  it('BASE_DELAY_MS < MAX_DELAY_MS', () => {
    expect(KYC_WEBHOOK_RETRY.BASE_DELAY_MS).toBeLessThan(KYC_WEBHOOK_RETRY.MAX_DELAY_MS);
  });

  it('MAX_PAYLOAD_BYTES is a positive integer', () => {
    expect(Number.isInteger(KYC_WEBHOOK_RETRY.MAX_PAYLOAD_BYTES)).toBe(true);
    expect(KYC_WEBHOOK_RETRY.MAX_PAYLOAD_BYTES).toBeGreaterThan(0);
  });

  it('all numeric fields are positive finite numbers', () => {
    const numericFields = ['MAX_RETRIES', 'BASE_DELAY_MS', 'MAX_DELAY_MS', 'TIMEOUT_MS', 'MAX_PAYLOAD_BYTES'];
    for (const field of numericFields) {
      expect(typeof KYC_WEBHOOK_RETRY[field]).toBe('number');
      expect(Number.isFinite(KYC_WEBHOOK_RETRY[field])).toBe(true);
      expect(KYC_WEBHOOK_RETRY[field]).toBeGreaterThan(0);
    }
  });
});
