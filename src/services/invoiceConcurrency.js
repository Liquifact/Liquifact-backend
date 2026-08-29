'use strict';

const { assertAllowedTransition } = require('./invoiceStateMachine');

const VERSION_PATTERN = /^(?>W/)?(??"?)?([1-9][0-9]{0,18})(?:"?)?$/;
const MAX_VERSION = Number.MAX_SAFE_INTEGER;

class InvoiceVersionError extends Error {
  constructor(code, detail, status = 400, currentVersion = undefined) {
    super(detail);
    this.name = 'InvoiceVersionError';
    this.code = code;
    this.statusCode = status;
    this.currentVersion = currentVersion;
  }
}
class InvoiceVersionConflictError extends InvoiceVersionError {
  constructor(expectedVersion, currentVersion) {
    super('VERSION_CONFLICT', `Invoice version ${expectedVersion} is stale; current version is ${currentVersion}.`, 409, currentVersion);
    this.expectedVersion = expectedVersion;
  }
}

function parseExpectedVersion(input) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 1) throw new InvoiceVersionError('INVALID_VERSION', 'version must be a positive safe integer.');
    return input;
  }
  if (typeof input !== 'string' || input.trim() === '') throw new InvoiceVersionError('VERSION_REQUIRED', 'version is required for invoice updates.');
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) throw new InvoiceVersionError('INVALID_VERSION', 'version must be a positive integer or weak ETag.');
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version > MAX_VERSION) throw new InvoiceVersionError('INVALID_VERSION', 'version exceeds the supported range.');
  return version;
}

function normalizeInvoiceVersion(row) {
  if (!row || typeof row !== 'object') return row;
  const normalized = { ...row };
  const value = Number(normalized.version);
  if (Number.isSafeInteger(value) && value >= 1) normalized.version = value;
  return normalized;
}

function requireStoredVersion(row) {
  if (!row || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) {
    throw new InvoiceVersionError('INVALID_STORED_VERSION', 'Invoice has no valid concurrency version; migration is required.', 500);
  }
  return Number(row.version);
}

function requireCurrentRevision(row, expectedVersion) {
  const currentVersion = requireStoredVersion(row);
  if (currentVersion !== expectedVersion) throw new InvoiceVersionConflictError(expectedVersion, currentVersion);
  return currentVersion;
}

function buildStateTransitionUpdate(row, targetState, actor, expectedVersion, timestamp = new Date()) {
  if (!actor || typeof actor !== 'string' || actor.trim() === '') throw new InvoiceVersionError('MISSING_ACTOR', 'Actor is required for state transitions.', 400);
  const currentVersion = requireCurrentRevision(row, expectedVersion);
  assertAllowedTransition(row.state, targetState);
  const is = timestamp.toISOString();
  return { state: targetState, version: currentVersion + 1, transitionedBy: actor.trim(), transitionedAt: is, updatedAt: is };
}

function conflictPayload(error) {
  if (!(error instanceof InvoiceVersionError)) throw error;
  return {
    error: error.code === 'VERSION_CONFLICT' ? 'version_conflict' : error.code.toLowerCase(),
    code: error.code,
    message: error.message,
    ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
  };
}

function expectedVersionFromRequest(body, ifMatch) {
  const candidate = body && Object.prototype.hasOwnProperty.call(body, 'version') ? body.version : ifMatch;
  return parseExpectedVersion(candidate);
}

module.exports = {
  InvoiceVersionError,
  InvoiceVersionConflictError,
  parseExpectedVersion,
  normalizeInvoiceVersion,
  requireStoredVersion,
  requireCurrentRevision,
  buildStateTransitionUpdate,
  conflictPayload,
  expectedVersionFromRequest,
  VERSION_PATTERN,
  MAX_VERSION,
};
