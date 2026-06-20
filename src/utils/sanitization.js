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
const DEFAULT_MAX_ARRAY_LENGTH = 1000;
const DEFAULT_MAX_OBJECT_KEYS = 1000;

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
 * @param {number} [options.maxArrayLength=1000] Maximum array items to keep.
 * @param {number} [options.maxObjectKeys=1000] Maximum object keys to keep.
 * @returns {*} Sanitized value tree.
 */
function sanitizeValue(input, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const maxStringLength = Number.isInteger(options.maxStringLength)
    ? options.maxStringLength
    : DEFAULT_MAX_STRING_LENGTH;
  const maxArrayLength = Number.isInteger(options.maxArrayLength)
    ? options.maxArrayLength
    : DEFAULT_MAX_ARRAY_LENGTH;
  const maxObjectKeys = Number.isInteger(options.maxObjectKeys)
    ? options.maxObjectKeys
    : DEFAULT_MAX_OBJECT_KEYS;

  return sanitizeValueAtDepth(input, 0, {
    maxArrayLength,
    maxDepth,
    maxObjectKeys,
    maxStringLength,
  });
}

/**
 * Internal recursive sanitizer.
 *
 * @param {*} input Value to sanitize.
 * @param {number} depth Current recursion depth.
 * @param {{
 *   maxArrayLength: number,
 *   maxDepth: number,
 *   maxObjectKeys: number,
 *   maxStringLength: number
 * }} options Sanitization options.
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
    return input.slice(0, options.maxArrayLength)
      .map((item) => sanitizeValueAtDepth(item, depth + 1, options))
      .filter((item) => item !== undefined);
  }

  if (input && typeof input === 'object') {
    const sanitizedObject = Object.create(null);
    let copiedKeys = 0;

    for (const [key, value] of Object.entries(input)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }

      const sanitizedValue = sanitizeValueAtDepth(value, depth + 1, options);
      if (sanitizedValue !== undefined) {
        sanitizedObject[key] = sanitizedValue;
        copiedKeys += 1;
      }

      if (copiedKeys >= options.maxObjectKeys) {
        break;
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
