'use strict';

/**
 * @fileoverview Escrow-read orchestration service.
 *
 * Encapsulates the full escrow-read flow — input validation, address
 * resolution, state reading, derived field computation, and DTO mapping —
 * so route handlers become thin adapters that only deal with request/response
 * transport and metrics recording.
 *
 * ## Why a separate service?
 * Prior to this module, escrow-read business logic was duplicated across
 * three locations: the legacy handler in `app.js`, the V1 handler in
 * `routes/v1/index.js`, and the batch handler in the same file.  This
 * hurt testability (unit tests had to spin up Express) and made it easy
 * for the three paths to drift behaviour.
 *
 * This service consolidates the orchestration and exposes two pure-ish
 * async functions that any HTTP handler can call:
 *
 *   - {@link getEscrowRead}  — single-invoice escrow read
 *   - {@link getEscrowReadBatch} — batched escrow read
 *
 * Both functions return plain objects with a predictable shape so callers
 * never need to catch service errors to build the HTTP response; the
 * service communicates failure via structured return values (the `error`
 * and `statusCode` fields on the result envelope).
 *
 * @module services/escrowReadService
 */

const { resolveEscrowAddress } = require('../config/escrowMap');
const { readEscrowState } = require('./escrowRead');
const { batchReadEscrowStates } = require('./escrowBatchRead');
const { computeEscrowDerivedFields } = require('./escrowDerived');
const {
  validateEscrowReadParams,
  mapToEscrowReadResponseDto,
  mapToEscrowReadWithAttestationsResponseDto,
} = require('../schemas/escrowRead');
const logger = require('../logger');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Resolves a single invoice ID to an escrow contract address.
 *
 * Returns `null` when the invoice has no mapping; throws for unexpected
 * errors (e.g. misconfigured env).
 *
 * @param {string} invoiceId
 * @returns {string|null}
 */
function _resolveAddress(invoiceId) {
  try {
    return resolveEscrowAddress(invoiceId) || null;
  } catch (err) {
    logger.warn(
      { invoiceId, err: err.message },
      'escrowReadService: address resolution threw unexpectedly',
    );
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Result envelope for a single escrow read.
 *
 * @typedef {object} EscrowReadResult
 * @property {object|null}  result     - The response DTO on success, or null.
 * @property {string|null}  escrowAddress - Resolved contract address on success.
 * @property {string|null}  error      - Error detail string, null on success.
 * @property {string|null}  code       - Machine-readable error code, null on success.
 * @property {number}       statusCode - HTTP status code to use (200, 400, 404, 500).
 * @property {string|null}  invoiceId  - The requested invoice ID (for metrics).
 */

/**
 * Orchestrates a single escrow read from end to end.
 *
 * Flow:
 *  1. Validate `invoiceId` format → 400 on failure.
 *  2. Resolve escrow contract address → 404 on unmapped invoice.
 *  3. Read escrow state via {@link module:services/escrowRead.readEscrowState}.
 *  4. Compute derived display fields.
 *  5. Map to response DTO.
 *  6. Return success envelope with status 200.
 *
 * On any step failure the function returns a structured error envelope
 * rather than throwing, so callers can build HTTP responses without a
 * try/catch around the business logic.
 *
 * @param {string} rawInvoiceId - Invoice identifier from the URL param.
 * @param {object} [options={}]
 * @param {object} [options.readOptions] - Options forwarded to `readEscrowState`.
 * @returns {Promise<EscrowReadResult>}
 *
 * @example
 * const { result, error, statusCode, escrowAddress } = await getEscrowRead('INV-001');
 * if (error) {
 *   return res.status(statusCode).json({ error, code });
 * }
 * res.set('X-Escrow-Address', escrowAddress);
 * res.json(result);
 */
async function getEscrowRead(rawInvoiceId, options = {}) {
  const { readOptions = {} } = options;

  // 1. Validate input
  const invoiceId = String(rawInvoiceId || '').trim().replace(/\s+/g, '');
  const validation = validateEscrowReadParams({ invoiceId });
  if (!validation.success) {
    return {
      result: null,
      escrowAddress: null,
      error: `Invalid invoiceId: ${JSON.stringify(validation.fieldErrors)}`,
      code: 'BAD_REQUEST',
      statusCode: 400,
      invoiceId,
    };
  }

  const safeId = validation.data.invoiceId;

  // 2. Resolve escrow address
  const escrowAddress = _resolveAddress(safeId);
  if (!escrowAddress) {
    return {
      result: null,
      escrowAddress: null,
      error: `No escrow contract mapping found for invoice ID '${safeId}'`,
      code: 'NOT_FOUND',
      statusCode: 404,
      invoiceId: safeId,
    };
  }

  try {
    // 3. Read escrow state
    const state = await readEscrowState(safeId, readOptions);

    // 4. Compute derived fields
    const derived = computeEscrowDerivedFields(state, {
      ledgerCloseTime: state ? state.ledgerCloseTime : undefined,
    });

    // 5. Map to response DTO
    const result = mapToEscrowReadResponseDto({
      state,
      derived,
      escrowAddress,
      fromProjection: state ? state.fromProjection : undefined,
    });

    return {
      result,
      escrowAddress,
      error: null,
      code: null,
      statusCode: 200,
      invoiceId: safeId,
    };
  } catch (err) {
    logger.error(
      { invoiceId: safeId, err: err.message, code: err.code },
      'escrowReadService: escrow state read failed',
    );
    return {
      result: null,
      escrowAddress,
      error: err.message || 'Failed to read escrow state',
      code: err.code || 'INTERNAL_ERROR',
      statusCode: typeof err.status === 'number' && err.status >= 400 ? err.status : 500,
      invoiceId: safeId,
    };
  }
}

/**
 * Result envelope for a single item in a batch escrow read.
 *
 * @typedef {object} BatchItemResult
 * @property {object|null}  result  - The response DTO on success.
 * @property {string|null}  error   - Error detail on failure.
 * @property {string|null}  code    - Machine-readable error code on failure.
 */

/**
 * Result envelope for a batch escrow read.
 *
 * @typedef {object} EscrowReadBatchResult
 * @property {BatchItemResult[]} results - Successful reads.
 * @property {BatchItemResult[]} errors  - Failed reads.
 * @property {number} statusCode - Overall HTTP status (200 always — partial
 *   failures are reported per-item).
 */

/**
 * Orchestrates a batch escrow read from end to end.
 *
 * Flow:
 *  1. Validate and sanitise each invoice ID.
 *  2. Resolve escrow addresses up front — unmapped IDs are reported as
 *     per-item errors rather than failing the whole batch.
 *  3. Batch-read the mapped IDs via
 *     {@link module:services/escrowBatchRead.batchReadEscrowStates}.
 *  4. Compute derived fields and map to DTOs for each successful read.
 *  5. Return the merged results/errors envelope.
 *
 * @param {string[]} rawInvoiceIds - Array of invoice identifiers.
 * @param {object} [options={}]
 * @param {object} [options.readOptions] - Options forwarded to `batchReadEscrowStates`.
 * @returns {Promise<EscrowReadBatchResult>}
 */
async function getEscrowReadBatch(rawInvoiceIds, options = {}) {
  const { readOptions = {} } = options;

  const invoiceIds = (Array.isArray(rawInvoiceIds) ? rawInvoiceIds : [])
    .map((id) => String(id || '').trim().replace(/\s+/g, ''))
    .filter(Boolean);

  if (invoiceIds.length === 0) {
    return {
      results: [],
      errors: [],
      statusCode: 200,
    };
  }

  // Resolve addresses up front — unmapped IDs are per-item errors.
  const addressByInvoiceId = new Map();
  const errors = [];

  for (const invoiceId of invoiceIds) {
    const escrowAddress = _resolveAddress(invoiceId);
    if (!escrowAddress) {
      errors.push({
        invoiceId,
        error: `No escrow contract mapping found for invoice ID '${invoiceId}'`,
        code: 'NOT_FOUND',
      });
      continue;
    }
    addressByInvoiceId.set(invoiceId, escrowAddress);
  }

  // Batch-read the mapped IDs.
  const mappedIds = [...addressByInvoiceId.keys()];
  const { results: readResults, errors: readErrors } = mappedIds.length
    ? await batchReadEscrowStates(mappedIds, { readOptions })
    : { results: [], errors: [] };

  // Map successful results to DTOs.
  const results = readResults.map((state) => {
    const escrowAddress = addressByInvoiceId.get(state.invoiceId);
    const derived = computeEscrowDerivedFields(state, {
      ledgerCloseTime: state.ledgerCloseTime,
    });
    const result = mapToEscrowReadResponseDto({
      state,
      derived,
      escrowAddress,
      fromProjection: state.fromProjection,
    });
    return { result, invoiceId: state.invoiceId };
  });

  // Merge address-resolution errors with batch-read errors.
  for (const readErr of readErrors) {
    errors.push({
      invoiceId: readErr.invoiceId,
      error: readErr.error,
      code: readErr.code,
    });
  }

  return {
    results,
    errors,
    statusCode: 200,
  };
}

module.exports = {
  getEscrowRead,
  getEscrowReadBatch,
};
