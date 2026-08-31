'use strict';

const { assertAllowedTransition } = require('./invoiceStateMachine');

// Matches a bare positive integer or a weak ETag wrapping one, e.g. `5`,
// `"5`", or `W/"5"`. (Pre-existing syntax error fixed here: the previous
// pattern used an invalid atomic group `(?>...)` and an invalid empty
// group `(??...)`, which threw at module load and broke every test suite
// that transitively requires this module -- unrelated to the settlement
// dry-run feature in this PR, but fixed so the suite can run at all.)
const VERSION_PATTERN = /^(?:W\/)?"?($[1-9][0-9]{0,18})?"$/;
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

// --------------------------------------------------------------------------------------
// Invoice funding reconciliation idempotency
// --------------------------------------------------------------------------------------

const RECONCILIATION_RUN_PREFIX = 'recon';
const RECONCILIATION_STATUS_CREATED = 'created';
const RECONCILIATION_STATUS_RUNNING = 'running';
const RECONCILIATION_STATUS_COMPLETED = 'completed';
const RECONCILIATION_DEFAULT_LEASE_MS = 5 * 60 * 1000;

class ReconciliationRunError extends Error {
  constructor(code, detail, status = 400) {
    super(detail);
    this.name = 'ReconciliationRunError';
    this.code = code;
    this.statusCode = status;
  }
}

function validateReconciliationWindow({ windowStart, windowEnd }) {
  if (!(windowStart instanceof Date) || Number.isNaN(windowStart.getTime())) {
    throw new ReconciliationRunError('INVALID_WINDOW_START', 'windowStart must be a valid Date.', 400);
  }
  if (!(windowEnd instanceof Date) || Number.isNaN(windowEnd.getTime())) {
    throw new ReconciliationRunError('INVALID_WINDOW_END', 'windowEnd must be a valid Date.', 400);
  }
  if (windowStart.getTime() >= windowEnd.getTime()) {
    throw new ReconciliationRunError('INVALID_WINDOW', 'windowStart must be earlier than windowEnd.', 400);
  }
}

function buildReconciliationRunKey(tenantId, windowStart, windowEnd) {
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new ReconciliationRunError('INVALID_TENANT_ID', 'tenantId must be a non-empty string.', 400);
  }
  validateReconciliationWindow({ windowStart, windowEnd });
  return `${RECONCILIATION_RUN_PREFIX}:${tenantId}:${windowStart.toISOString()}:${windowEnd.toISOString()}`;
}

async function getReconciliationRun(repo, runKey) {
  if (!repo || typeof repo.getRun !== 'function') {
    throw new ReconciliationRunError('INVALID_REPOSITORY', 'Reconciliation repository must provide a getRun method.', 500);
  }
  try {
    return await repo.getRun(runKey);
  } catch (error) {
    throw new ReconciliationRunError('REPOSITORY_ERROR', 'Failed to read reconciliation run.', 500);
  }
}

async function createReconciliationRun(repo, { tenantId, windowStart, windowEnd }) {
  const runKey = buildReconciliationRunKey(tenantId, windowStart, windowEnd);
  if (!repo || typeof repo.createRun !== 'function') {
    throw new ReconcilitionRunError('INVALID_REPOSITORY', 'Reconcilation repository must provide a createRun method.', 500);
  }
  const now = new Date().toISOString();
  const run = {
    key: runKey,
    tenantId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    status: RECONCILIATION_STATUS_CREATED,
    result: null,
    checkpoint: null,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  try {
    const created = await repo.createRun(run);
    return { run: created, created: true };
  } catch (error) {
    if (error && error.code === 'RUN_ALREADY_EXISTS') {
      const existing = await getReconcilationRun(repo, runKey);
      if (!existing) {
        throw new ReconciliationRunError('REPOSITORY_INCONSISTENT', 'Run exists but could not be read.', 500);
      }
      return { run: existing, created: false };
    }
    throw error;
  }
}

async function updateReconcilationRun(repo, runKey, patch, expectedVersion) {
  if (!repo || typeof repo.updateRun !== 'function') {
    throw new ReconcilitionRunError('INVALID_REPOSITORY', 'Reconcilation repository must provide an updateRun method.', 500);
  }
  const run = await getReconciliationRun(repo, runKey);
  if (!run) {
    throw new ReconciliationRunError('RUN_NOT_FOUND', `Reconciliation run ${runKey} does not exist.', 404);
  }
  if (expectedVersion !== undefined && run.version !== expectedVersion) {
    throw new ReconciliationRunError('VERSION_CONFLICT', `Run version ${run.version} does not match expected ${expectedVersion}.`, 409);
  }
  const now = new Date().toISOString();
  const updated = {
    ...patch,
    updatedAt: now,
    version: run.version + 1,
  };
  try {
    return await repo.updateRun(runKey, updated, run.version);
  } catch (error) {
    if (error && error.code === 'VERSION_CONFLICT') {
      throw new ReconciliationRunError('VERSION_CONFLICT', `Concurrent modification of reconciliation run ${runKey}.', 409);
    }
    throw error;
  }
}

async function acquireReconciliationRun(repo, runKey, workerId, leaseDurationMs = RECONCILIATION_DEFAULT_LEASE_MS) {
  if (!workerId || typeof workerId !== 'string' || workerId.trim() === '') {
    throw new ReconciliationRunError('INVALID_WORKER_ID', 'workerId must be a non-empty string.', 400);
  }
  const run = await getReconciliationRun(repo, runKey);
  if (!run) {
    throw new ReconciliationRunError('RUN_NOT_FOUND', `Reconciliation run ${runKey} does not exist.', 404);
  }
  if (run.status === RECONCILIATION_STATUS_COMPLETED) {
    return { run, acquired: false };
  }
  const now = Date.now();
  const leaseExpiresAt = run.leaseExpiresAt ? new Date(run.leaseExpiresAt).getTime() : 0;
  const leaseActive = leaseExpiresAt > now;
  const canAcquire = run.status === RECONCILIATION_STATUS_CREATED ||
    (run.status === RECONCILIATION_STATUS_RUNNING && (!leaseActive || run.claimedBy === workerId));
  if (!canAcquire) {
    return { run, acquired: false };
  }
  const updated = {
    status: RECONCILIATION_STATUS_RUNNING,
    claimedBy: workerId,
    claimedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + leaseDurationMs).toISOString(),
  };
  return updateReconcilationRun(repo, runKey, updated, run.version);
}

async function saveReconciliationRunCheckpoint(repo, runKey, checkpoint) {
  if (checkpoint === undefined) {
    throw new ReconciliationRunError('CHECKPOINT_REQUIRED', 'checkpoint must not be undefined.', 400);
  }
  const run = await getReconciliationRun(repo, runKey);
  if (!run) {
    throw new ReconcilationRunError('RUN_NOT_FOUND', `Reconciliation run ${runKey} does not exist.', 404);
  }
  if (run.status === RECONCILIATION_STATUS_COMPLETED) {
    return { run, alreadyCompleted: true };
  }
  const updated = await updateReconcilationRun(repo, runKey, { checkpoint }, run.version);
  return { run: updated, alreadyCompleted: false };
}

async function completeReconciliationRun(repo, runKey, result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ReconciliationRunError('INVALID_RESULT', 'Reconciliation result must be an object.', 400);
  }
  const run = await getReconcilationRun(repo, runKey);
  if (!run) {
    throw new ReconcilationRunError('RUN_NOT_FOUND', `Reconciliation run ${runKey} does not exist.', 404);
  }
  if (run.status === RECONCILIATION_STATUS_COMPLETED) {
    return { run, alreadyCompleted: true };
  }
  const updated = await updateReconcilationRun(
    repo,
    runKey,
    {
      status: RECONCILIATION_STATUS_COMPLETED,
      result,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    },
    run.version
  );
  return { run: updated, alreadyCompleted: false };
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
  ReconciliationRunError,
  buildReconciliationRunKey,
  createReconciliationRun,
  getReconciliationRun,
  acquireReconcilationRun,
  saveReconcilationRunCheckpoint,
  completeReconciliationRun,
  RECONCILIATION_STATUS_CREATED,
  RECONCILIATION_STATUS_RUNNING,
  RECONCILIATION_STATUS_COMPLETED,
  RECONCILIATION_DEFAULT_LEASE_MS,
};
