'use strict';

/**
 * @fileoverview In-process cache configuration with deterministic, bounded failure recovery.
 *
 * Every knob exposed here is a *performance* knob. None of them protects a
 * security, financial, or durability invariant, so a bad value must never stop
 * the service from booting — but it also must never leave a cache in a state
 * that quietly consumes unbounded memory. That tension is what this module
 * resolves, and the resolution is deliberately boring so it can be reviewed.
 *
 * ## Recovery policy (one rule, applied everywhere)
 *
 * A setting is honoured only when its environment variable is a base-10 integer
 * literal (optionally signed, surrounding whitespace ignored) that lands inside
 * the field's inclusive `[min, max]` range. *Every* other case — absent, empty,
 * wrong type, unparseable, non-positive, or out of range — resolves to that
 * field's documented default. There is no clamping arithmetic and no second
 * code path, so "what happens when the value is bad" has exactly one answer.
 *
 * ## Invariants
 *
 * 1. **Safety floor — recovery never produces an out-of-contract value.**
 *    {@link parseCacheConfig} never returns `undefined`, `NaN`, `Infinity`, a
 *    non-integer, or a non-positive number for any TTL or entry bound. This is
 *    the invariant the whole module exists for: consumers such as
 *    `services/indexerCache` evaluate `entry.expiresAt <= now()` and
 *    `while (this.entries.size > this.maxEntries)`. A single `undefined`
 *    silently disables *both* TTL expiry and capacity eviction, converting a
 *    one-line config mistake into a slow OOM. A rejected value must therefore
 *    never be forwarded to a consumer — it must be replaced here.
 * 2. **Determinism.** {@link parseCacheConfig} is a pure function of its `env`
 *    argument: no clock, no randomness, no I/O, no module state, and a fixed
 *    field iteration order. The same `env` always yields a deeply equal result,
 *    and calling it repeatedly is idempotent. Retrying a parse can never
 *    produce a different answer than the first attempt.
 * 3. **Atomic publication.** The module-level configuration is only ever
 *    *replaced* with a fully built, frozen object in a single assignment, never
 *    mutated in place, and it is always frozen before publication. A concurrent
 *    or retried reload can therefore never be observed half-applied: readers
 *    see either the complete previous config or the complete next one.
 * 4. **Observability without disclosure.** A rejected value is reported as the
 *    variable name plus a bounded reason from {@link CACHE_CONFIG_FALLBACK_REASON},
 *    the default, and the accepted range. The operator-supplied raw value is
 *    *never* logged: it is free-form text, so echoing it would risk log
 *    injection and would risk writing a secret into a log sink if a variable
 *    were ever repurposed. The bounded reason enum also keeps this safe to use
 *    as a Prometheus label later without a cardinality explosion.
 * 5. **Never fatal.** Cache configuration is optional tuning, so nothing in
 *    this module throws during load or reload. An unusable `env` source, a
 *    value with a throwing getter, a broken `onFallback` observer, or a logger
 *    that fails to initialise all degrade to the documented default. In
 *    particular the logger is resolved lazily and every call into it is guarded:
 *    an observability dependency must not be able to take the process down.
 *
 * @module config/cache
 */

const MS_PER_SECOND = 1000;

const DEFAULT_ESCROW_TTL_SECONDS = 30;
const DEFAULT_ESCROW_MAX_ENTRIES = 500;
const DEFAULT_INDEXER_TTL_SECONDS = 10;
const DEFAULT_INDEXER_MAX_ENTRIES = 200;
const DEFAULT_INVOICE_STATE_TTL_SECONDS = 30;
const DEFAULT_INVOICE_STATE_MAX_ENTRIES = 500;

/**
 * Smallest accepted TTL, in seconds.
 *
 * A zero or negative TTL would expire entries the instant they are written,
 * turning the cache into a guaranteed-miss source while still paying full
 * serialisation and insertion cost.
 * @type {number}
 */
const TTL_SECONDS_MIN = 1;

/**
 * Largest accepted TTL, in seconds (24 hours).
 *
 * A TTL beyond one day is stale data by definition for escrow, invoice-state,
 * and indexer reads. Capping it keeps a fat-fingered `864000` from serving
 * day-old balances for a day.
 * @type {number}
 */
const TTL_SECONDS_MAX = 86400;

/**
 * Smallest accepted entry bound. One entry is a legal (if useless) cache, so
 * this is not clamped to anything larger.
 * @type {number}
 */
const MAX_ENTRIES_MIN = 1;

/**
 * Largest accepted entry bound.
 *
 * This is the hard ceiling that keeps operator input from turning into
 * unbounded process memory. It is deliberately far above any realistic working
 * set (the shipped defaults are 200-500) so that legitimate tuning is never
 * rejected, while an accidental `1e9` is refused in favour of the default.
 * @type {number}
 */
const MAX_ENTRIES_MAX = 100000;

/**
 * Bounded set of reasons a configured value was rejected and a default applied.
 *
 * Every entry is a closed, low-cardinality token so the value is safe to use as
 * a metrics label. This enum is intentionally *not* extended with
 * operator-supplied text: that is what makes it bounded.
 *
 * - `unreadable_env`   — the environment source itself could not be read.
 * - `not_a_string`     — the value is neither a string nor a number.
 * - `not_an_integer`   — the value is not a base-10 integer literal, or
 *                        overflows the safe-integer range.
 * - `not_finite`       — a `number` value was `NaN` or `±Infinity`.
 * - `not_positive`     — the value parsed but was `<= 0`.
 * - `out_of_range`     — the value parsed but fell outside `[min, max]`.
 *
 * An absent or empty/whitespace-only value is a normal default, not a
 * rejection, so it is deliberately absent from this enum.
 *
 * @readonly
 * @enum {string}
 */
const CACHE_CONFIG_FALLBACK_REASON = Object.freeze({
  UNREADABLE_ENV: 'unreadable_env',
  NOT_A_STRING: 'not_a_string',
  NOT_AN_INTEGER: 'not_an_integer',
  NOT_FINITE: 'not_finite',
  NOT_POSITIVE: 'not_positive',
  OUT_OF_RANGE: 'out_of_range',
});

/**
 * Inclusive bounds enforced on every configured value, in the units of the
 * variable being configured (seconds for TTLs, entries for bounds).
 *
 * Exposed so operators and runbooks can assert the accepted range without
 * duplicating the numbers.
 *
 * @readonly
 * @type {{ ttlSeconds: { min: number, max: number }, maxEntries: { min: number, max: number } }}
 */
const CACHE_CONFIG_LIMITS = Object.freeze({
  ttlSeconds: Object.freeze({ min: TTL_SECONDS_MIN, max: TTL_SECONDS_MAX }),
  maxEntries: Object.freeze({ min: MAX_ENTRIES_MIN, max: MAX_ENTRIES_MAX }),
});

/**
 * A configured value was rejected and replaced by its documented default.
 *
 * Reported so a misconfiguration is diagnosable without ever exposing the raw
 * value that caused it. All numeric fields are in the units noted per property.
 *
 * @typedef {object} CacheConfigFallback
 * @property {string} variable Environment variable the operator needs to fix.
 * @property {string} key      Key written into the parsed configuration object.
 * @property {string} reason   Bounded reason from {@link CACHE_CONFIG_FALLBACK_REASON}.
 * @property {number} envDefault Default expressed in the variable's own units
 *   (seconds for a TTL, entries for a bound) so it can be compared with what
 *   the operator typed and with the `.env.example` entry.
 * @property {number} min      Smallest accepted value, in the variable's own units.
 * @property {number} max      Largest accepted value, in the variable's own units.
 * @property {number} resolved Value actually written into the configuration,
 *   in output units (milliseconds for a TTL).
 */

/**
 * Fully parsed, validated cache configuration.
 *
 * Frozen before it is returned or published so no consumer can mutate shared
 * state out from under another consumer (invariant 3).
 *
 * @typedef {object} CacheConfig
 * @property {number} escrowTtl              Escrow read cache TTL, milliseconds.
 * @property {number} escrowMaxEntries       Escrow read cache entry bound.
 * @property {number} indexerTtl             Indexer listing cache TTL, milliseconds.
 * @property {number} indexerMaxEntries      Indexer listing cache entry bound.
 * @property {number} invoiceStateTtl        Invoice-state response cache TTL, milliseconds.
 * @property {number} invoiceStateMaxEntries Invoice-state response cache entry bound.
 */

/**
 * Single source of truth for every cache knob: the output key, the environment
 * variable, the default and range in that variable's units, and the multiplier
 * that converts the variable's units into the output units.
 *
 * The array is frozen and iterated in declaration order, which is what makes
 * both the resulting configuration and the resulting fallback report list
 * deterministic (invariant 2).
 *
 * @type {ReadonlyArray<Readonly<{ key: string, variable: string, defaultValue: number, min: number, max: number, scale: number }>>}
 */
const CACHE_CONFIG_FIELDS = Object.freeze([
  Object.freeze({
    key: 'escrowTtl',
    variable: 'ESCROW_CACHE_TTL_SECONDS',
    defaultValue: DEFAULT_ESCROW_TTL_SECONDS,
    min: TTL_SECONDS_MIN,
    max: TTL_SECONDS_MAX,
    scale: MS_PER_SECOND,
  }),
  Object.freeze({
    key: 'escrowMaxEntries',
    variable: 'ESCROW_CACHE_MAX_ENTRIES',
    defaultValue: DEFAULT_ESCROW_MAX_ENTRIES,
    min: MAX_ENTRIES_MIN,
    max: MAX_ENTRIES_MAX,
    scale: 1,
  }),
  Object.freeze({
    key: 'indexerTtl',
    variable: 'INDEXER_CACHE_TTL_SECONDS',
    defaultValue: DEFAULT_INDEXER_TTL_SECONDS,
    min: TTL_SECONDS_MIN,
    max: TTL_SECONDS_MAX,
    scale: MS_PER_SECOND,
  }),
  Object.freeze({
    key: 'indexerMaxEntries',
    variable: 'INDEXER_CACHE_MAX_ENTRIES',
    defaultValue: DEFAULT_INDEXER_MAX_ENTRIES,
    min: MAX_ENTRIES_MIN,
    max: MAX_ENTRIES_MAX,
    scale: 1,
  }),
  Object.freeze({
    key: 'invoiceStateTtl',
    variable: 'INVOICE_STATE_CACHE_TTL_SECONDS',
    defaultValue: DEFAULT_INVOICE_STATE_TTL_SECONDS,
    min: TTL_SECONDS_MIN,
    max: TTL_SECONDS_MAX,
    scale: MS_PER_SECOND,
  }),
  Object.freeze({
    key: 'invoiceStateMaxEntries',
    variable: 'INVOICE_STATE_CACHE_MAX_ENTRIES',
    defaultValue: DEFAULT_INVOICE_STATE_MAX_ENTRIES,
    min: MAX_ENTRIES_MIN,
    max: MAX_ENTRIES_MAX,
    scale: 1,
  }),
]);

/**
 * No value was configured. This is a normal default, not a rejection, and
 * therefore carries no reason and is never reported.
 *
 * @typedef {{ status: 'unset' }} CacheValueUnset
 */

/**
 * The value is a usable integer; range checking happens separately.
 *
 * @typedef {{ status: 'ok', value: number }} CacheValueAccepted
 */

/**
 * The value is unusable and must be replaced by the field's default.
 *
 * @typedef {{ status: 'rejected', reason: string }} CacheValueRejected
 */

/**
 * Discriminated result of inspecting one raw environment value.
 *
 * @typedef {CacheValueUnset|CacheValueAccepted|CacheValueRejected} CacheValueClassification
 */

// A base-10 integer literal, optionally signed. Used instead of `parseInt` so
// that partially numeric input ("60s", "1e3", "1.5") is rejected instead of
// silently truncated to a plausible-looking number.
const INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Shared frozen sentinel for "no value configured".
 *
 * @type {CacheValueUnset}
 */
const UNSET_CLASSIFICATION = Object.freeze({ status: 'unset' });

/**
 * Normalises a candidate environment source.
 *
 * Anything that cannot be indexed by property name — `null`, `undefined`, a
 * string, a number, a boolean, a symbol — is reported as unusable rather than
 * being coerced, because silently treating `'30'` (the string) as an
 * environment object would be a very confusing way to fail.
 *
 * @param {unknown} env - Candidate environment source.
 * @returns {Record<string, unknown>|null} The source when readable, otherwise `null`.
 */
function resolveEnvSource(env) {
  if (env === null || env === undefined) {
    return null;
  }
  const kind = typeof env;
  if (kind !== 'object' && kind !== 'function') {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (env);
}

/**
 * Builds a rejection classification for a bounded reason.
 *
 * @param {string} reason - Value from {@link CACHE_CONFIG_FALLBACK_REASON}.
 * @returns {CacheValueRejected} Rejected classification.
 */
function rejectValue(reason) {
  return { status: 'rejected', reason };
}

/**
 * Validates an already-numeric candidate against the finiteness, integrality,
 * and positivity rules shared by string and numeric inputs.
 *
 * @param {number} value - Candidate numeric value.
 * @returns {CacheValueAccepted|CacheValueRejected} Classification.
 */
function classifyNumber(value) {
  if (!Number.isFinite(value)) {
    return rejectValue(CACHE_CONFIG_FALLBACK_REASON.NOT_FINITE);
  }
  // Guards against silent precision loss, e.g. '9007199254740993'.
  if (!Number.isSafeInteger(value)) {
    return rejectValue(CACHE_CONFIG_FALLBACK_REASON.NOT_AN_INTEGER);
  }
  if (value <= 0) {
    return rejectValue(CACHE_CONFIG_FALLBACK_REASON.NOT_POSITIVE);
  }
  return { status: 'ok', value };
}

/**
 * Classifies one raw environment value independently of any field's range.
 *
 * Range checking is applied separately by {@link resolveCacheField} so that a
 * syntactically valid but out-of-range value gets its own `out_of_range`
 * reason rather than being conflated with a parse failure.
 *
 * @param {unknown} raw - Raw environment value.
 * @returns {CacheValueClassification} Classification.
 */
function classifyCacheValue(raw) {
  if (raw === undefined || raw === null) {
    return UNSET_CLASSIFICATION;
  }

  // `process.env` only ever yields strings, but callers (and tests) routinely
  // build a plain object with numeric literals. Accept those rather than
  // breaking a caller that already worked.
  if (typeof raw === 'number') {
    return classifyNumber(raw);
  }

  if (typeof raw !== 'string') {
    return rejectValue(CACHE_CONFIG_FALLBACK_REASON.NOT_A_STRING);
  }

  const text = raw.trim();
  if (text === '') {
    return UNSET_CLASSIFICATION;
  }
  if (!INTEGER_PATTERN.test(text)) {
    return rejectValue(CACHE_CONFIG_FALLBACK_REASON.NOT_AN_INTEGER);
  }
  return classifyNumber(Number(text));
}

/**
 * Builds the frozen diagnostic record for a rejected value.
 *
 * @param {Readonly<{ key: string, variable: string, defaultValue: number, min: number, max: number, scale: number }>} field - Field descriptor.
 * @param {string} reason - Value from {@link CACHE_CONFIG_FALLBACK_REASON}.
 * @returns {CacheConfigFallback} Frozen diagnostic record. Never carries the raw value.
 */
function buildFallback(field, reason) {
  return Object.freeze({
    variable: field.variable,
    key: field.key,
    reason,
    envDefault: field.defaultValue,
    min: field.min,
    max: field.max,
    resolved: field.defaultValue * field.scale,
  });
}

/**
 * Applies the recovery policy to a single field.
 *
 * This is the one place a field's fate is decided, which is what keeps the
 * policy reviewable: honour the value when it is an in-range integer,
 * otherwise substitute the documented default and say why.
 *
 * @param {Record<string, unknown>|null} source - Normalised env source, or `null` when unusable.
 * @param {Readonly<{ key: string, variable: string, defaultValue: number, min: number, max: number, scale: number }>} field - Field descriptor.
 * @returns {{ value: number, report: CacheConfigFallback|null }} Resolved value and an optional diagnostic.
 */
function resolveCacheField(source, field) {
  const defaultValue = field.defaultValue * field.scale;

  if (source === null) {
    return { value: defaultValue, report: buildFallback(field, CACHE_CONFIG_FALLBACK_REASON.UNREADABLE_ENV) };
  }

  let raw;
  try {
    raw = source[field.variable];
  } catch (_error) {
    // A Proxy or an exotic getter can throw on property access. That is a
    // failed read, not a failed process: take the default and report it.
    return { value: defaultValue, report: buildFallback(field, CACHE_CONFIG_FALLBACK_REASON.UNREADABLE_ENV) };
  }

  const classified = classifyCacheValue(raw);

  if (classified.status === 'unset') {
    return { value: defaultValue, report: null };
  }

  if (classified.status === 'ok') {
    if (classified.value >= field.min && classified.value <= field.max) {
      return { value: classified.value * field.scale, report: null };
    }
    return { value: defaultValue, report: buildFallback(field, CACHE_CONFIG_FALLBACK_REASON.OUT_OF_RANGE) };
  }

  return { value: defaultValue, report: buildFallback(field, classified.reason) };
}

/**
 * Parses the configuration and collects its diagnostics in one pass.
 *
 * Kept separate from {@link parseCacheConfig} so the pure parse and the
 * side-effecting observer notification cannot be confused for one another.
 *
 * @param {unknown} env - Environment source to read from.
 * @returns {{ config: CacheConfig, fallbacks: ReadonlyArray<CacheConfigFallback> }} Frozen config and diagnostics.
 */
function parseCacheConfigDetailed(env) {
  const source = resolveEnvSource(env);

  /** @type {Record<string, number>} */
  const config = {};
  /** @type {CacheConfigFallback[]} */
  const fallbacks = [];

  for (const field of CACHE_CONFIG_FIELDS) {
    const resolved = resolveCacheField(source, field);
    // Frozen only after every field is resolved, so the object handed to
    // callers is complete before anything can read it.
    config[field.key] = resolved.value;
    if (resolved.report) {
      fallbacks.push(resolved.report);
    }
  }

  // Single narrowing point from the field-table accumulator to the published
  // contract. `CACHE_CONFIG_FIELDS` is the only place a key is produced, and
  // every key it produces is declared by {@link CacheConfig}.
  return {
    config: /** @type {CacheConfig} */ (Object.freeze(config)),
    fallbacks: Object.freeze(fallbacks),
  };
}

/**
 * Parses cache configuration from environment variables.
 *
 * A missing, empty, malformed, non-positive, or out-of-range value falls back
 * to that field's documented default. The result is always fully populated:
 * every TTL is a positive integer number of milliseconds and every bound is a
 * positive integer, so a consumer can never be handed `undefined`, `NaN`, or
 * `Infinity` (invariant 1).
 *
 * @param {NodeJS.ProcessEnv|object|null} [env] - Environment variables to read from. Defaults to `process.env`.
 * @param {object} [options] - Parsing options.
 * @param {Function} [options.onFallback] - Invoked once per rejected value with a frozen
 *   {@link CacheConfigFallback}. Called synchronously; exceptions are swallowed so an observer
 *   cannot break parsing. Omit it to keep the call completely side-effect free.
 * @returns {CacheConfig} Frozen configuration object.
 * @example
 * parseCacheConfig({ INDEXER_CACHE_TTL_SECONDS: '5' });
 * // → { ..., indexerTtl: 5000, indexerMaxEntries: 200, ... }
 */
function parseCacheConfig(env = process.env, options = {}) {
  const { config, fallbacks } = parseCacheConfigDetailed(env);

  if (fallbacks.length > 0 && options && typeof options.onFallback === 'function') {
    for (const fallback of fallbacks) {
      try {
        options.onFallback(fallback);
      } catch (_error) {
        // A misbehaving observer must not change the parse result.
      }
    }
  }

  // The accumulator was already narrowed to {@link CacheConfig} and frozen by
  // `parseCacheConfigDetailed`, so publishing it needs no further cast.
  return config;
}

/**
 * Reports which configured values were rejected and which defaults were applied,
 * without emitting any log or mutating module state.
 *
 * Intended for diagnostics and for asserting the accepted ranges in a runbook.
 *
 * @param {NodeJS.ProcessEnv|object|null} [env] - Environment variables to read from. Defaults to `process.env`.
 * @returns {ReadonlyArray<CacheConfigFallback>} Frozen diagnostics in declaration order; empty when nothing was rejected.
 */
function describeCacheConfigFallbacks(env = process.env) {
  return parseCacheConfigDetailed(env).fallbacks;
}

/** @type {{ warn: Function }|null|undefined} */
let resolvedLogger;

/**
 * Resolves the application logger, memoised.
 *
 * The `require` is deferred to first use and wrapped: a logger that fails to
 * initialise is an observability outage, not a reason to refuse to load cache
 * configuration (invariant 5).
 *
 * @returns {{ warn: Function }|null} The logger, or `null` when unavailable.
 */
function getLogger() {
  if (resolvedLogger === undefined) {
    try {
      const candidate = require('../logger');
      resolvedLogger =
        candidate && typeof candidate.warn === 'function'
          ? /** @type {{ warn: Function }} */ (candidate)
          : null;
    } catch (_error) {
      resolvedLogger = null;
    }
  }
  return resolvedLogger;
}

/**
 * Test seam: resets the memoised logger so a subsequent report re-resolves it.
 *
 * @returns {void}
 */
function _resetLoggerForTests() {
  resolvedLogger = undefined;
}

/** @type {Set<string>} */
const reportedFallbackIdentities = new Set();

/**
 * Emits one structured warning for a rejected value.
 *
 * Deliberately logs the variable name, the bounded reason, the default, and the
 * accepted range — never the raw value — so an operator can fix the setting
 * without a free-form string from the environment reaching a log sink.
 *
 * @param {CacheConfigFallback} fallback - Diagnostic to emit.
 * @returns {void}
 */
function writeFallbackWarning(fallback) {
  try {
    const logger = getLogger();
    if (!logger) {
      return;
    }
    logger.warn(
      {
        event: 'cache_config.fallback',
        variable: fallback.variable,
        key: fallback.key,
        reason: fallback.reason,
        envDefault: fallback.envDefault,
        minAccepted: fallback.min,
        maxAccepted: fallback.max,
        appliedValue: fallback.resolved,
      },
      'Cache configuration value rejected; applied the documented default',
    );
  } catch (_error) {
    // Invariant 5: observability must never be able to break configuration loading.
  }
}

/**
 * Emits warnings for diagnostics not yet reported.
 *
 * Deduplicated on `variable + reason` so that repeated reloads of an unchanged
 * environment — the retry path — cannot flood the log, while a newly broken or
 * newly fixed variable is still reported exactly once per distinct cause.
 *
 * @param {ReadonlyArray<CacheConfigFallback>} fallbacks - Diagnostics to report.
 * @returns {void}
 */
function reportFallbacks(fallbacks) {
  for (const fallback of fallbacks) {
    const identity = `${fallback.variable}:${fallback.reason}`;
    if (reportedFallbackIdentities.has(identity)) {
      continue;
    }
    reportedFallbackIdentities.add(identity);
    writeFallbackWarning(fallback);
  }
}

/** @type {CacheConfig} */
let activeConfig;

/** @type {ReadonlyArray<CacheConfigFallback>} */
let activeFallbacks;

/**
 * Parses the environment and atomically publishes the result.
 *
 * Publication is two single assignments of already-frozen, already-complete
 * values, and it happens before any reporting, so a reader always sees a
 * coherent pair and a throwing reporter cannot leave partial state (invariant 3).
 *
 * @param {NodeJS.ProcessEnv|object|null} env - Environment variables to read from.
 * @returns {CacheConfig} The newly active, frozen configuration.
 */
function activateCacheConfig(env) {
  const { config, fallbacks } = parseCacheConfigDetailed(env);
  activeFallbacks = fallbacks;
  activeConfig = config;
  reportFallbacks(fallbacks);
  return config;
}

/**
 * Returns the configuration that is currently active.
 *
 * Unlike the module-level `cacheConfig` binding — which is a load-time
 * snapshot kept for backward compatibility with `const { cacheConfig } = require(...)`
 * callers — this always reflects the most recent {@link reloadCacheConfig}.
 *
 * @returns {CacheConfig} Frozen active configuration.
 */
function getCacheConfig() {
  return activeConfig;
}

/**
 * Returns the diagnostics recorded by the most recent activation.
 *
 * @returns {ReadonlyArray<CacheConfigFallback>} Frozen diagnostics; empty when nothing was rejected.
 */
function getCacheConfigFallbacks() {
  return activeFallbacks;
}

/**
 * Re-reads the environment and atomically replaces the active configuration.
 *
 * Safe to call repeatedly and safe to call from several call sites: each call
 * either fully succeeds or leaves the previous configuration in place. Because
 * every field is derived from scratch, a retry after an operator fixes the
 * environment converges on the corrected values rather than on partially
 * applied ones.
 *
 * Consumers that captured the module-level `cacheConfig` binding at import time
 * keep their original values by design; they must call {@link getCacheConfig}
 * to observe a reload.
 *
 * @param {NodeJS.ProcessEnv|object|null} [env] - Environment variables to read from. Defaults to `process.env`.
 * @returns {CacheConfig} The newly active, frozen configuration.
 */
function reloadCacheConfig(env = process.env) {
  return activateCacheConfig(env);
}

/**
 * Test-only helper that clears the report de-duplication state and re-activates
 * the configuration from the current environment.
 *
 * @returns {void}
 */
function _resetCacheConfigForTests() {
  reportedFallbackIdentities.clear();
  activateCacheConfig(process.env);
}

// Load-time snapshot. Kept as a `const` binding so existing
// `const { cacheConfig } = require('../config/cache')` callers are unaffected.
const cacheConfig = activateCacheConfig(process.env);

module.exports = {
  cacheConfig,
  parseCacheConfig,
  describeCacheConfigFallbacks,
  getCacheConfig,
  getCacheConfigFallbacks,
  reloadCacheConfig,
  CACHE_CONFIG_FIELDS,
  CACHE_CONFIG_LIMITS,
  CACHE_CONFIG_FALLBACK_REASON,
  DEFAULT_ESCROW_TTL_SECONDS,
  DEFAULT_ESCROW_MAX_ENTRIES,
  DEFAULT_INDEXER_TTL_SECONDS,
  DEFAULT_INDEXER_MAX_ENTRIES,
  DEFAULT_INVOICE_STATE_TTL_SECONDS,
  DEFAULT_INVOICE_STATE_MAX_ENTRIES,
  _resetCacheConfigForTests,
  _resetLoggerForTests,
};
