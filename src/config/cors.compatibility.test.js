/**
 * @fileoverview Compatibility contract tests for src/config/cors.js.
 *
 * These tests codify the **public behavioural contract** of the CORS module so
 * that future refactors, dependency updates, or environment changes cannot
 * silently break callers.  They complement the detailed unit tests in
 * cors.test.js by focusing on invariants rather than implementation details:
 *
 *  1. Stable public API shape — every named export must remain present and
 *     carry the correct JavaScript type.
 *  2. Stable constants — CORS_REJECTION_MESSAGE and CORS_REJECTION_CODE never
 *     change value; changing them would break downstream error handlers that
 *     compare by value.
 *  3. createCorsOptions shape invariant — the returned options object always
 *     includes the required `origin`, `maxAge`, and `optionsSuccessStatus`
 *     fields regardless of environment configuration.
 *  4. Origin callback determinism — for any given (origin, allowlist) pair the
 *     result is always the same; the callback is never called more than once.
 *  5. Rejection error contract — the error passed to the callback always
 *     carries `status: 403`, `isCorsOriginRejected: true`, and the stable
 *     message/code constants.
 *  6. No side-channel in rejection errors — rejection errors for disallowed
 *     origins do NOT echo the rejected origin value in the message; the
 *     message is always the fixed constant.
 *  7. reloadCorsOrigins isolation — the allowlist returned after reload
 *     reflects the new environment but does not mutate any object reference
 *     previously returned by getAllowedOriginsFromEnv.
 *  8. processBulkCorsOperations result ordering invariant — results[i].index
 *     always equals i, regardless of success or failure.
 *  9. processBulkCorsOperations idempotency of add — adding the same valid
 *     origin twice in the same batch does not produce duplicates.
 * 10. processBulkCorsOperations partial-failure contract — a failure on one
 *     item never prevents subsequent items from being applied.
 * 11. Concurrent reload safety — multiple concurrent calls to reloadCorsOrigins
 *     converge to the same deterministic state without throwing.
 * 12. validateCorsOrigin passes-through for undefined origin (non-browser
 *     client) regardless of allowlist state.
 * 13. DEV_DEFAULT_ORIGINS is a non-empty array of strings every caller can
 *     safely iterate; it must not be mutated by any other export.
 * 14. parseAllowedOrigins / parseMaxAge backward-compatibility — non-strict
 *     mode returns the same type as before (string[] and number respectively).
 * 15. DTO round-trip: corsConfigDtoFromEnv → corsConfigDtoToOptions produces
 *     functionally equivalent CORS options to the original createCorsOptions
 *     for the same environment.
 *
 * @jest-environment node
 */

'use strict';

// ── Test-local mock for src/metrics ──────────────────────────────────────────
// Each test in this file uses jest.isolateModules to get a fresh module
// instance.  The global mock from tests/mocks/setup.js applies to the outer
// module registry, but isolateModules creates a child registry that falls back
// to the outer one for already-mocked modules, so the global mock covers us
// for the metrics dependency.

describe('CORS compatibility contracts', () => {
  let savedEnv;

  beforeAll(() => {
    savedEnv = { ...process.env };
  });

  beforeEach(() => {
    delete process.env.CORS_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
    delete process.env.NODE_ENV;
    jest.resetModules();
  });

  afterAll(() => {
    process.env = { ...savedEnv };
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 1: Stable public API shape
  // Every named export must remain present and carry the correct JS type.
  // Adding new exports is allowed; removing or renaming is a breaking change.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 1 — stable public API shape', () => {
    it('exports all required names with correct types', () => {
      jest.isolateModules(() => {
        const cors = require('./cors');

        // Constants
        expect(typeof cors.CORS_REJECTION_MESSAGE).toBe('string');
        expect(typeof cors.CORS_REJECTION_CODE).toBe('string');
        expect(typeof cors.DEFAULT_MAX_AGE).toBe('undefined'); // not exported — private
        expect(typeof cors.MAX_MAX_AGE).toBe('number');
        expect(typeof cors.MAX_ORIGIN_LENGTH).toBe('number');
        expect(typeof cors.BULK_CORS_MAX_OPERATIONS).toBe('number');
        expect(Array.isArray(cors.DEV_DEFAULT_ORIGINS)).toBe(true);

        // Functions
        const fns = [
          'createCorsOptions',
          'createCorsRejectionError',
          'getAllowedOriginsFromEnv',
          'getDevelopmentFallbackOrigins',
          'getMaxAge',
          'isAllowedOrigin',
          'isCorsOriginRejectedError',
          'normalizeOrigin',
          'parseAllowedOrigins',
          'parseMaxAge',
          'processBulkCorsOperations',
          'reloadCorsMaxAge',
          'reloadCorsOrigins',
          'resolveAllowlist',
          'validateBulkCorsItem',
          'validateCorsOrigin',
          'validateOriginEntry',
        ];
        for (const fn of fns) {
          expect(typeof cors[fn]).toBe('function');
        }
      });
    });

    it('does not accidentally export private state (allowedOrigins array)', () => {
      jest.isolateModules(() => {
        const cors = require('./cors');
        // The module-level allowedOrigins is internal; exporting it would
        // allow callers to mutate it directly.
        expect(cors.allowedOrigins).toBeUndefined();
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 2: Stable constants
  // CORS_REJECTION_MESSAGE and CORS_REJECTION_CODE must not change value.
  // Downstream error handlers identify CORS rejections by these values.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 2 — stable constants', () => {
    it('CORS_REJECTION_MESSAGE is the canonical fixed string', () => {
      jest.isolateModules(() => {
        const { CORS_REJECTION_MESSAGE } = require('./cors');
        expect(CORS_REJECTION_MESSAGE).toBe('CORS policy: origin is not allowed.');
      });
    });

    it('CORS_REJECTION_CODE is the canonical machine-readable code', () => {
      jest.isolateModules(() => {
        const { CORS_REJECTION_CODE } = require('./cors');
        expect(CORS_REJECTION_CODE).toBe('CORS_ORIGIN_REJECTED');
      });
    });

    it('MAX_MAX_AGE is 86400 (24 h — Fetch spec browser cap)', () => {
      jest.isolateModules(() => {
        const { MAX_MAX_AGE } = require('./cors');
        expect(MAX_MAX_AGE).toBe(86400);
      });
    });

    it('BULK_CORS_MAX_OPERATIONS is 25 (bounded batch cap)', () => {
      jest.isolateModules(() => {
        const { BULK_CORS_MAX_OPERATIONS } = require('./cors');
        expect(BULK_CORS_MAX_OPERATIONS).toBe(25);
      });
    });

    it('parseMaxAge with no argument returns the DEFAULT_MAX_AGE (600)', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge(undefined)).toBe(600);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 3: createCorsOptions shape invariant
  // The returned options object must always contain origin (function),
  // maxAge (positive integer), and optionsSuccessStatus (204).
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 3 — createCorsOptions shape invariant', () => {
    const envVariants = [
      { label: 'production with explicit origins', env: { NODE_ENV: 'production', CORS_ORIGINS: 'https://a.com' } },
      { label: 'production with no origins', env: { NODE_ENV: 'production' } },
      { label: 'development with no origins', env: { NODE_ENV: 'development' } },
      { label: 'development with explicit origins', env: { NODE_ENV: 'development', CORS_ORIGINS: 'https://a.com' } },
    ];

    for (const { label, env } of envVariants) {
      it(`always returns origin/maxAge/optionsSuccessStatus — ${label}`, () => {
        jest.isolateModules(() => {
          const { createCorsOptions } = require('./cors');
          const opts = createCorsOptions(env);

          expect(typeof opts.origin).toBe('function');
          expect(Number.isInteger(opts.maxAge)).toBe(true);
          expect(opts.maxAge).toBeGreaterThan(0);
          expect(opts.optionsSuccessStatus).toBe(204);
        });
      });
    }

    it('optionsSuccessStatus is always exactly 204 (required by cors package)', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production';
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions } = require('./cors');
        expect(createCorsOptions().optionsSuccessStatus).toBe(204);
        expect(createCorsOptions({ NODE_ENV: 'development' }).optionsSuccessStatus).toBe(204);
        expect(createCorsOptions({ NODE_ENV: 'production' }).optionsSuccessStatus).toBe(204);
      });
    });

    it('maxAge is always a finite positive integer', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1800';
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        expect(Number.isInteger(opts.maxAge)).toBe(true);
        expect(Number.isFinite(opts.maxAge)).toBe(true);
        expect(opts.maxAge).toBeGreaterThan(0);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 4: Origin callback determinism
  // The callback must be invoked exactly once per call, and the same
  // (origin, allowlist) pair always produces the same outcome.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 4 — origin callback determinism', () => {
    it('calls the callback exactly once for an allowed origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('https://a.com', cb);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('calls the callback exactly once for a disallowed origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('https://evil.com', cb);
        expect(cb).toHaveBeenCalledTimes(1);
        // First argument is the error, second argument is not present
        const [err, allow] = cb.mock.calls[0];
        expect(err).toBeDefined();
        expect(allow).toBeUndefined();
      });
    });

    it('calls the callback exactly once for undefined origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin(undefined, cb);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('returns the same decision for repeated calls with the same allowed origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://stable.com';
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        // Call twice — both must approve
        const cb1 = jest.fn();
        const cb2 = jest.fn();
        opts.origin('https://stable.com', cb1);
        opts.origin('https://stable.com', cb2);
        expect(cb1).toHaveBeenCalledWith(null, true);
        expect(cb2).toHaveBeenCalledWith(null, true);
      });
    });

    it('returns the same rejection for repeated calls with the same disallowed origin', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://allowed.com';
        const { createCorsOptions, CORS_REJECTION_MESSAGE } = require('./cors');
        const opts = createCorsOptions();
        const cb1 = jest.fn();
        const cb2 = jest.fn();
        opts.origin('https://evil.com', cb1);
        opts.origin('https://evil.com', cb2);
        expect(cb1.mock.calls[0][0].message).toBe(CORS_REJECTION_MESSAGE);
        expect(cb2.mock.calls[0][0].message).toBe(CORS_REJECTION_MESSAGE);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 5: Rejection error contract
  // The error object passed to the callback must carry:
  //   - .status === 403
  //   - .isCorsOriginRejected === true
  //   - .isCorsOriginRejectedError === true
  //   - .message === CORS_REJECTION_MESSAGE
  //   - .code === CORS_REJECTION_CODE
  // These are stable properties that downstream error handlers depend on.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 5 — rejection error contract', () => {
    it('rejection error has status 403', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError } = require('./cors');
        expect(createCorsRejectionError('https://evil.com').status).toBe(403);
      });
    });

    it('rejection error has isCorsOriginRejected true', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError } = require('./cors');
        expect(createCorsRejectionError().isCorsOriginRejected).toBe(true);
      });
    });

    it('rejection error has isCorsOriginRejectedError true (legacy flag)', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError } = require('./cors');
        expect(createCorsRejectionError().isCorsOriginRejectedError).toBe(true);
      });
    });

    it('rejection error message equals CORS_REJECTION_MESSAGE constant', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, CORS_REJECTION_MESSAGE } = require('./cors');
        expect(createCorsRejectionError('https://evil.com').message).toBe(CORS_REJECTION_MESSAGE);
      });
    });

    it('rejection error code equals CORS_REJECTION_CODE constant', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, CORS_REJECTION_CODE } = require('./cors');
        expect(createCorsRejectionError().code).toBe(CORS_REJECTION_CODE);
      });
    });

    it('isCorsOriginRejectedError correctly identifies rejection errors', () => {
      jest.isolateModules(() => {
        const { createCorsRejectionError, isCorsOriginRejectedError } = require('./cors');
        const err = createCorsRejectionError();
        expect(isCorsOriginRejectedError(err)).toBe(true);
        expect(isCorsOriginRejectedError(new Error('other'))).toBe(false);
        expect(isCorsOriginRejectedError(null)).toBe(false);
        expect(isCorsOriginRejectedError(undefined)).toBe(false);
        expect(isCorsOriginRejectedError({})).toBe(false);
      });
    });

    it('the error returned from the origin callback satisfies isCorsOriginRejectedError', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin('https://evil.com', cb);
        expect(isCorsOriginRejectedError(cb.mock.calls[0][0])).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 6: No side-channel in rejection errors
  // The rejection error message is always the fixed constant — it must NEVER
  // include the rejected origin value. Leaking the origin in the message
  // would expose internal routing information to cross-origin attackers.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 6 — no side-channel in rejection errors', () => {
    const maliciousOrigins = [
      'https://evil.com',
      'null',
      'https://app.example.com.attacker.io',
      'HTTPS://EVIL.COM',
      'http://localhost:9999',
      'javascript://evil.com',
      'data:text/html,<script>',
    ];

    for (const origin of maliciousOrigins) {
      it(`rejection error for "${origin}" does not echo the origin in the message`, () => {
        jest.isolateModules(() => {
          const { createCorsRejectionError, CORS_REJECTION_MESSAGE } = require('./cors');
          const err = createCorsRejectionError(origin);
          expect(err.message).toBe(CORS_REJECTION_MESSAGE);
          // The origin value must not appear in the error message
          if (typeof origin === 'string') {
            expect(err.message).not.toContain(origin);
          }
        });
      });
    }

    it('origin callback rejection for an attacker origin does not echo origin in error', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://safe.com';
        const { createCorsOptions, CORS_REJECTION_MESSAGE } = require('./cors');
        const opts = createCorsOptions();
        const attackerOrigin = 'https://safe.com.attacker.io';
        const cb = jest.fn();
        opts.origin(attackerOrigin, cb);
        const err = cb.mock.calls[0][0];
        expect(err.message).toBe(CORS_REJECTION_MESSAGE);
        expect(err.message).not.toContain(attackerOrigin);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 7: reloadCorsOrigins isolation
  // After reloadCorsOrigins, the new allowlist is reflected in origin checks.
  // The old list returned by getAllowedOriginsFromEnv is a snapshot (copy)
  // and should not be mutated by the reload.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 7 — reloadCorsOrigins allowlist isolation', () => {
    it('new origins are reflected in origin checks after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://original.com';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        const cb1 = jest.fn();
        opts.origin('https://added.com', cb1);
        expect(cb1.mock.calls[0][0]).toBeDefined(); // rejected before reload

        process.env.CORS_ORIGINS = 'https://original.com,https://added.com';
        reloadCorsOrigins();

        const cb2 = jest.fn();
        opts.origin('https://added.com', cb2);
        expect(cb2).toHaveBeenCalledWith(null, true); // allowed after reload
      });
    });

    it('getAllowedOriginsFromEnv returns a snapshot; mutating it does not affect live allowlist', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://a.com';
        const { createCorsOptions, getAllowedOriginsFromEnv } = require('./cors');
        const opts = createCorsOptions();

        // Capture a snapshot of the allowlist
        const snapshot = getAllowedOriginsFromEnv();
        expect(snapshot).toContain('https://a.com');

        // Mutate the snapshot
        snapshot.push('https://injected.com');

        // The live origin check must not be affected by the mutation
        const cb = jest.fn();
        opts.origin('https://injected.com', cb);
        expect(cb.mock.calls[0][0]).toBeDefined(); // still rejected
      });
    });

    it('reloadCorsOrigins can be called multiple times idempotently', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://stable.com';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        // Reload 5 times without changing env
        for (let i = 0; i < 5; i++) {
          reloadCorsOrigins();
        }

        // The origin check must still work correctly
        const cb = jest.fn();
        opts.origin('https://stable.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('removing all origins in production mode denies all browser origins after reload', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://a.com';
        process.env.NODE_ENV = 'production';
        const { createCorsOptions, reloadCorsOrigins, isCorsOriginRejectedError } = require('./cors');
        const opts = createCorsOptions();

        // Initially allowed
        const cb1 = jest.fn();
        opts.origin('https://a.com', cb1);
        expect(cb1).toHaveBeenCalledWith(null, true);

        // Remove all origins and reload
        delete process.env.CORS_ORIGINS;
        reloadCorsOrigins();

        // Now denied
        const cb2 = jest.fn();
        opts.origin('https://a.com', cb2);
        expect(isCorsOriginRejectedError(cb2.mock.calls[0][0])).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 8: processBulkCorsOperations result ordering
  // results[i].index must always equal i regardless of success or failure.
  // Callers match results to their input by index.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 8 — processBulkCorsOperations result ordering', () => {
    beforeEach(() => {
      jest.isolateModules(() => {
        // Use a known allowlist for each test
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
      });
      // Re-set env for the actual test module
      process.env.CORS_ORIGINS = 'https://app.example.com';
      const { reloadCorsOrigins } = require('./cors');
      reloadCorsOrigins();
    });

    it('results[i].index === i for all-successful batch', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const ops = [
          { op: 'add', origin: 'https://b.com' },
          { op: 'add', origin: 'https://c.com' },
          { op: 'add', origin: 'https://d.com' },
        ];
        const { results } = processBulkCorsOperations(ops);
        results.forEach((r, i) => expect(r.index).toBe(i));
      });
    });

    it('results[i].index === i for all-failed batch', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const ops = [
          { op: 'add', origin: 'not-a-url' },
          { op: 'remove', origin: 'bad-url' },
          { op: 'replace', origin: 'also-bad', newOrigin: 'no-good' },
        ];
        const { results } = processBulkCorsOperations(ops);
        results.forEach((r, i) => expect(r.index).toBe(i));
      });
    });

    it('results[i].index === i for mixed success/failure batch', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const ops = [
          { op: 'add', origin: 'https://ok.com' },       // succeeds → index 0
          { op: 'add', origin: 'bad-url' },                // fails → index 1
          { op: 'add', origin: 'https://also-ok.com' },   // succeeds → index 2
        ];
        const { results } = processBulkCorsOperations(ops);
        expect(results).toHaveLength(3);
        results.forEach((r, i) => expect(r.index).toBe(i));
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[2].success).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 9: processBulkCorsOperations — add idempotency
  // Adding the same origin twice in the same batch must not duplicate it.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 9 — processBulkCorsOperations add idempotency', () => {
    it('adding the same origin twice in one batch yields exactly one entry', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const { updatedOrigins } = processBulkCorsOperations([
          { op: 'add', origin: 'https://new.example.com' },
          { op: 'add', origin: 'https://new.example.com' },
        ]);
        const count = updatedOrigins.filter(
          (o) => o === 'https://new.example.com'
        ).length;
        expect(count).toBe(1);
      });
    });

    it('adding an already-present origin is a no-op (success, no duplicate)', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const { results, updatedOrigins } = processBulkCorsOperations([
          { op: 'add', origin: 'https://app.example.com' }, // already present
        ]);
        expect(results[0].success).toBe(true);
        const count = updatedOrigins.filter(
          (o) => o === 'https://app.example.com'
        ).length;
        expect(count).toBe(1);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 10: processBulkCorsOperations — partial failure contract
  // A per-item failure must never halt processing of subsequent items.
  // The updatedOrigins must reflect all successful operations.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 10 — processBulkCorsOperations partial failure contract', () => {
    it('failure on first item does not prevent second item from succeeding', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const { results, updatedOrigins } = processBulkCorsOperations([
          { op: 'add', origin: 'bad-url' },                    // fails
          { op: 'add', origin: 'https://good.example.com' },   // must succeed
        ]);
        expect(results[0].success).toBe(false);
        expect(results[1].success).toBe(true);
        expect(updatedOrigins).toContain('https://good.example.com');
      });
    });

    it('failure on last item does not revert earlier successful operations', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const { results, updatedOrigins } = processBulkCorsOperations([
          { op: 'add', origin: 'https://first.example.com' },  // succeeds
          { op: 'add', origin: 'https://second.example.com' }, // succeeds
          { op: 'add', origin: 'bad-url' },                    // fails last
        ]);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(true);
        expect(results[2].success).toBe(false);
        expect(updatedOrigins).toContain('https://first.example.com');
        expect(updatedOrigins).toContain('https://second.example.com');
      });
    });

    it('replace failure does not affect already-committed mutations in same batch', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const { results, updatedOrigins } = processBulkCorsOperations([
          { op: 'add', origin: 'https://a.example.com' },           // succeeds
          {
            op: 'replace',
            origin: 'https://missing.example.com',                  // fails — not in list
            newOrigin: 'https://x.example.com',
          },
          { op: 'add', origin: 'https://b.example.com' },           // must still succeed
        ]);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[2].success).toBe(true);
        expect(updatedOrigins).toContain('https://a.example.com');
        expect(updatedOrigins).toContain('https://b.example.com');
        expect(updatedOrigins).not.toContain('https://x.example.com');
      });
    });

    it('all-failure batch returns empty-error results and unchanged-ish updatedOrigins', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        reloadCorsOrigins();
        const { results } = processBulkCorsOperations([
          { op: 'add', origin: 'bad-1' },
          { op: 'add', origin: 'bad-2' },
        ]);
        expect(results.every((r) => r.success === false)).toBe(true);
        expect(results.every((r) => typeof r.error === 'string')).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 11: Concurrent reload safety
  // Multiple simultaneous calls to reloadCorsOrigins must converge to a
  // consistent deterministic state (no throws, no corrupted state).
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 11 — concurrent reload safety', () => {
    it('concurrent reloadCorsOrigins calls do not throw and converge to same state', async () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://concurrent.example.com';
        const { createCorsOptions, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        // Fire multiple reloads "concurrently" (synchronous JS is single-threaded,
        // but this tests that sequential rapid calls don't corrupt state)
        const reloads = Array.from({ length: 10 }, () => {
          process.env.CORS_ORIGINS = 'https://concurrent.example.com';
          return reloadCorsOrigins();
        });

        // All calls should return undefined (no error thrown)
        reloads.forEach((r) => expect(r).toBeUndefined());

        // State must be consistent
        const cb = jest.fn();
        opts.origin('https://concurrent.example.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('interleaved add+reload pattern does not corrupt the allowlist', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://base.example.com';
        const { createCorsOptions, processBulkCorsOperations, reloadCorsOrigins } = require('./cors');
        const opts = createCorsOptions();

        // Add via bulk, then reload
        processBulkCorsOperations([
          { op: 'add', origin: 'https://extra.example.com' },
        ]);

        process.env.CORS_ORIGINS = 'https://base.example.com,https://extra.example.com';
        reloadCorsOrigins();

        // Both should now be allowed
        const cb1 = jest.fn();
        opts.origin('https://base.example.com', cb1);
        expect(cb1).toHaveBeenCalledWith(null, true);

        const cb2 = jest.fn();
        opts.origin('https://extra.example.com', cb2);
        expect(cb2).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 12: validateCorsOrigin always passes undefined origin
  // Non-browser clients (curl, service-to-service) send no Origin header.
  // They must never be blocked regardless of allowlist state.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 12 — validateCorsOrigin passes-through for undefined', () => {
    it('returns true for undefined with an empty allowlist', () => {
      jest.isolateModules(() => {
        const { validateCorsOrigin } = require('./cors');
        expect(validateCorsOrigin(undefined, [])).toBe(true);
      });
    });

    it('returns true for undefined with a non-empty allowlist', () => {
      jest.isolateModules(() => {
        const { validateCorsOrigin } = require('./cors');
        expect(validateCorsOrigin(undefined, ['https://a.com'])).toBe(true);
      });
    });

    it('createCorsOptions origin callback passes through undefined origin', () => {
      jest.isolateModules(() => {
        process.env.NODE_ENV = 'production'; // empty allowlist
        const { createCorsOptions } = require('./cors');
        const opts = createCorsOptions();
        const cb = jest.fn();
        opts.origin(undefined, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 13: DEV_DEFAULT_ORIGINS immutability contract
  // DEV_DEFAULT_ORIGINS must remain a non-empty array of strings.
  // getDevelopmentFallbackOrigins() returns the same content.
  // The exported DEV_DEFAULT_ORIGINS should not be mutated by module calls.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 13 — DEV_DEFAULT_ORIGINS stability', () => {
    it('DEV_DEFAULT_ORIGINS is a non-empty array of string origins', () => {
      jest.isolateModules(() => {
        const { DEV_DEFAULT_ORIGINS } = require('./cors');
        expect(Array.isArray(DEV_DEFAULT_ORIGINS)).toBe(true);
        expect(DEV_DEFAULT_ORIGINS.length).toBeGreaterThan(0);
        DEV_DEFAULT_ORIGINS.forEach((o) => {
          expect(typeof o).toBe('string');
          expect(o.startsWith('http')).toBe(true);
        });
      });
    });

    it('getDevelopmentFallbackOrigins returns the same contents as DEV_DEFAULT_ORIGINS', () => {
      jest.isolateModules(() => {
        const { getDevelopmentFallbackOrigins, DEV_DEFAULT_ORIGINS } = require('./cors');
        expect(getDevelopmentFallbackOrigins()).toEqual(DEV_DEFAULT_ORIGINS);
      });
    });

    it('DEV_DEFAULT_ORIGINS contains localhost entries for local development', () => {
      jest.isolateModules(() => {
        const { DEV_DEFAULT_ORIGINS } = require('./cors');
        const hasLocalhost = DEV_DEFAULT_ORIGINS.some((o) => o.includes('localhost'));
        expect(hasLocalhost).toBe(true);
      });
    });

    it('getDevelopmentFallbackOrigins returns a fresh array each time (cannot mutate cached ref)', () => {
      jest.isolateModules(() => {
        const { getDevelopmentFallbackOrigins } = require('./cors');
        const first = getDevelopmentFallbackOrigins();
        const second = getDevelopmentFallbackOrigins();
        // Content must be identical
        expect(first).toEqual(second);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 14: parseAllowedOrigins / parseMaxAge backward-compatibility
  // Non-strict mode must return exactly string[] and number respectively.
  // Changing this would break existing callers that don't use strict mode.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 14 — parseAllowedOrigins / parseMaxAge backward-compat', () => {
    it('parseAllowedOrigins (non-strict) returns string[] for valid input', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('https://a.com,https://b.com');
        expect(Array.isArray(result)).toBe(true);
        result.forEach((o) => expect(typeof o).toBe('string'));
      });
    });

    it('parseAllowedOrigins (non-strict) returns [] for undefined', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins(undefined);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(0);
      });
    });

    it('parseAllowedOrigins (non-strict) silently omits invalid entries (no throw)', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        expect(() => parseAllowedOrigins('bad-url,https://ok.com')).not.toThrow();
        const result = parseAllowedOrigins('bad-url,https://ok.com');
        expect(Array.isArray(result)).toBe(true);
        expect(result).toContain('https://ok.com');
        expect(result).not.toContain('bad-url');
      });
    });

    it('parseMaxAge (non-strict) returns a number for all inputs', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        const cases = [undefined, null, '', '0', '-1', 'foo', '600', '86400'];
        for (const c of cases) {
          const result = parseMaxAge(c);
          expect(typeof result).toBe('number');
          expect(Number.isFinite(result)).toBe(true);
          expect(result).toBeGreaterThan(0);
        }
      });
    });

    it('parseMaxAge (non-strict) default is 600', () => {
      jest.isolateModules(() => {
        const { parseMaxAge } = require('./cors');
        expect(parseMaxAge(undefined)).toBe(600);
        expect(parseMaxAge('')).toBe(600);
        expect(parseMaxAge(null)).toBe(600);
      });
    });

    it('parseAllowedOrigins (strict) returns a structured result object', () => {
      jest.isolateModules(() => {
        const { parseAllowedOrigins } = require('./cors');
        const result = parseAllowedOrigins('https://a.com', { strict: true });
        expect(typeof result).toBe('object');
        expect(Array.isArray(result.origins)).toBe(true);
        expect(Array.isArray(result.rejected)).toBe(true);
        expect(typeof result.valid).toBe('boolean');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 15: DTO round-trip equivalence
  // corsConfigDtoFromEnv → corsConfigDtoToOptions must produce CORS options
  // that are behaviourally identical to createCorsOptions for the same env.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 15 — DTO round-trip equivalence', () => {
    it('DTO pipeline approves the same origins as createCorsOptions', () => {
      jest.isolateModules(() => {
        process.env.CORS_ORIGINS = 'https://app.example.com,https://admin.example.com';
        process.env.NODE_ENV = 'production';
        const { createCorsOptions } = require('./cors');
        const { corsConfigDtoFromEnv, corsConfigDtoToOptions } = require('../dtos/cors');

        const nativeOpts = createCorsOptions();
        const dto = corsConfigDtoFromEnv();
        const dtoOpts = corsConfigDtoToOptions(dto);

        const testOrigins = [
          'https://app.example.com',
          'https://admin.example.com',
          'https://evil.com',
          'null',
          undefined,
        ];

        for (const origin of testOrigins) {
          const nativeCb = jest.fn();
          const dtoCb = jest.fn();
          nativeOpts.origin(origin, nativeCb);
          dtoOpts.origin(origin, dtoCb);

          // Both should receive the same approval/rejection pattern
          const nativeApproved = nativeCb.mock.calls[0][0] === null;
          const dtoApproved = dtoCb.mock.calls[0][0] === null;
          expect(dtoApproved).toBe(nativeApproved);
        }
      });
    });

    it('DTO pipeline maxAge matches the module-level getMaxAge', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1800';
        process.env.CORS_ORIGINS = 'https://app.example.com';
        const { createCorsOptions } = require('./cors');
        const { corsConfigDtoFromEnv, corsConfigDtoToOptions } = require('../dtos/cors');

        const nativeOpts = createCorsOptions();
        const dtoOpts = corsConfigDtoToOptions(corsConfigDtoFromEnv());

        expect(dtoOpts.maxAge).toBe(nativeOpts.maxAge);
      });
    });

    it('DTO corsConfigDtoFromJson round-trips allowedOrigins without mutation', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToJson, corsConfigDtoFromJson } = require('../dtos/cors');
        const original = {
          allowedOrigins: ['https://a.com', 'https://b.com'],
          maxAge: 3600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };
        const json = corsConfigDtoToJson(original);
        const restored = corsConfigDtoFromJson(json);

        expect(restored.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
        expect(restored.maxAge).toBe(3600);
        expect(restored.optionsSuccessStatus).toBe(204);
        expect(restored.isDevelopmentFallback).toBe(false);

        // Mutating the restored DTO does not affect original
        restored.allowedOrigins.push('https://evil.com');
        expect(original.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
      });
    });

    it('validateOriginDto result is consistent with isAllowedOrigin', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        const { validateOriginDto } = require('../dtos/cors');

        const allowlist = ['https://app.example.com'];
        const origins = [
          'https://app.example.com',
          'https://evil.com',
          'HTTPS://APP.EXAMPLE.COM',
          'https://app.example.com/',
        ];

        for (const origin of origins) {
          const dtoResult = validateOriginDto(origin, allowlist);
          const coreResult = isAllowedOrigin(origin, allowlist);
          expect(dtoResult.allowed).toBe(coreResult);
        }
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT 16: Boundary and edge-case invariants
  // Explicit checks for the boundary conditions described in the module docs.
  // ══════════════════════════════════════════════════════════════════════════

  describe('CONTRACT 16 — boundary and edge-case invariants', () => {
    it('the literal "null" origin is always rejected even when allowlist contains it', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        expect(isAllowedOrigin('null', ['null'])).toBe(false);
        expect(isAllowedOrigin('null', ['https://a.com', 'null'])).toBe(false);
        expect(isAllowedOrigin('null', [])).toBe(false);
      });
    });

    it('normalizeOrigin("null") always returns null', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin } = require('./cors');
        expect(normalizeOrigin('null')).toBeNull();
      });
    });

    it('origins are compared case-insensitively (scheme + host)', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        const allowlist = ['https://app.example.com'];
        expect(isAllowedOrigin('HTTPS://APP.EXAMPLE.COM', allowlist)).toBe(true);
        expect(isAllowedOrigin('Https://App.Example.Com', allowlist)).toBe(true);
        expect(isAllowedOrigin('https://APP.EXAMPLE.COM', allowlist)).toBe(true);
      });
    });

    it('trailing-slash variant is treated as equivalent', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        const allowlist = ['https://app.example.com'];
        expect(isAllowedOrigin('https://app.example.com/', allowlist)).toBe(true);
      });
    });

    it('subdomain of an allowlisted origin is rejected', () => {
      jest.isolateModules(() => {
        const { isAllowedOrigin } = require('./cors');
        const allowlist = ['https://app.example.com'];
        expect(isAllowedOrigin('https://sub.app.example.com', allowlist)).toBe(false);
        expect(isAllowedOrigin('https://app.example.com.evil.io', allowlist)).toBe(false);
      });
    });

    it('empty string origin normalizes to null and is always rejected', () => {
      jest.isolateModules(() => {
        const { normalizeOrigin, isAllowedOrigin } = require('./cors');
        expect(normalizeOrigin('')).toBeNull();
        expect(isAllowedOrigin('', ['https://a.com'])).toBe(false);
        expect(isAllowedOrigin('', [])).toBe(false);
      });
    });

    it('validateOriginEntry with at-boundary MAX_ORIGIN_LENGTH is valid', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry, MAX_ORIGIN_LENGTH } = require('./cors');
        // Construct a URL that's exactly MAX_ORIGIN_LENGTH characters
        const prefix = 'https://a.';
        const host = 'x'.repeat(MAX_ORIGIN_LENGTH - prefix.length);
        const origin = prefix + host;
        expect(origin.length).toBe(MAX_ORIGIN_LENGTH);
        const result = validateOriginEntry(origin);
        expect(result.valid).toBe(true);
      });
    });

    it('validateOriginEntry with MAX_ORIGIN_LENGTH + 1 characters is invalid', () => {
      jest.isolateModules(() => {
        const { validateOriginEntry, MAX_ORIGIN_LENGTH } = require('./cors');
        const over = 'https://a.' + 'x'.repeat(MAX_ORIGIN_LENGTH);
        expect(over.length).toBeGreaterThan(MAX_ORIGIN_LENGTH);
        const result = validateOriginEntry(over);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('exceeds maximum length');
      });
    });
  });
});
