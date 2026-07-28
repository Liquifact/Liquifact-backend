'use strict';

const { VALID_SCOPES, API_KEY_PREFIX, MIN_KEY_LENGTH } = require('../config/apiKeys');

/**
 * @typedef {import('../config/apiKeys').ApiKeyEntry} ApiKeyEntry
 */

/**
 * Request DTO for creating an API key.
 *
 * @typedef {Object} CreateApiKeyRequestDto
 * @property {string}   key      - The raw API key string.
 * @property {string}   clientId - Unique identifier for the service client.
 * @property {string[]} scopes   - Permissions granted to this key.
 */

/**
 * Response DTO representing a single API key.
 *
 * @typedef {Object} ApiKeyResponseDto
 * @property {string}   key      - The raw API key string.
 * @property {string}   clientId - Unique identifier for the service client.
 * @property {string[]} scopes   - Permissions granted to this key.
 * @property {boolean}  revoked  - Whether the key is revoked.
 */

/**
 * Response DTO for a successful key creation.
 *
 * @typedef {Object} CreateApiKeyResponseDto
 * @property {string}            message - Human-readable result message.
 * @property {ApiKeyResponseDto} data    - The created key entry.
 */

/**
 * Response DTO for a duplicate key creation.
 *
 * @typedef {Object} DuplicateApiKeyResponseDto
 * @property {boolean}           idempotent - Indicates the request was idempotent.
 * @property {string}            message    - Human-readable result message.
 * @property {ApiKeyResponseDto} data       - The existing key entry.
 */

/**
 * Response DTO for listing API keys.
 *
 * @typedef {Object} ListApiKeysResponseDto
 * @property {ApiKeyResponseDto[]} data  - Array of key entries.
 * @property {number}              count - Total number of entries.
 */

/**
 * Response DTO for a single key retrieval.
 *
 * @typedef {Object} GetApiKeyResponseDto
 * @property {ApiKeyResponseDto} data - The requested key entry.
 */

/**
 * Response DTO for an error response.
 *
 * @typedef {Object} ErrorResponseDto
 * @property {string}   message - Human-readable error message.
 * @property {string}   code    - Machine-readable error code.
 * @property {Object[]} [details] - Array of validation detail objects.
 */

/**
 * Maps an {@link ApiKeyEntry} domain object to an {@link ApiKeyResponseDto}.
 *
 * Only the fields that are part of the public API contract are copied.
 * Extra or internal fields on the input are silently dropped.
 *
 * @param {ApiKeyEntry} entry - The domain entry to convert.
 * @returns {ApiKeyResponseDto} The DTO safe for serialisation.
 */
function toApiKeyResponseDto(entry) {
  return {
    key: entry.key,
    clientId: entry.clientId,
    scopes: [...entry.scopes],
    revoked: entry.revoked === undefined ? false : Boolean(entry.revoked),
  };
}

/**
 * Maps a {@link CreateApiKeyRequestDto} to a partial domain entry object.
 *
 * Only the fields that the caller is allowed to supply are carried over;
 * extra properties on the input are silently discarded.
 *
 * @param {CreateApiKeyRequestDto} dto - The incoming request DTO.
 * @returns {ApiKeyEntry} A partial domain entry suitable for storage.
 */
function fromCreateApiKeyRequestDto(dto) {
  return {
    key: dto.key.trim(),
    clientId: dto.clientId.trim(),
    scopes: [...dto.scopes],
    revoked: false,
  };
}

/**
 * Builds a {@link CreateApiKeyResponseDto} from a domain entry.
 *
 * @param {ApiKeyEntry} entry   - The domain entry that was created.
 * @param {string}      message - Human-readable message (e.g. "API key created successfully.").
 * @returns {CreateApiKeyResponseDto} The response DTO.
 */
function toCreateApiKeyResponseDto(entry, message) {
  return {
    message,
    data: toApiKeyResponseDto(entry),
  };
}

/**
 * Builds a {@link DuplicateApiKeyResponseDto} from a domain entry.
 *
 * @param {ApiKeyEntry} entry   - The existing domain entry.
 * @param {string}      message - Human-readable message (e.g. "API key already exists.").
 * @returns {DuplicateApiKeyResponseDto} The response DTO.
 */
function toDuplicateApiKeyResponseDto(entry, message) {
  return {
    idempotent: true,
    message,
    data: toApiKeyResponseDto(entry),
  };
}

/**
 * Builds a {@link ListApiKeysResponseDto} from an array of domain entries.
 *
 * @param {ApiKeyEntry[]} entries - Array of domain entries.
 * @returns {ListApiKeysResponseDto} The list response DTO.
 */
function toListApiKeysResponseDto(entries) {
  return {
    data: entries.map(toApiKeyResponseDto),
    count: entries.length,
  };
}

/**
 * Builds a {@link GetApiKeyResponseDto} from a domain entry.
 *
 * @param {ApiKeyEntry} entry - The domain entry to return.
 * @returns {GetApiKeyResponseDto} The single-key response DTO.
 */
function toGetApiKeyResponseDto(entry) {
  return {
    data: toApiKeyResponseDto(entry),
  };
}

/**
 * Validates a {@link CreateApiKeyRequestDto} and returns an array of error
 * detail objects, or an empty array when the input is valid.
 *
 * @param {unknown} body - The raw request body to validate.
 * @returns {{ field: string, message: string }[]} List of validation errors.
 */
function validateCreateApiKeyRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors.push({ field: 'body', message: 'Request body must be a JSON object' });
    return errors;
  }

  const { key, clientId, scopes } = body;

  if (typeof key !== 'string' || key.trim() === '') {
    errors.push({ field: 'body', message: '"key" must be a non-empty string' });
  } else if (!key.startsWith(API_KEY_PREFIX)) {
    errors.push({ field: 'body', message: `"key" must start with "${API_KEY_PREFIX}"` });
  } else if (key.length < MIN_KEY_LENGTH) {
    errors.push({ field: 'body', message: `"key" must be at least ${MIN_KEY_LENGTH} characters long` });
  }

  if (typeof clientId !== 'string' || clientId.trim() === '') {
    errors.push({ field: 'body', message: '"clientId" must be a non-empty string' });
  }

  if (!Array.isArray(scopes) || scopes.length === 0) {
    errors.push({ field: 'body', message: '"scopes" must be a non-empty array' });
  } else {
    for (const scope of scopes) {
      if (!VALID_SCOPES.includes(scope)) {
        errors.push({ field: 'body', message: `"${scope}" is not a valid scope. Valid: ${VALID_SCOPES.join(', ')}` });
      }
    }
  }

  return errors;
}

module.exports = {
  toApiKeyResponseDto,
  fromCreateApiKeyRequestDto,
  toCreateApiKeyResponseDto,
  toDuplicateApiKeyResponseDto,
  toListApiKeysResponseDto,
  toGetApiKeyResponseDto,
  validateCreateApiKeyRequest,
};
