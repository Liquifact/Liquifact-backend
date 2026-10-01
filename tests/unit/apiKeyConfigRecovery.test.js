/**
 * @jest-environment node
 *
 * Tests for deterministic failure recovery in `src/config/apiKeys.js` (#1274).
 *
 * Covers:
 *  - Success paths: absent / empty / valid `API_KEYS`, immutability of results.
 *  - Failure recovery: every failure mode resolves to a typed, classifiable
 *    `ApiKeyConfigError` with a stable code and never throws out of
 *    `tryLoadApiKeyRegistry`.
 *  - Determinism: identical input always produces an identical outcome, permanent
 *    failures are never retried, transient ones are retried a bounded number of
 *    times with a fixed (jitter-free) delay.
 *  - Fallback behaviour: fail-closed by default, opt-in last-known-good, and a
 *    guarantee that a degraded load can never be promoted into the fallback.
 *  - Observability: exactly one structured, key-material-free log line per
 *    failed load.
 *  - Boundary cases: length/count limits, whitespace normalisation, prototype
 *    pollution, frozen entries.
 *  - Integration: `middleware/apiKeyAuth` request-path behaviour when the
 *    registry cannot be loaded.
 */

'use strict';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn(),
  createRequestLogger: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const logger = require('../../src/logger');

const {
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  MAX_ENTRIES_COUNT,
  MAX_RAW_LENGTH,
  MAX_ATTEMPTS_CAP,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  API_KEY_FALLBACK,
  API_KEY_CONFIG_ERROR_CODES: CODES,
  RETRYABLE_OS_ERROR_CODES,
  ApiKeyConfigError,
  parseApiKeys,
  buildKeyRegistry,
  loadApiKeyRegistry,
  tryLoadApiKeyRegistry,
  readApiKeysEnv,
  validateEntry,
  classifyApiKeyConfigError,
  isRetryableApiKeyConfigError,
  toApiKeyConfigError,
  sanitizeParserMessage,
  getLastKnownGoodEntryCount,
  resetApiKeyRecoveryState,
} = require('../../src/config/apiKeys');

const { authenticateApiKey } = require('../../src/middleware/apiKeyAuth');

const SECRET_KEY = 'lf_superSecretKey0001';
const OTHER_KEY = 'lf_secondSecretKey02';

/**
 * Serializes an `API_KEYS` value from entry descriptors.
 *
 * @param {Array<Object>} entries - Raw entry objects.
 * @returns {string} The semicolon-separated `API_KEYS` value.
 */
function encode(entries) {
  return entries.map((e) => JSON.stringify(e)).join(';');
}

const VALID_ENV = {
  API_KEYS: encode([
    { key: SECRET_KEY, clientId: 'svc-a', scopes: ['invoices:read'] },
    { key: OTHER_KEY, clientId: 'svc-b', scopes: ['invoices:write'], revoked: true },
  ]),
};

/**
 * Builds an environment source whose `API_KEYS` getter throws a transient
 * error for the first `failures` reads, then returns `value`.
 *
 * @param {number} failures - How many reads should throw.
 * @param {string} value - Value returned once the source stabilises.
 * @returns {Object} A proxy usable as an environment source.
 */
function flakyEnv(failures, value) {
  let reads = 0;
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop !== 'API_KEYS') {
          return undefined;
        }
        reads += 1;
        if (reads <= failures) {
          const err = new Error('EAGAIN: resource temporarily unavailable');
          err.code = 'EAGAIN';
          throw err;
        }
        return value;
      },
    },
  );
}

/**
 * Extracts the single structured config-failure log payload emitted by the module.
 *
 * @returns {Object|undefined} The first payload logged under the failure event.
 */
function configFailureLog() {
  const call = logger.error.mock.calls.find(
    (args) => args[0] && args[0].event === 'api_key.config_load_failed',
  );
  return call && call[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  resetApiKeyRecoveryState();
});

// ── Success paths ────────────────────────────────────────────────────────────

describe('tryLoadApiKeyRegistry — success paths', () => {
  it('reports an empty registry when API_KEYS is absent', () => {
    const result = tryLoadApiKeyRegistry({});

    expect(result.ok).toBe(true);
    expect(result.status).toBe('empty');
    expect(result.registry.size).toBe(0);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.attempts).toBe(1);
    expect(result.fallbackUsed).toBeNull();
  });

  it('treats a blank API_KEYS as "feature disabled" rather than a failure', () => {
    for (const blank of ['', '   ', '\t\n', ';;']) {
      const result = tryLoadApiKeyRegistry({ API_KEYS: blank });
      expect(result.ok).toBe(true);
      expect(result.status).toBe('empty');
      expect(result.registry.size).toBe(0);
    }
  });

  it('loads and indexes keys from a valid value', () => {
    const result = tryLoadApiKeyRegistry(VALID_ENV);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.registry.size).toBe(2);
    expect(result.registry.get(SECRET_KEY)).toMatchObject({
      key: SECRET_KEY,
      clientId: 'svc-a',
      scopes: ['invoices:read'],
      revoked: false,
    });
    expect(result.registry.get(OTHER_KEY).revoked).toBe(true);
  });

  it('does not log a failure on the success path', () => {
    tryLoadApiKeyRegistry(VALID_ENV);

    expect(configFailureLog()).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns a frozen result so callers cannot corrupt shared state', () => {
    const result = tryLoadApiKeyRegistry(VALID_ENV);

    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      result.ok = false;
    }).toThrow(TypeError);
  });

  it('freezes validated entries and their scope lists', () => {
    const result = tryLoadApiKeyRegistry(VALID_ENV);
    const entry = result.registry.get(SECRET_KEY);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.scopes)).toBe(true);
    expect(() => entry.scopes.push('admin')).toThrow(TypeError);
  });

  it('records a caller-supplied source label for telemetry', () => {
    const result = tryLoadApiKeyRegistry({}, { source: 'unit-test' });

    expect(result.source).toBe('unit-test');
  });
});

// ── Failure recovery — fail closed by default ────────────────────────────────

describe('tryLoadApiKeyRegistry — failure recovery (fail closed)', () => {
  /**
   * Shared assertion: every permanent failure must resolve, not throw, and must
   * degrade to an empty registry.
   *
   * @param {string} label - Human-readable case name.
   * @param {NodeJS.ProcessEnv} env - Environment source to load.
   * @param {string} expectedCode - Expected stable failure code.
   * @returns {void}
   */
  function expectFailsClosed(label, env, expectedCode) {
    it(`fails closed for ${label}`, () => {
      let result;
      expect(() => {
        result = tryLoadApiKeyRegistry(env);
      }).not.toThrow();

      expect(result.ok).toBe(false);
      expect(result.status).toBe('empty');
      expect(result.registry).toBeInstanceOf(Map);
      expect(result.registry.size).toBe(0);
      expect(result.entries).toEqual([]);
      expect(result.errorCode).toBe(expectedCode);
      expect(result.error).toBeInstanceOf(ApiKeyConfigError);
      expect(result.error.code).toBe(expectedCode);
      expect(result.fallbackUsed).toBe(API_KEY_FALLBACK.EMPTY);
    });
  }

  expectFailsClosed('malformed JSON', { API_KEYS: '{not json' }, CODES.JSON_PARSE_FAILED);
  expectFailsClosed(
    'a JSON array entry',
    { API_KEYS: '[1,2]' },
    CODES.INVALID_ENTRY,
  );
  expectFailsClosed(
    'a JSON primitive entry',
    { API_KEYS: '42' },
    CODES.INVALID_ENTRY,
  );
  expectFailsClosed(
    'an unknown entry field',
    { API_KEYS: encode([{ key: SECRET_KEY, clientId: 'svc', scopes: ['admin'], admin: true }]) },
    CODES.UNKNOWN_FIELD,
  );
  expectFailsClosed(
    'a missing key prefix',
    { API_KEYS: encode([{ key: 'nope_abcdefgh', clientId: 'svc', scopes: ['admin'] }]) },
    CODES.INVALID_ENTRY,
  );
  expectFailsClosed(
    'an empty scope list',
    { API_KEYS: encode([{ key: SECRET_KEY, clientId: 'svc', scopes: [] }]) },
    CODES.INVALID_ENTRY,
  );
  expectFailsClosed(
    'a non-boolean revoked flag',
    { API_KEYS: encode([{ key: SECRET_KEY, clientId: 'svc', scopes: ['admin'], revoked: 'yes' }]) },
    CODES.INVALID_ENTRY,
  );
  expectFailsClosed(
    'duplicate key strings',
    {
      API_KEYS: encode([
        { key: SECRET_KEY, clientId: 'svc-a', scopes: ['admin'] },
        { key: SECRET_KEY, clientId: 'svc-b', scopes: ['admin'] },
      ]),
    },
    CODES.DUPLICATE_KEY,
  );
  expectFailsClosed('a non-string raw value', { API_KEYS: 12345 }, CODES.RAW_VALUE_NOT_A_STRING);
  expectFailsClosed('an unusable env source', null, CODES.RAW_VALUE_NOT_A_STRING);
  expectFailsClosed(
    'too many entries',
    {
      API_KEYS: Array.from(
        { length: MAX_ENTRIES_COUNT + 1 },
        (_v, i) => JSON.stringify({ key: `lf_key${String(i).padStart(11, '0')}`, clientId: `c${i}`, scopes: ['admin'] }),
      ).join(';'),
    },
    CODES.TOO_MANY_ENTRIES,
  );
  expectFailsClosed(
    'an oversized raw value',
    { API_KEYS: JSON.stringify({ key: SECRET_KEY, clientId: 'svc', scopes: ['admin'] }).padEnd(MAX_RAW_LENGTH + 1, ' ') },
    CODES.RAW_VALUE_TOO_LARGE,
  );

  it('never lets a failed load authenticate anybody', () => {
    const result = tryLoadApiKeyRegistry({ API_KEYS: '{not json' });

    expect(result.registry.has(SECRET_KEY)).toBe(false);
    expect([...result.registry.values()]).toHaveLength(0);
  });

  it('still throws from the strict loadApiKeyRegistry, preserving its contract', () => {
    expect(() => loadApiKeyRegistry({ API_KEYS: '{not json' })).toThrow(ApiKeyConfigError);
    expect(() => loadApiKeyRegistry({ API_KEYS: '{not json' })).toThrow(/failed to parse JSON/);
  });

  it('propagates the offending entry index on the typed error', () => {
    const result = tryLoadApiKeyRegistry({
      API_KEYS: `${JSON.stringify({ key: SECRET_KEY, clientId: 'ok', scopes: ['admin'] })};{"broken"`,
    });

    expect(result.error.index).toBe(1);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe('tryLoadApiKeyRegistry — deterministic recovery', () => {
  it('never retries a permanent failure, however many attempts are allowed', () => {
    const sleeps = [];
    const result = tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, {
      maxAttempts: MAX_ATTEMPTS_CAP,
      retryDelayMs: 5,
      sleep: (ms) => sleeps.push(ms),
    });

    expect(result.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a transient environment-source failure up to maxAttempts', () => {
    const sleeps = [];
    const result = tryLoadApiKeyRegistry(flakyEnv(Number.MAX_SAFE_INTEGER, VALID_ENV.API_KEYS), {
      maxAttempts: 3,
      retryDelayMs: 7,
      sleep: (ms) => sleeps.push(ms),
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([7, 7]);
  });

  it('recovers transparently when a transient failure clears within the attempt budget', () => {
    const sleeps = [];
    const result = tryLoadApiKeyRegistry(flakyEnv(2, VALID_ENV.API_KEYS), {
      maxAttempts: 3,
      retryDelayMs: 0,
      sleep: (ms) => sleeps.push(ms),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(3);
    expect(result.registry.size).toBe(2);
    expect(sleeps).toEqual([0, 0]);
  });

  it('applies a fixed, jitter-free delay so the sequence is reproducible', () => {
    const first = [];
    const second = [];
    const env = () => flakyEnv(Number.MAX_SAFE_INTEGER, VALID_ENV.API_KEYS);

    tryLoadApiKeyRegistry(env(), { maxAttempts: 4, retryDelayMs: 11, sleep: (ms) => first.push(ms) });
    tryLoadApiKeyRegistry(env(), { maxAttempts: 4, retryDelayMs: 11, sleep: (ms) => second.push(ms) });

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(1);
  });

  it('defaults to a zero retry delay so the synchronous loader never blocks the event loop', () => {
    expect(DEFAULT_RETRY_DELAY_MS).toBe(0);
  });

  it('produces an identical result for identical input', () => {
    const first = tryLoadApiKeyRegistry({ API_KEYS: '{not json' });
    const second = tryLoadApiKeyRegistry({ API_KEYS: '{not json' });

    const shape = (r) => ({
      ok: r.ok,
      status: r.status,
      size: r.registry.size,
      errorCode: r.errorCode,
      attempts: r.attempts,
      fallbackUsed: r.fallbackUsed,
      message: r.error.message,
    });

    expect(shape(first)).toEqual(shape(second));
  });

  it('clamps an out-of-range attempt count to the hard cap', () => {
    const result = tryLoadApiKeyRegistry(flakyEnv(Number.MAX_SAFE_INTEGER, VALID_ENV.API_KEYS), {
      maxAttempts: 10_000,
      sleep: () => {},
    });

    expect(result.attempts).toBe(MAX_ATTEMPTS_CAP);
  });

  it('falls back to the default attempt count for a nonsensical request', () => {
    for (const bad of [0, -1, 1.5, 'nope', null, undefined, NaN]) {
      const result = tryLoadApiKeyRegistry(flakyEnv(Number.MAX_SAFE_INTEGER, VALID_ENV.API_KEYS), {
        maxAttempts: bad,
        sleep: () => {},
      });
      expect(result.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    }
  });

  it('emits exactly one log line per failed load, no matter how many attempts ran', () => {
    const configLogs = () =>
      logger.error.mock.calls.filter((c) => c[0] && c[0].event === 'api_key.config_load_failed');

    tryLoadApiKeyRegistry(flakyEnv(Number.MAX_SAFE_INTEGER, VALID_ENV.API_KEYS), {
      maxAttempts: 4,
      sleep: () => {},
    });
    expect(configLogs()).toHaveLength(1);

    jest.clearAllMocks();
    tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, { maxAttempts: 4, sleep: () => {} });
    expect(configLogs()).toHaveLength(1);
  });
});

// ── Fallback behaviour ───────────────────────────────────────────────────────

describe('tryLoadApiKeyRegistry — last-known-good fallback', () => {
  it('serves the previous good registry when the value becomes malformed (opt-in)', () => {
    const good = tryLoadApiKeyRegistry(VALID_ENV);
    expect(good.ok).toBe(true);
    expect(getLastKnownGoodEntryCount()).toBe(2);

    const degraded = tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, {
      fallback: API_KEY_FALLBACK.LAST_KNOWN_GOOD,
    });

    expect(degraded.ok).toBe(false);
    expect(degraded.status).toBe('degraded');
    expect(degraded.registry.size).toBe(2);
    expect(degraded.registry.get(SECRET_KEY)).toBeDefined();
    expect(degraded.fallbackUsed).toBe(API_KEY_FALLBACK.LAST_KNOWN_GOOD);
  });

  it('fails closed by default even when a good registry is available', () => {
    tryLoadApiKeyRegistry(VALID_ENV);

    const result = tryLoadApiKeyRegistry({ API_KEYS: '{not json' });

    expect(result.status).toBe('empty');
    expect(result.registry.size).toBe(0);
    expect(result.fallbackUsed).toBe(API_KEY_FALLBACK.EMPTY);
  });

  it('fails closed when no successful load has happened yet', () => {
    const result = tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, {
      fallback: API_KEY_FALLBACK.LAST_KNOWN_GOOD,
    });

    expect(result.status).toBe('empty');
    expect(result.registry.size).toBe(0);
    expect(result.fallbackUsed).toBe(API_KEY_FALLBACK.EMPTY);
  });

  it('never promotes a degraded or empty load into the last-known-good registry', () => {
    tryLoadApiKeyRegistry(VALID_ENV);

    tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, { fallback: API_KEY_FALLBACK.LAST_KNOWN_GOOD });
    expect(getLastKnownGoodEntryCount()).toBe(2);

    // An empty-but-valid value must not blank the retained registry either.
    tryLoadApiKeyRegistry({ API_KEYS: '' });
    expect(getLastKnownGoodEntryCount()).toBe(2);
  });

  it('reports a zero last-known-good size before any successful non-empty load', () => {
    expect(getLastKnownGoodEntryCount()).toBe(0);

    tryLoadApiKeyRegistry({ API_KEYS: '' });
    expect(getLastKnownGoodEntryCount()).toBe(0);
  });

  it('clears the retained registry via the test-only reset hook', () => {
    tryLoadApiKeyRegistry(VALID_ENV);
    resetApiKeyRecoveryState();

    expect(getLastKnownGoodEntryCount()).toBe(0);
    const result = tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, {
      fallback: API_KEY_FALLBACK.LAST_KNOWN_GOOD,
    });
    expect(result.registry.size).toBe(0);
  });

  it('does not share a mutable empty Map between failures', () => {
    const first = tryLoadApiKeyRegistry({ API_KEYS: '{not json' });
    const second = tryLoadApiKeyRegistry({ API_KEYS: '{also not json' });

    first.registry.set('lf_injected00001', { key: 'lf_injected00001', clientId: 'x', scopes: [] });

    expect(second.registry.has('lf_injected00001')).toBe(false);
  });
});

// ── Observability and redaction ──────────────────────────────────────────────

describe('apiKeys config failure — observability and redaction', () => {
  it('logs a structured payload carrying the stable code and recovery context', () => {
    tryLoadApiKeyRegistry({ API_KEYS: '{not json' }, { source: 'unit-test' });

    const payload = configFailureLog();
    expect(payload).toMatchObject({
      event: 'api_key.config_load_failed',
      error_code: CODES.JSON_PARSE_FAILED,
      retryable: false,
      attempts: 1,
      fallback: API_KEY_FALLBACK.EMPTY,
      source: 'unit-test',
    });
  });

  it('never writes key material to the log', () => {
    const poisoned = `{"key":"${SECRET_KEY}","clientId":"svc","scopes":[` ;
    tryLoadApiKeyRegistry({ API_KEYS: poisoned });

    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(API_KEY_PREFIX + 'superSecret');
  });

  it('never writes key material to the thrown error', () => {
    const result = tryLoadApiKeyRegistry({
      API_KEYS: `{"key":"${SECRET_KEY}","clientId":"svc","scopes":[`,
    });

    expect(result.error.message).not.toContain(SECRET_KEY);
  });

  it('strips the verbatim input excerpt V8 embeds in parse errors', () => {
    // Node >= 20 quotes the offending input: `Unexpected token 'l', "..." is not valid JSON`.
    const result = tryLoadApiKeyRegistry({ API_KEYS: SECRET_KEY });
    expect(result.errorCode).toBe(CODES.JSON_PARSE_FAILED);
    expect(result.error.message).toContain('failed to parse JSON');
    expect(result.error.message).not.toContain(SECRET_KEY);
  });

  it('sanitizeParserMessage redacts quoted excerpts and bounds the length', () => {
    expect(sanitizeParserMessage('Unexpected token \'l\', "lf_realkey" is not valid JSON')).not.toContain(
      'lf_realkey',
    );
    expect(sanitizeParserMessage(`a`.repeat(500)).length).toBeLessThanOrEqual(120);
    expect(sanitizeParserMessage('')).toBe('invalid JSON');
    expect(sanitizeParserMessage(undefined)).toBe('invalid JSON');
    expect(sanitizeParserMessage({})).toBe('invalid JSON');
  });

  it('keeps the deterministic part of a parser message for diagnostics', () => {
    const message = sanitizeParserMessage(
      'Expected double-quoted property name in JSON at position 42 (line 1 column 43)',
    );
    expect(message).toContain('JSON at position 42');
  });

  it('discards the message of an unclassified error entirely', () => {
    const verdict = classifyApiKeyConfigError(new Error('leaked lf_realsecret0001'));

    expect(verdict.code).toBe(CODES.UNKNOWN);
    expect(verdict.message).not.toContain('lf_realsecret0001');
  });

  it('classifies each documented failure code', () => {
    const cases = [
      { env: { API_KEYS: '{bad' }, code: CODES.JSON_PARSE_FAILED },
      { env: { API_KEYS: '[1]' }, code: CODES.INVALID_ENTRY },
      {
        env: { API_KEYS: encode([{ key: SECRET_KEY, clientId: 's', scopes: ['admin'], x: 1 }]) },
        code: CODES.UNKNOWN_FIELD,
      },
      {
        env: {
          API_KEYS: encode([
            { key: SECRET_KEY, clientId: 'a', scopes: ['admin'] },
            { key: SECRET_KEY, clientId: 'b', scopes: ['admin'] },
          ]),
        },
        code: CODES.DUPLICATE_KEY,
      },
      { env: { API_KEYS: 1 }, code: CODES.RAW_VALUE_NOT_A_STRING },
    ];

    for (const { env, code } of cases) {
      expect(tryLoadApiKeyRegistry(env).errorCode).toBe(code);
    }
  });

  it('marks only transient OS failures retryable', () => {
    for (const code of RETRYABLE_OS_ERROR_CODES) {
      const verdict = classifyApiKeyConfigError(Object.assign(new Error('boom'), { code }));
      expect(verdict.retryable).toBe(true);
      expect(verdict.code).toBe(CODES.ENV_SOURCE_FAILED);
    }

    for (const code of ['EACCES', 'EINVAL', 'ENOENT']) {
      expect(classifyApiKeyConfigError(Object.assign(new Error('boom'), { code })).retryable).toBe(false);
    }

    expect(isRetryableApiKeyConfigError(new Error('boom'))).toBe(false);
    expect(isRetryableApiKeyConfigError(null)).toBe(false);
    expect(isRetryableApiKeyConfigError('nope')).toBe(false);
  });

  it('preserves the original failure as `cause` when wrapping', () => {
    const original = new Error('EACCES: permission denied');
    original.code = 'EACCES';
    const wrapped = toApiKeyConfigError(original);

    expect(wrapped).toBeInstanceOf(ApiKeyConfigError);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.code).toBe(CODES.UNKNOWN);
  });

  it('returns the same error instance when it is already typed', () => {
    const typed = new ApiKeyConfigError('API_KEYS: nope', { code: CODES.INVALID_ENTRY });

    expect(toApiKeyConfigError(typed)).toBe(typed);
  });

  it('readApiKeysEnv isolates a throwing getter behind a typed error', () => {
    const permanent = new Proxy(
      {},
      {
        get() {
          throw new TypeError('getter exploded');
        },
      },
    );

    expect(() => readApiKeysEnv(permanent)).toThrow(ApiKeyConfigError);
    try {
      readApiKeysEnv(permanent);
    } catch (err) {
      expect(err.code).toBe(CODES.ENV_SOURCE_FAILED);
      expect(err.retryable).toBe(false);
    }
  });

  it('marks a transient getter failure retryable and preserves the cause', () => {
    try {
      readApiKeysEnv(flakyEnv(Number.MAX_SAFE_INTEGER, 'x'));
    } catch (err) {
      expect(err).toBeInstanceOf(ApiKeyConfigError);
      expect(err.code).toBe(CODES.ENV_SOURCE_FAILED);
      expect(err.retryable).toBe(true);
      expect(err.cause.code).toBe('EAGAIN');
      expect(err.message).toContain('EAGAIN');
    }
  });
});

// ── Boundary and input-shape cases ───────────────────────────────────────────

describe('apiKeys config — boundary and input-shape cases', () => {
  it('accepts a key at exactly the minimum length', () => {
    const key = API_KEY_PREFIX + 'a'.repeat(MIN_KEY_LENGTH - API_KEY_PREFIX.length);
    expect(key).toHaveLength(MIN_KEY_LENGTH);
    expect(() => validateEntry({ key, clientId: 'svc', scopes: ['admin'] }, 0)).not.toThrow();
  });

  it('accepts a key at exactly the maximum length', () => {
    const key = API_KEY_PREFIX + 'a'.repeat(MAX_KEY_LENGTH - API_KEY_PREFIX.length);
    expect(() => validateEntry({ key, clientId: 'svc', scopes: ['admin'] }, 0)).not.toThrow();
  });

  it('accepts a clientId at exactly the maximum length', () => {
    const clientId = 'a'.repeat(MAX_CLIENT_ID_LENGTH);
    expect(() =>
      validateEntry({ key: SECRET_KEY, clientId, scopes: ['admin'] }, 0),
    ).not.toThrow();
  });

  it('accepts a scope list at exactly the maximum count', () => {
    const scopes = Array(MAX_SCOPES_COUNT).fill('invoices:read');
    expect(() => validateEntry({ key: SECRET_KEY, clientId: 'svc', scopes }, 0)).not.toThrow();
  });

  it('accepts exactly MAX_ENTRIES_COUNT entries and rejects one more', () => {
    const build = (count) =>
      Array.from(
        { length: count },
        (_v, i) => JSON.stringify({ key: `lf_key${String(i).padStart(11, '0')}`, clientId: `c${i}`, scopes: ['admin'] }),
      ).join(';');

    expect(tryLoadApiKeyRegistry({ API_KEYS: build(MAX_ENTRIES_COUNT) }).ok).toBe(true);
    expect(tryLoadApiKeyRegistry({ API_KEYS: build(MAX_ENTRIES_COUNT + 1) }).errorCode).toBe(
      CODES.TOO_MANY_ENTRIES,
    );
  });

  it('accepts a raw value at exactly MAX_RAW_LENGTH and rejects one more', () => {
    const payload = JSON.stringify({ key: SECRET_KEY, clientId: 'svc', scopes: ['admin'] });

    expect(tryLoadApiKeyRegistry({ API_KEYS: payload.padEnd(MAX_RAW_LENGTH, ' ') }).ok).toBe(true);
    expect(tryLoadApiKeyRegistry({ API_KEYS: payload.padEnd(MAX_RAW_LENGTH + 1, ' ') }).errorCode).toBe(
      CODES.RAW_VALUE_TOO_LARGE,
    );
  });

  it('measures key length after trimming so padding cannot smuggle a short key through', () => {
    const short = ` ${API_KEY_PREFIX}short `;

    expect(() => validateEntry({ key: short, clientId: 'svc', scopes: ['admin'] }, 0)).toThrow(
      /at least/,
    );
    expect(() =>
      validateEntry({ key: `   ${SECRET_KEY}   `, clientId: 'svc', scopes: ['admin'] }, 0),
    ).not.toThrow();
  });

  it('trims the stored key and clientId', () => {
    const entry = validateEntry({ key: `  ${SECRET_KEY} `, clientId: '  svc-a  ', scopes: ['admin'] }, 0);

    expect(entry.key).toBe(SECRET_KEY);
    expect(entry.clientId).toBe('svc-a');
  });

  it('rejects a prototype-pollution attempt through __proto__', () => {
    const raw = `{"key":"${SECRET_KEY}","clientId":"svc","scopes":["admin"],"__proto__":{"admin":true}}`;

    expect(() => parseApiKeys(raw)).toThrow(/unknown field/);
    expect({}.admin).toBeUndefined();
  });

  it('rejects constructor / prototype as unknown fields', () => {
    for (const field of ['constructor', 'prototype']) {
      expect(() =>
        validateEntry(
          { key: SECRET_KEY, clientId: 'svc', scopes: ['admin'], [field]: 'x' },
          0,
        ),
      ).toThrow(/unknown field/);
    }
  });

  it('rejects a non-array entry list with a typed error', () => {
    for (const bad of [undefined, null, 'nope', 42, {}]) {
      let caught;
      try {
        buildKeyRegistry(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiKeyConfigError);
      expect(caught.code).toBe(CODES.ENTRIES_NOT_ARRAY);
    }
  });

  it('rejects a non-object registry entry with a typed error', () => {
    for (const bad of [null, undefined, 'lf_x', 42]) {
      let caught;
      try {
        buildKeyRegistry([bad]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiKeyConfigError);
      expect(caught.code).toBe(CODES.ENTRY_NOT_OBJECT);
    }
  });

  it('returns an empty Map for an empty entry list', () => {
    expect(buildKeyRegistry([])).toEqual(new Map());
  });

  it('reports a stable non-secret identifier for duplicate keys', () => {
    let caught;
    try {
      parseApiKeys(
        encode([
          { key: SECRET_KEY, clientId: 'svc-a', scopes: ['admin'] },
          { key: SECRET_KEY, clientId: 'svc-b', scopes: ['admin'] },
        ]),
      );
      buildKeyRegistry(parseApiKeys(encode([
        { key: SECRET_KEY, clientId: 'svc-a', scopes: ['admin'] },
        { key: SECRET_KEY, clientId: 'svc-b', scopes: ['admin'] },
      ])));
    } catch (err) {
      caught = err;
    }

    expect(caught.code).toBe(CODES.DUPLICATE_KEY);
    expect(caught.message).toContain('svc-b');
    expect(caught.message).not.toContain(SECRET_KEY);
  });
});

// ── Integration: middleware request path ─────────────────────────────────────

describe('middleware/apiKeyAuth — deterministic registry recovery', () => {
  /**
   * @param {import('express').RequestHandler} middleware - Middleware under test.
   * @returns {import('express').Express} A minimal test app.
   */
  function makeApp(middleware) {
    const app = express();
    app.get('/test', middleware, (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('authenticates with a valid key', async () => {
    const app = makeApp(authenticateApiKey({ env: VALID_ENV }));

    const res = await request(app).get('/test').set('X-API-Key', SECRET_KEY);

    expect(res.status).toBe(200);
  });

  it('rejects every key when the registry cannot be built, without leaking config', async () => {
    const app = makeApp(authenticateApiKey({ env: { API_KEYS: '{not json' } }));

    const res = await request(app).get('/test').set('X-API-Key', SECRET_KEY);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
  });

  it('surfaces a stable recovery event and never logs the supplied key', async () => {
    const app = makeApp(authenticateApiKey({ env: { API_KEYS: '{not json' } }));

    await request(app).get('/test').set('X-API-Key', SECRET_KEY);

    const authLog = logger.error.mock.calls.find((c) => c[0] && c[0].outcome === 'registry_unavailable');
    expect(authLog).toBeDefined();
    expect(authLog[0]).toMatchObject({
      event: 'api_key.auth',
      outcome: 'registry_unavailable',
      error_code: CODES.JSON_PARSE_FAILED,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET_KEY);
  });

  it('still rejects a missing header before touching the registry', async () => {
    const app = makeApp(authenticateApiKey({ env: { API_KEYS: '{not json' } }));

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('recovers a transient read failure within a single request attempt budget', async () => {
    // The source fails the first read and stabilises afterwards. The default
    // budget (2 attempts) absorbs it, so the caller never sees an error.
    let reads = 0;
    const env = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop !== 'API_KEYS') return undefined;
          if (reads++ === 0) {
            const err = new Error('EAGAIN: resource temporarily unavailable');
            err.code = 'EAGAIN';
            throw err;
          }
          return VALID_ENV.API_KEYS;
        },
      },
    );
    const app = makeApp(authenticateApiKey({ env }));

    const res = await request(app).get('/test').set('X-API-Key', SECRET_KEY);

    expect(res.status).toBe(200);
    expect(reads).toBe(2);
  });

  it('fails the request only while the transient failure outlasts the attempt budget', async () => {
    // Two failing reads exhaust the default 2-attempt budget for request one;
    // the next request starts from a stable source and authenticates.
    let reads = 0;
    const env = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop !== 'API_KEYS') return undefined;
          reads += 1;
          if (reads <= 2) {
            const err = new Error('EAGAIN: resource temporarily unavailable');
            err.code = 'EAGAIN';
            throw err;
          }
          return VALID_ENV.API_KEYS;
        },
      },
    );
    const app = makeApp(authenticateApiKey({ env }));

    const first = await request(app).get('/test').set('X-API-Key', SECRET_KEY);
    expect(first.status).toBe(500);

    const second = await request(app).get('/test').set('X-API-Key', SECRET_KEY);
    expect(second.status).toBe(200);
  });
});
