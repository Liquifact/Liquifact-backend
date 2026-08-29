'use strict';

/**
 * @fileoverview Field-level redaction for provider-failure telemetry.
 *
 * KYC provider errors, and the network/transport errors nested under their
 * `cause` chain, can carry identity or document data — a provider might echo
 * back an invalid document number, or a raw network error's message might
 * happen to include request details. None of that may reach logs, traces, or
 * metrics (issue #1200).
 *
 * This module is deliberately generic (not KYC-specific in implementation)
 * so any future provider integration can reuse it, while the exported
 * {@link IDENTITY_FIELD_PATTERNS} denylist is tuned for identity/document
 * data specifically.
 *
 * Relationship to existing redaction utilities: {@link module:services/auditLogStore}
 * already exports `redactValue`, a recursive key-name redactor used by eight
 * other modules for credential-shaped secrets (password, token, apiKey, ...).
 * This module reuses its `SENSITIVE_KEY_PATTERNS` denylist (the *policy* —
 * which key names count as sensitive) rather than its recursive
 * implementation: `redactValue`'s own recursion has no depth or cycle bound,
 * which is fine for the plain configuration/audit-metadata trees it was
 * built for, but not safe to delegate a whole error/cause subtree to here,
 * since a circular `cause` chain must terminate. This module does its own
 * single, depth-bounded recursive walk instead, checking each key against
 * the combined `SENSITIVE_KEY_PATTERNS` + {@link IDENTITY_FIELD_PATTERNS}
 * denylist directly. It adds three capabilities `redactValue` does not have:
 *
 *   1. Error/`cause`-chain awareness. `Error#message` is a non-enumerable
 *      own property, so `Object.entries(err)` silently skips it — a plain
 *      key-name redactor passed a raw Error never touches `message` at all.
 *   2. Free-text scanning. A provider error string like "document 987654321
 *      is invalid" has no recognisable key name to redact against; the
 *      sensitive value is embedded in prose.
 *   3. Bounded output. A large binary-like value (e.g. a base64-encoded
 *      document scan a misbehaving provider echoes back) must not be logged
 *      verbatim even if no specific pattern matches it.
 *
 * @module utils/telemetryRedaction
 */

const { REDACTED, SENSITIVE_KEY_PATTERNS } = require('../services/auditLogStore');

/**
 * Bound on how many characters of a single string value are ever emitted to
 * telemetry verbatim. Longer values are replaced with a length-only
 * placeholder — this is what protects against the "large binary-like value"
 * case (e.g. a base64 document scan) even when no specific PII pattern in
 * {@link sanitizeTelemetryString} matches it.
 *
 * @constant {number}
 */
const MAX_TELEMETRY_STRING_LENGTH = 500;

/**
 * Bound on recursion depth for both `cause` chains and nested object/array
 * trees. This guarantees {@link redactForTelemetry} and
 * {@link redactErrorForTelemetry} always terminate — including for a
 * circular `cause` chain — without needing cycle detection: depth increases
 * on every recursive call regardless of whether the graph actually cycles,
 * so a bounded depth is sufficient on its own.
 *
 * @constant {number}
 */
const MAX_REDACTION_DEPTH = 6;

/**
 * Identity/document-oriented key-name patterns, layered on top of
 * `auditLogStore`'s credential-oriented `SENSITIVE_KEY_PATTERNS` (imported
 * and combined directly — see the module-level doc comment for why this
 * module does its own recursion rather than calling `redactValue`).
 * Deliberately does NOT include a bare `/address/i` pattern: elsewhere in
 * this codebase "address" overwhelmingly means a public Stellar contract or
 * escrow address (`contractAddress`, `escrowAddress`), not a mailing
 * address, and those are explicitly treated as safe-to-log throughout the
 * escrow/reconciliation code. Only the more specific `street/mailing/home
 * address` and `postal/zip code` variants are included here.
 *
 * @constant {ReadonlyArray<RegExp>}
 */
const IDENTITY_FIELD_PATTERNS = Object.freeze([
  /ssn/i,
  /social[-_]?security/i,
  /date[-_]?of[-_]?birth/i,
  /\bdob\b/i,
  /document[-_]?number/i,
  /passport/i,
  /driver[-_]?s?[-_]?licen[sc]e/i,
  /national[-_]?id/i,
  /tax[-_]?id/i,
  /card[-_]?number/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /bank[-_]?account/i,
  /account[-_]?number/i,
  /routing[-_]?number/i,
  /\biban\b/i,
  /full[-_]?name/i,
  /first[-_]?name/i,
  /last[-_]?name/i,
  /middle[-_]?name/i,
  /email/i,
  /phone/i,
  /street[-_]?address/i,
  /mailing[-_]?address/i,
  /home[-_]?address/i,
  /postal[-_]?code/i,
  /zip[-_]?code/i,
]);

/**
 * The full key-name denylist this module checks against: the shared
 * credential-oriented patterns plus this module's own identity/document
 * patterns, combined once at module load.
 *
 * @constant {ReadonlyArray<RegExp>}
 */
const ALL_SENSITIVE_KEY_PATTERNS = Object.freeze([...SENSITIVE_KEY_PATTERNS, ...IDENTITY_FIELD_PATTERNS]);

/**
 * Matches a US Social Security Number shape (###-##-####).
 * @constant {RegExp}
 */
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Matches an email address embedded in free text.
 * @constant {RegExp}
 */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Matches a run of 6+ consecutive digits — a conservative heuristic that
 * catches document, passport, account, and card numbers embedded in prose
 * with no recognisable key name (e.g. "document 987654321 is invalid").
 *
 * This is intentionally biased toward over-redaction: a benign 6+ digit
 * number (an unusually large millisecond duration, say) may occasionally get
 * redacted from a log message. That is an acceptable false positive for a
 * security control — the alternative (a false negative that leaks a real
 * document number) is the one this ticket exists to close. See PR "Design
 * notes" for this tradeoff.
 *
 * @constant {RegExp}
 */
const LONG_DIGIT_RUN_PATTERN = /\b\d{6,}\b/g;

/**
 * Sanitizes a single string value for telemetry: truncates it if it exceeds
 * {@link MAX_TELEMETRY_STRING_LENGTH} (the "large binary-like value" case),
 * otherwise scrubs any embedded SSN-shaped, email-shaped, or long-digit-run
 * substrings in place while leaving the rest of the text readable.
 *
 * Non-string input is returned unchanged (callers may pass through this
 * function defensively without a type check).
 *
 * @param {*} value - Candidate string (or any other value, passed through).
 * @returns {*} Sanitized string, or the original value if not a string.
 */
function sanitizeTelemetryString(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length > MAX_TELEMETRY_STRING_LENGTH) {
    return `[REDACTED:large-value length=${value.length}]`;
  }
  return value
    .replace(SSN_PATTERN, REDACTED)
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(LONG_DIGIT_RUN_PATTERN, REDACTED);
}

/**
 * Recursively redacts an arbitrary value for safe inclusion in logs, trace
 * attributes, or metric labels. Handles primitives, strings (via
 * {@link sanitizeTelemetryString}), arrays, plain objects (via `redactValue`
 * with {@link IDENTITY_FIELD_PATTERNS}, then a second pass applying string
 * scrubbing to the surviving leaves), and `Error` instances (delegated to
 * {@link redactErrorForTelemetry}). `null`/`undefined` pass through
 * unchanged so callers never need a separate null check.
 *
 * Never throws on malformed input — an object with unusual shape, a
 * non-Error value with an `Error`-like shape, or a circular structure all
 * degrade gracefully rather than raising.
 *
 * @param {*} value - Value to redact.
 * @param {number} [depth=0] - Internal recursion counter; callers should omit this.
 * @returns {*} Redacted value, safe to pass to a logger, tracer, or metrics label.
 */
function redactForTelemetry(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth > MAX_REDACTION_DEPTH) {
    return '[REDACTED:depth-exceeded]';
  }
  if (value instanceof Error) {
    return redactErrorForTelemetry(value, depth);
  }
  if (typeof value === 'string') {
    return sanitizeTelemetryString(value);
  }
  if (typeof value !== 'object') {
    return value; // numbers, booleans, bigint, symbol, function — pass through
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForTelemetry(item, depth + 1));
  }

  // Plain object: key-name redaction (shared credential patterns + this
  // module's identity patterns) and string-content scrubbing happen in the
  // same depth-bounded pass — see the module-level doc comment for why this
  // does not delegate to `redactValue`'s own (unbounded) recursion.
  const result = {};
  for (const [key, currentValue] of Object.entries(value)) {
    if (ALL_SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactForTelemetry(currentValue, depth + 1);
  }
  return result;
}

/**
 * Redacts an `Error` (or error-like) value into a minimal, safe summary
 * suitable for a structured log field: `{ name, message, code?, status?,
 * retryable?, cause? }`.
 *
 * Deliberately allowlists which fields are carried over from the source
 * error rather than spreading its own-enumerable properties: an unknown
 * error subclass (a future provider client's own error type, say) could
 * attach an arbitrary field — `err.applicantData`, for instance — that this
 * module's key-name/content patterns were never written to anticipate. Only
 * the fields every error class in this codebase's KYC provider path
 * actually uses (see `KycProviderError`, `KycUpstreamUnavailableError`,
 * `KycWebhookError`) are read; everything else on the error object is
 * ignored rather than risked.
 *
 * `cause` is redacted recursively (bounded by {@link MAX_REDACTION_DEPTH}),
 * so a chain of nested transport errors is fully sanitized, not just the
 * outermost one.
 *
 * `null`/`undefined` pass through unchanged. A non-Error value (a plain
 * object, a string, a malformed shape) is redacted via
 * {@link redactForTelemetry} instead of being treated as an error — this
 * function never throws regardless of what it is given.
 *
 * @param {*} err - Error instance, error-like value, or arbitrary value.
 * @param {number} [depth=0] - Internal recursion counter; callers should omit this.
 * @returns {*} Safe summary object, or the redacted original value if `err` was not an Error.
 */
function redactErrorForTelemetry(err, depth = 0) {
  if (err === null || err === undefined) {
    return err;
  }
  if (depth > MAX_REDACTION_DEPTH) {
    return '[REDACTED:cause-depth-exceeded]';
  }
  if (!(err instanceof Error)) {
    return redactForTelemetry(err, depth);
  }

  const rawMessage = typeof err.message === 'string' ? err.message : String(err.message);
  const summary = {
    name: typeof err.name === 'string' ? err.name : 'Error',
    message: sanitizeTelemetryString(rawMessage),
  };
  if (err.code !== undefined) {
    summary.code = err.code;
  }
  if (err.status !== undefined) {
    summary.status = err.status;
  }
  if (err.retryable !== undefined) {
    summary.retryable = err.retryable;
  }
  if (err.cause !== undefined) {
    summary.cause = redactErrorForTelemetry(err.cause, depth + 1);
  }
  return summary;
}

module.exports = {
  MAX_TELEMETRY_STRING_LENGTH,
  MAX_REDACTION_DEPTH,
  IDENTITY_FIELD_PATTERNS,
  sanitizeTelemetryString,
  redactForTelemetry,
  redactErrorForTelemetry,
};
