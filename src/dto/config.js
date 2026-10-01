'use strict';

/**
 * @fileoverview Typed DTO helpers for admin config request/response boundaries
 * with explicit compatibility contract preservation.
 *
 * Public contract invariants (must remain stable across upgrades):
 * - All mapper functions accept unknown/untrusted input and return normalized DTOs
 * - Invalid/missing/malformed input produces safe defaults (empty strings/objects/arrays)
 * - No exceptions thrown for any input shape (defensive normalization)
 * - Return shapes are frozen to prevent mutation by callers
 * - Null, undefined, arrays, primitives, and objects all handled deterministically
 *
 * Boundary guarantees:
 * - toAdminConfigRequestDto: unknown → AdminConfigRequestDto
 * - fromAdminConfigRequestDto: AdminConfigRequestDto → AdminConfigRequestDto (idempotent)
 * - toAdminConfigResponseDto: unknown → AdminConfigResponseDto
 * - fromAdminConfigResponseDto: AdminConfigResponseDto → AdminConfigResponseDto (idempotent)
 * - toConfigSectionsResponseDto: unknown → ConfigSectionsResponseDto
 * - fromConfigSectionsResponseDto: ConfigSectionsResponseDto → ConfigSectionsResponseDto (idempotent)
 *
 * Failure modes (all handled gracefully, no exceptions):
 * - null/undefined input → DTO with empty/zero values
 * - Array input (when object expected) → DTO with empty/zero values
 * - Primitive input (string/number/boolean) → DTO with empty/zero values
 * - Missing required fields → DTO with empty/zero defaults
 * - Wrong field types → Fields normalized to expected type or empty default
 * - Nested objects/arrays in config → shallow-copied to prevent mutation
 * - Prototype pollution attempts → filtered out (only own enumerable properties copied)
 *
 * Compatibility notes:
 * - Adding optional fields to DTOs is backward-compatible
 * - Removing/renaming existing fields is breaking; requires migration path
 * - Safe defaults preserve fail-safe behavior under malformed input
 * - Frozen returns prevent accidental mutation bugs in consuming code
 *
 * @module dto/config
 */

const { CONFIG_SECTIONS } = require('../schemas/config');

/**
 * Validate that a value is a plain record with only the allowed own keys.
 *
 * @param {unknown} value - Value to validate.
 * @param {string[]} allowedKeys - Keys accepted at this DTO boundary.
 * @param {string} label - Name used in the error message.
 * @param {string[]} requiredKeys - Keys that must be own properties.
 * @returns {Record<string, unknown>} The validated record.
 * @throws {TypeError} If the value is not a plain record or has extra keys.
 */
function requireRecord(value, allowedKeys, label, requiredKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new TypeError(`${label} contains unsupported fields`);
  }

  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing required fields`);
  }

  return value;
}

/**
 * Validate a known configuration section name.
 *
 * @param {unknown} section - Section value to validate.
 * @returns {string} The validated section name.
 * @throws {TypeError} If the section is not supported.
 */
function requireSection(section) {
  if (typeof section !== 'string' || !CONFIG_SECTIONS.includes(section)) {
    throw new TypeError('section must be a supported configuration section');
  }

  return section;
}

/**
 * Validate section-specific config as a plain record.
 * Field-level constraints remain the responsibility of the section schemas.
 *
 * @param {unknown} config - Config payload to validate.
 * @returns {Record<string, unknown>} A shallow copy of the validated config.
 * @throws {TypeError} If config is not a plain object.
 */
function requireConfig(config) {
  const allowedKeys = config && typeof config === 'object' && !Array.isArray(config)
    ? Object.keys(config)
    : [];
  const record = requireRecord(config, allowedKeys, 'config');
  return { ...record };
}

/**
 * @typedef {Object} AdminConfigRequestDto
 * @property {string} section - Configuration section name.
 * @property {Record<string, unknown>} config - Section-specific configuration payload.
 */

/**
 * @typedef {Object} AdminConfigResponseDto
 * @property {string} section - Configuration section name.
 * @property {Record<string, unknown>} config - Accepted section payload.
 * @property {string} message - Human-readable success message.
 */

/**
 * @typedef {Object} ConfigSectionsResponseDto
 * @property {string[]} sections - Valid configuration section names.
 */

/**
 * Copy config data so nested mutable values are not shared across DTO boundaries.
 * Config payloads are structured-cloneable JSON data after request validation.
 *
 * @param {Record<string, unknown>} config - Config payload to copy.
 * @returns {Record<string, unknown>} An independent config snapshot.
 */
function cloneConfig(config) {
  return structuredClone(config);
}

/**
 * Map a raw admin config request payload into a typed request DTO.
 *
 * Boundary contract:
 * - Accepts any input type (unknown) without throwing
 * - Returns AdminConfigRequestDto with valid structure
 * - Invalid/missing fields normalize to safe defaults (empty string, empty object)
 * - Return value is frozen to prevent caller mutations
 * - Idempotent: calling on a DTO returns an equivalent DTO
 *
 * Normalization rules:
 * - null/undefined/primitives/arrays → { section: '', config: {} }
 * - Missing section field → section: ''
 * - Non-string section → section: ''
 * - Missing config field → config: {}
 * - Non-object config → config: {}
 * - Array config → config: {}
 * - Valid config object → shallow copy to prevent mutation
 *
 * Security:
 * - Shallow copy protects against prototype pollution
 * - Only own enumerable properties are copied
 * - Frozen return prevents post-construction mutation
 *
 * @param {unknown} payload - Raw request payload from the route boundary.
 * @returns {AdminConfigRequestDto} A normalized, frozen request DTO.
 */
function toAdminConfigRequestDto(payload) {
  // Reject non-object types (null, primitives, arrays)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return Object.freeze({ section: '', config: Object.freeze({}) });
  }
  void formatted; // used above for structure, messages taken from issues

  // Normalize section to string or empty default
  const section = typeof payload.section === 'string' ? payload.section : '';

  // Normalize config to object or empty default
  // Shallow copy to prevent mutation of input and avoid prototype pollution
  let config = {};
  if (payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)) {
    // Shallow copy only own enumerable properties
    config = Object.assign({}, payload.config);
  }

  return Object.freeze({ section, config: Object.freeze(config) });
}

/**
 * Strip numeric literals and long strings from Zod issue messages to prevent
 * accidental secret exposure in structured error output.
 *
 * Boundary contract:
 * - Idempotent: fromAdminConfigRequestDto(toAdminConfigRequestDto(x)) === toAdminConfigRequestDto(x)
 * - Delegates to toAdminConfigRequestDto for consistent normalization
 * - Accepts any input, returns frozen normalized DTO
 * - Preserves backward compatibility for existing callers
 *
 * @param {AdminConfigRequestDto} dto - Request DTO to normalize back to plain object form.
 * @returns {AdminConfigRequestDto} A normalized, frozen request DTO.
 */
function _sanitizeZodMessage(msg) {
  // Replace anything that looks like a raw value (quoted strings, long hex/tokens)
  return msg
    .replace(/"[^"]{8,}"/g, '"<redacted>"')
    .replace(/\b[a-f0-9]{16,}\b/gi, '<redacted>');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `ConfigDto` from a raw environment variables map.
 *
 * Boundary contract:
 * - Accepts any input type (unknown) without throwing
 * - Returns AdminConfigResponseDto with valid structure
 * - Invalid/missing fields normalize to safe defaults
 * - Return value is frozen to prevent caller mutations
 * - Idempotent: calling on a DTO returns an equivalent DTO
 *
 * Normalization rules:
 * - null/undefined/primitives/arrays → { section: '', config: {}, message: '' }
 * - Missing section field → section: ''
 * - Non-string section → section: ''
 * - Missing config field → config: {}
 * - Non-object config → config: {}
 * - Array config → config: {}
 * - Valid config object → shallow copy to prevent mutation
 * - Missing message field → message: ''
 * - Non-string message → message: ''
 *
 * Security:
 * - Shallow copy protects against prototype pollution
 * - Only own enumerable properties are copied
 * - Frozen return prevents post-construction mutation
 *
 * @param {unknown} payload - Raw response payload from the route boundary.
 * @returns {AdminConfigResponseDto} A normalized, frozen response DTO.
 */
function toAdminConfigResponseDto(payload) {
  // Reject non-object types (null, primitives, arrays)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return Object.freeze({ section: '', config: Object.freeze({}), message: '' });
  }

  // Normalize section to string or empty default
  const section = typeof payload.section === 'string' ? payload.section : '';

  // Normalize config to object or empty default
  // Shallow copy to prevent mutation of input and avoid prototype pollution
  let config = {};
  if (payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)) {
    // Shallow copy only own enumerable properties
    config = Object.assign({}, payload.config);
  }

  // Normalize message to string or empty default
  const message = typeof payload.message === 'string' ? payload.message : '';

  return Object.freeze({ section, config: Object.freeze(config), message });
}

/**
 * Parse the current `process.env` into a `ConfigResult`.
 *
 * Boundary contract:
 * - Idempotent: fromAdminConfigResponseDto(toAdminConfigResponseDto(x)) === toAdminConfigResponseDto(x)
 * - Delegates to toAdminConfigResponseDto for consistent normalization
 * - Accepts any input, returns frozen normalized DTO
 * - Preserves backward compatibility for existing callers
 *
 * @param {AdminConfigResponseDto} dto - Response DTO to normalize back to plain object form.
 * @returns {AdminConfigResponseDto} A normalized, frozen response DTO.
 */
function parseConfigDto(env = process.env) {
  try {
    const dto = buildConfigDto(env);
    return { ok: true, dto };
  } catch (err) {
    if (err instanceof ConfigError) {
      return { ok: false, error: err };
    }

/**
 * Map a list of config sections into the typed sections response DTO.
 *
 * Boundary contract:
 * - Accepts any input type (unknown) without throwing
 * - Returns ConfigSectionsResponseDto with valid structure
 * - Non-array input normalizes to empty array
 * - Array input is filtered to include only string elements
 * - Return value is frozen to prevent caller mutations
 * - Idempotent: calling on a DTO returns an equivalent DTO
 *
 * Normalization rules:
 * - null/undefined/primitives/objects → { sections: [] }
 * - Array with non-string elements → non-string elements filtered out
 * - Array with all strings → all strings preserved in frozen array
 * - Empty array → { sections: [] }
 *
 * Security:
 * - Filters out non-string elements to prevent type confusion
 * - Creates new array to prevent mutation of input
 * - Frozen return prevents post-construction mutation
 *
 * @param {unknown} sections - Raw section list from the route boundary.
 * @returns {ConfigSectionsResponseDto} A normalized, frozen sections response DTO.
 */
function toConfigSectionsResponseDto(sections) {
  // Reject non-array types
  if (!Array.isArray(sections)) {
    return Object.freeze({ sections: Object.freeze([]) });
  }

  // Filter to only string elements, creating a new array
  const filteredSections = sections.filter((section) => typeof section === 'string');

  return Object.freeze({ sections: Object.freeze(filteredSections) });
}

/**
 * Parse config and throw immediately on failure.
 *
 * Boundary contract:
 * - Idempotent: fromConfigSectionsResponseDto(toConfigSectionsResponseDto(x)) === toConfigSectionsResponseDto(x)
 * - Extracts sections array from DTO and re-normalizes
 * - Handles missing/invalid dto gracefully
 * - Returns frozen normalized DTO
 * - Preserves backward compatibility for existing callers
 *
 * Normalization rules:
 * - null/undefined dto → { sections: [] }
 * - dto without sections field → { sections: [] }
 * - dto with non-array sections → { sections: [] }
 * - dto with valid sections array → normalized and frozen
 *
 * @param {ConfigSectionsResponseDto} dto - Sections DTO to normalize back to plain object form.
 * @returns {ConfigSectionsResponseDto} A normalized, frozen sections DTO.
 */
function fromConfigSectionsResponseDto(dto) {
  const record = requireRecord(dto, ['sections'], 'sections response', ['sections']);
  return toConfigSectionsResponseDto(record.sections);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildConfigDto,
  parseConfigDto,
  requireConfigDto,
  ConfigError,
  CONFIG_ERROR_CODES,
};
