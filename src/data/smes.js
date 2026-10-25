'use strict';

const crypto = require('crypto');

const records = new Map();

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
  const duplicate = [...records.values()].some((record) =>
    (record.country === input.country &&
      record.registrationNumber.toLowerCase() === input.registrationNumber.toLowerCase()) ||
    record.stellarAddress === input.stellarAddress
  );
  if (duplicate) {
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
 * Clears all in-memory SME records.
 *
 * @returns {void}
 */
function resetSmes() {
  records.clear();
}

module.exports = { createSme, getSme, updateSmeReview, resetSmes };
