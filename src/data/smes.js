'use strict';

const crypto = require('crypto');

const records = new Map();
const registrationIndex = new Map();
const stellarAddressIndex = new Map();

/**
 * Builds the normalized lookup key for country and registration number.
 *
 * @param {string} country ISO country code.
 * @param {string} registrationNumber SME registration number.
 * @returns {string} Normalized composite key.
 */
function registrationKey(country, registrationNumber) {
  return `${country}|${registrationNumber.toLowerCase()}`;
}

/**
 * Returns a detached copy of an SME record.
 *
 * @param {object} record Stored SME record.
 * @returns {object} Copy safe to return to callers.
 */
function copySme(record) {
  return {
    ...record,
    reviewHistory: record.reviewHistory.map((entry) => ({ ...entry })),
  };
}

/**
 * Creates an SME record and atomically enforces its natural-key uniqueness.
 *
 * @param {object} input Validated SME fields.
 * @returns {object} Created SME record.
 * @throws {Error} When a country/registration number or Stellar address exists.
 */
function createSme(input) {
  const regKey = registrationKey(input.country, input.registrationNumber);
  if (registrationIndex.has(regKey) || stellarAddressIndex.has(input.stellarAddress)) {
    const error = new Error('An SME with these registration details or Stellar address already exists.');
    error.code = 'SME_DUPLICATE';
    throw error;
  }

  const record = {
    id: `SME_${crypto.randomUUID()}`,
    legalName: input.legalName,
    registrationNumber: input.registrationNumber,
    country: input.country,
    stellarAddress: input.stellarAddress,
    contactEmail: input.contactEmail,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewHistory: [],
  };
  records.set(record.id, record);
  registrationIndex.set(regKey, record.id);
  stellarAddressIndex.set(record.stellarAddress, record.id);
  return copySme(record);
}

/**
 * Looks up an SME by its identifier.
 *
 * @param {string} id SME identifier.
 * @returns {object|null} Detached SME record, or null when absent.
 */
function getSme(id) {
  const record = records.get(id);
  return record ? copySme(record) : null;
}

/**
 * Records an allowed review decision on an SME.
 *
 * @param {string} id SME identifier.
 * @param {string} status New SME status.
 * @param {{decision: string, note: string, reviewedAt: string}} reviewEntry Review event.
 * @returns {object|null} Updated SME record, or null when absent.
 */
function updateSmeReview(id, status, reviewEntry) {
  const record = records.get(id);
  if (!record) {
    return null;
  }
  record.status = status;
  record.reviewHistory.push({ ...reviewEntry });
  return copySme(record);
}

/**
 * Lists stored SMEs with optional status filtering and cursor-based pagination.
 *
 * @param {object} [params]
 * @param {string} [params.status] Status filter.
 * @param {number} [params.limit=50] Maximum records to return (1-100).
 * @param {string} [params.after] Cursor SME id to start after.
 * @param {string} [params.cursor] Alias for after.
 * @returns {{ data: object[], nextCursor: string|null }} Detached copies of SME records.
 */
function listSmes({ status, limit = 50, after, cursor } = {}) {
  let all = Array.from(records.values());
  if (status) {
    all = all.filter((sme) => sme.status === status);
  }
  const cursorId = after || cursor;
  let startIndex = 0;
  if (cursorId) {
    const idx = all.findIndex((sme) => sme.id === cursorId);
    if (idx === -1) {
      const error = new Error('Invalid cursor');
      error.code = 'INVALID_CURSOR';
      throw error;
    }
    startIndex = idx + 1;
  }
  const maxLimit = Math.min(Math.max(1, Number(limit) || 50), 100);
  const page = all.slice(startIndex, startIndex + maxLimit);
  const nextCursor = startIndex + maxLimit < all.length && page.length > 0 ? page[page.length - 1].id : null;
  return {
    data: page.map(copySme),
    nextCursor,
  };
}

/**
 * Clears all in-memory SME records.
 *
 * @returns {void}
 */
function resetSmes() {
  records.clear();
  registrationIndex.clear();
  stellarAddressIndex.clear();
}

module.exports = { createSme, getSme, listSmes, updateSmeReview, resetSmes };
