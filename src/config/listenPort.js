'use strict';

/**
 * @fileoverview Validation boundary for the port an entry point binds.
 *
 * ## Why this module exists
 * `net.Server.listen()` dispatches on the *type* of its first argument, not on
 * its content. A value that is a string but not a valid decimal port is treated
 * as a **Unix domain socket path**. Passing the raw `process.env.PORT` string
 * straight to `app.listen()` therefore produces these outcomes, none of which
 * are an error:
 *
 * | `PORT`      | Actual behaviour before this module                    |
 * |-------------|-------------------------------------------------------|
 * | `not-a-port`| silently binds a Unix socket at `./not-a-port`        |
 * | `8080abc`   | silently binds a Unix socket at `./8080abc`           |
 * | `-1`        | silently binds a Unix socket at `./-1`                |
 * | `0x1f`      | silently binds **TCP port 31** (hex is parsed)        |
 * | `3001.5`    | throws `ERR_SOCKET_BAD_PORT` with no redacted context |
 *
 * A typo in a deployment manifest must not be able to create a stray socket
 * file, silently move the service to an unreachishable port, or escape as an
 * unhandled `RangeError`. This module is the single place where that input is
 * accepted or rejected, so every entry point behaves identically.
 *
 * ## Invariants
 * 1. **Accepted** values are decimal integers only. No signs, radix prefixes,
 *    decimal points, exponents, or trailing characters - each of those is a
 *    different value to `Number()` and to `net`.
 * 2. **Range** is `[1, 65535]` for the `PORT` environment variable, matching
 *    `ConfigSchema.PORT` in `./index.js`. The two must stay aligned; the
 *    equality is asserted by `tests/index.bootValidation.test.js`.
 * 3. **Absent** (`undefined`, `null`, empty/blank) means "use the default",
 *    which preserves the previous `process.env.PORT || 3001` behaviour.
 * 4. The explicit {@link validatePortArgument} boundary additionally accepts
 *    `0`, because "let the OS choose an ephemeral port" is a legitimate
 *    in-process/test affordance. `PORT=0` in the environment stays rejected:
 *    a deployment that asked for an ephemeral port is a misconfiguration that
 *    would put the service on a port no proxy or health check knows about.
 * 5. Rejection is **total**: every invalid input throws
 *    {@link PortValidationError}. Nothing is clamped, coerced, or defaulted,
 *    because silently correcting a port hides the misconfiguration and can
 *    move traffic to a port the operator did not choose.
 * 6. Errors and logs never echo a raw operator value. Values are rendered by
 *    {@link describeValue}, which quotes strings, strips control characters
 *    (so a hostile `PORT` cannot forge a log line), and truncates. Non-string
 *    values are described by type only, so an object or function is never
 *    serialised into a log.
 *
 * @module config/listenPort
 */

/** Port used when no valid port is supplied. @type {number} */
const DEFAULT_PORT = 3001;

/** Lowest port the `PORT` environment variable may request. @type {number} */
const MIN_ENV_PORT = 1;

/** Lowest port an explicit argument may request (0 = ephemeral). @type {number} */
const MIN_ARGUMENT_PORT = 0;

/** Highest port accepted by either boundary. @type {number} */
const MAX_LISTEN_PORT = 65535;

/** Longest value rendered into an error or log before truncation. @type {number} */
const MAX_RENDERED_LENGTH = 64;

/**
 * Matches a bare run of decimal digits.
 *
 * Anchored on both ends and free of backtracking, so it is safe on
 * operator-controlled input of any length. It deliberately rejects `+1`, `-1`,
 * `1.0`, `1e3`, `0x1f`, `0b11`, ` 1` (leading blanks are trimmed first, so
 * they are accepted) and `1x`.
 *
 * @type {RegExp}
 */
const DECIMAL_DIGITS = /^\d+$/;

/**
 * Stable machine-readable reasons a port was rejected.
 *
 * Message wording may change; these codes are the contract for logs, tests
 * and any operator tooling that reacts differently to a malformed value than to
 * an out-of-range one.
 *
 * @readonly
 * @enum {string}
 */
const PORT_VALIDATION_CODES = Object.freeze({
  /** Value was not a JavaScript number where a number is required. */
  PORT_TYPE_INVALID: 'PORT_TYPE_INVALID',
  /** Value was `NaN` or a non-finite number. */
  PORT_NOT_A_NUMBER: 'PORT_NOT_A_NUMBER',
  /** Value had a fractional part. */
  PORT_NOT_AN_INTEGER: 'PORT_NOT_AN_INTEGER',
  /** Environment string was not a bare run of decimal digits. */
  PORT_FORMAT_INVALID: 'PORT_FORMAT_INVALID',
  /** Value was below the minimum allowed for its boundary. */
  PORT_BELOW_MINIMUM: 'PORT_BELOW_MINIMUM',
  /** Value was above {@link MAX_LISTEN_PORT}. */
  PORT_ABOVE_MAXIMUM: 'PORT_ABOVE_MAXIMUM',
});

/**
 * Renders a rejected value for a human reader and a log sink.
 *
 * Strings are JSON-quoted, which neutralises embedded newlines and other
 * control characters (log forging) before truncation. Every other type is
 * reduced to its `typeof` so no object graph or function source is ever
 * serialised.
 *
 * @param {unknown} value - The rejected value.
 * @returns {string} A short, safe description of `value`.
 */
function describeValue(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }

  const type = typeof value;

  if (type === 'string') {
    const truncated =
      value.length > MAX_RENDERED_LENGTH
        ? `${value.slice(0, MAX_RENDERED_LENGTH)}…`
        : value;
    return JSON.stringify(truncated);
  }
  if (type === 'bigint' || type === 'boolean' || type === 'symbol') {
    return String(value);
  }
  if (type === 'number') {
    return String(value);
  }

  return type;
}

/**
 * Error raised when a listen port fails either boundary.
 *
 * Carries a stable `code` and a `source` so callers can react without parsing
 * messages, plus a `received` field that is safe to log.
 *
 * @extends Error
 */
class PortValidationError extends Error {
  /**
   * Builds the rejection. `reason` is composed by the calling boundary so the
   * message states the rule that was actually broken.
   *
   * @param {Object} params
   * @param {string} params.code - Member of {@link PORT_VALIDATION_CODES}.
   * @param {string} params.source - Which boundary rejected the value (`env` or `argument`).
   * @param {string} params.variable - Environment variable name, when the value came from the environment.
   * @param {number} params.min - Inclusive minimum for the boundary.
   * @param {unknown} params.received - The rejected value (rendered via {@link describeValue}).
   * @param {string} params.reason - Operator-facing explanation of the rule.
   */
  constructor({ code, source, variable, min: _min, received, reason }) {
    const subject = source === 'env' ? variable : 'listen port argument';
    super(`${subject} ${reason} (received ${describeValue(received)}).`);

    this.name = 'PortValidationError';
    this.code = code;
    this.source = source;
    this.received = describeValue(received);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validates the listen port that came from the environment.
 *
 * @param {unknown} rawValue - Raw `process.env.PORT` value.
 * @returns {number} A port in `[1, 65535]`, or {@link DEFAULT_PORT} when absent.
 * @throws {PortValidationError} If the value is present but not a usable port.
 */
function resolvePortFromEnv(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return DEFAULT_PORT;
  }

  if (typeof rawValue !== 'string') {
    throw new PortValidationError({
      code: PORT_VALIDATION_CODES.PORT_TYPE_INVALID,
      source: 'env',
      variable: 'PORT',
      min: MIN_ENV_PORT,
      received: rawValue,
      reason: `must be a string between ${MIN_ENV_PORT} and ${MAX_LISTEN_PORT}`,
    });
  }

  const trimmed = rawValue.trim();

  // An unset or blank variable keeps the documented default. This matches the
  // previous `process.env.PORT || 3001` behaviour, where '' was falsy.
  if (trimmed === '') {
    return DEFAULT_PORT;
  }

  if (!DECIMAL_DIGITS.test(trimmed)) {
    throw new PortValidationError({
      code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID,
      source: 'env',
      variable: 'PORT',
      min: MIN_ENV_PORT,
      received: rawValue,
      reason: `must be a plain decimal integer with no sign, radix prefix, or decimal point, between ${MIN_ENV_PORT} and ${MAX_LISTEN_PORT}`,
    });
  }

  const port = Number(trimmed);

  if (!Number.isSafeInteger(port)) {
    throw new PortValidationError({
      code: PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM,
      source: 'env',
      variable: 'PORT',
      min: MIN_ENV_PORT,
      received: rawValue,
      reason: `must be between ${MIN_ENV_PORT} and ${MAX_LISTEN_PORT}`,
    });
  }

  if (port < MIN_ENV_PORT) {
    throw new PortValidationError({
      code: PORT_VALIDATION_CODES.PORT_BELOW_MINIMUM,
      source: 'env',
      variable: 'PORT',
      min: MIN_ENV_PORT,
      received: rawValue,
      reason:
        `must be at least ${MIN_ENV_PORT}; port 0 requests an ephemeral port that no ` +
        'proxy, service discovery record, or health check can target',
    });
  }

  if (port > MAX_LISTEN_PORT) {
    throw new PortValidationError({
      code: PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM,
      source: 'env',
      variable: 'PORT',
      min: MIN_ENV_PORT,
      received: rawValue,
      reason: `must be between ${MIN_ENV_PORT} and ${MAX_LISTEN_PORT}`,
    });
  }

  return port;
}

/**
 * Validates an explicit listen port passed by a caller.
 *
 * Accepts only a real JavaScript number: a string is a programming error at the
 * call site, not something to coerce, because coercion is exactly the mechanism
 * that produced the silent Unix-socket binds documented above.
 *
 * @param {unknown} value - Candidate port, or `undefined`/`null` for "no override".
 * @returns {number|null} A port in `[0, 65535]`, or `null` when no override was given.
 * @throws {PortValidationError} If an override is present but not a usable port.
 */
function validatePortArgument(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const reject = (code, reason) => {
    throw new PortValidationError({
      code,
      source: 'argument',
      variable: 'port',
      min: MIN_ARGUMENT_PORT,
      received: value,
      reason,
    });
  };

  if (typeof value !== 'number') {
    reject(
      PORT_VALIDATION_CODES.PORT_TYPE_INVALID,
      `must be a number between ${MIN_ARGUMENT_PORT} and ${MAX_LISTEN_PORT}, not a ${typeof value}`
    );
  }

  if (!Number.isFinite(value)) {
    reject(PORT_VALIDATION_CODES.PORT_NOT_A_NUMBER, 'must be a finite number');
  }

  if (!Number.isInteger(value)) {
    reject(PORT_VALIDATION_CODES.PORT_NOT_AN_INTEGER, 'must be an integer without a fractional part');
  }

  if (value < MIN_ARGUMENT_PORT) {
    reject(
      PORT_VALIDATION_CODES.PORT_BELOW_MINIMUM,
      `must be between ${MIN_ARGUMENT_PORT} and ${MAX_LISTEN_PORT}`
    );
  }

  if (value > MAX_LISTEN_PORT) {
    reject(
      PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM,
      `must be between ${MIN_ARGUMENT_PORT} and ${MAX_LISTEN_PORT}`
    );
  }

  return value;
}

module.exports = {
  DEFAULT_PORT,
  MAX_LISTEN_PORT,
  MIN_ARGUMENT_PORT,
  MIN_ENV_PORT,
  PortValidationError,
  PORT_VALIDATION_CODES,
  describeValue,
  resolvePortFromEnv,
  validatePortArgument,
};
