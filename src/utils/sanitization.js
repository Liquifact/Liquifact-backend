/**
 * Input sanitization and normalization helpers for user-supplied data.
 *
 * The goal is to normalize strings consistently and reduce common abuse cases:
 * - control-character/log-forging payloads
 * - malformed unicode
 * - prototype-pollution keys in object payloads
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_STRING_LENGTH = 4096;

/**
 * Sanitizes and normalizes a user-supplied string.
 *
 * @param {string} value Raw user string.
 * @param {object} [options] String sanitization options.
 * @param {number} [options.maxLength=4096] Maximum normalized string length.
 * @returns {string} Normalized safe string.
 */
function sanitizeUserString(value, options = {}) {
  const maxLength = Number.isInteger(options.maxLength)
    ? options.maxLength
    : DEFAULT_MAX_STRING_LENGTH;

  const normalized = value
    .normalize('NFKC')
    // Remove non-printable control characters while preserving readability.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Prevent log/header injection via CRLF and normalize odd spacing.
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

/**
 * Recursively sanitizes a value tree.
 *
 * Strings are normalized, arrays are mapped, and objects are rebuilt with
 * dangerous keys removed.
 *
 * @param {*} input Value to sanitize.
 * @param {object} [options] Tree sanitization options.
 * @param {number} [options.maxDepth=20] Maximum recursion depth.
 * @param {number} [options.maxStringLength=4096] Maximum string length.
 * @returns {*} Sanitized value tree.
 */
function sanitizeValue(input, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const maxStringLength = Number.isInteger(options.maxStringLength)
    ? options.maxStringLength
    : DEFAULT_MAX_STRING_LENGTH;

  return sanitizeValueAtDepth(input, 0, { maxDepth, maxStringLength });
}

/**
 * Internal recursive sanitizer.
 *
 * @param {*} input Value to sanitize.
 * @param {number} depth Current recursion depth.
 * @param {{ maxDepth: number, maxStringLength: number }} options Sanitization options.
 * @returns {*} Sanitized value.
 */
function sanitizeValueAtDepth(input, depth, options) {
  if (depth > options.maxDepth) {
    return undefined;
  }

  if (typeof input === 'string') {
    return sanitizeUserString(input, { maxLength: options.maxStringLength });
  }

  if (Array.isArray(input)) {
    return input
      .map((item) => sanitizeValueAtDepth(item, depth + 1, options))
      .filter((item) => item !== undefined);
  }

  if (input && typeof input === 'object') {
    const sanitizedObject = {};

    for (const [key, value] of Object.entries(input)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }

      const sanitizedValue = sanitizeValueAtDepth(value, depth + 1, options);
      if (sanitizedValue !== undefined) {
        sanitizedObject[key] = sanitizedValue;
      }
    }

    return sanitizedObject;
  }

  return input;
}

module.exports = {
  sanitizeUserString,
  sanitizeValue,
};
