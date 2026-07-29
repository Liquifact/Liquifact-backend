/**
 * @fileoverview Escrow read service — fetches on-chain escrow state including
 * the `get_legal_hold` flag from the LiquifactEscrow Soroban contract.
 *
 * The service is intentionally side-effect-free: it reads state and returns a
 * plain object. All mutation (funding, settlement) lives in separate modules.
 *
 * Read ordering (when no test adapter is injected):
 *
 *   1. Cache      — optional Redis escrow summary cache (`REDIS_ESCROW_CACHE_*`).
 *                   Orchestrated by {@link getEscrowStateWithProjection}; the
 *                   lower-level readers prefer the projection first.
 *   2. Projection — durable per-invoice `escrow_event_projection` row written
 *                   by the indexer (`src/jobs/escrowIndexer.js`). Decimals on
 *                   the projection are display-only — never used to scale
 *                   on-chain principal math.
 *   3. RPC stub   — production placeholder for the Soroban `get_escrow_state`
 *                   call. Returns a neutral `{ status: 'not_found',
 *                   fundedAmount: 0 }` shape so callers do not see fabricated
 *                   state for invoice IDs the indexer has not yet recorded.
 *
 * Test injection: tests should supply `escrowAdapter` to short-circuit the
 * projection + RPC fallback chain. Adapter injection takes precedence over
 * the cache and projection paths so unit tests stay deterministic.
 *
 * Ledger time: when the Soroban response includes a `ledgerCloseTime` field
 * (Unix epoch seconds), it is forwarded as `ledgerCloseTime` on the returned
 * state so callers can pass it to {@link module:services/escrowDerived} as
 * `opts.ledgerCloseTime`.  This ensures `daysToMaturity` is computed from
 * ledger time rather than the server wall clock.
 *
 * @module services/escrowRead
 */

"use strict";

const { callSorobanContract } = require("./soroban");
const logger = require("../logger");
const { getTokenMetadata } = require("./tokenMeta");
const db = require("../db/knex");
const { createRedisEscrowSummaryCache } = require("../cache/redis");
const { escrowReadCache } = require("./escrowReadCache");
const { emitEscrowReadWebhook } = require("./webhooks");
const { get: getConfig } = require("../config");
const { escrowReadParamsSchema } = require("../schemas/escrowRead");

const cache = createRedisEscrowSummaryCache();

/**
 * Tri-state legal-hold outcome. Issue #424 — a legal hold is a compliance
 * gate, so an unreadable read MUST NOT collapse to `not_held`.
 *
 * @typedef {'held' | 'not_held' | 'unknown'} LegalHoldStatus
 */

/**
 * Envelope returned by {@link fetchLegalHoldStatus} and surfaced on the
 * escrow state object. The `reason` and `errorCode` fields are populated
 * only for the `unknown` outcome so callers can alert on the specific
 * failure mode without re-reading service logs.
 *
 * @typedef {object} LegalHoldEnvelope
 * @property {LegalHoldStatus} status - The tri-state result.
 * @property {string} [reason] - Why the status is `unknown`
 *   (`rpc_error` | `adapter_error` | `service_unavailable`).
 * @property {string} [errorCode] - Low-cardinality error code if the call
 *   failed with one (e.g. `ETIMEDOUT`, `ECONNREFUSED`).
 */

/**
 * Canonical constants for the tri-state. Exported so callers (route
 * handlers, dashboards) can branch on the same string and avoid typos.
 *
 * @constant {Readonly<{HELD: 'held', NOT_HELD: 'not_held', UNKNOWN: 'unknown'}>}
 */
const LEGAL_HOLD_STATUS = Object.freeze({
  HELD: "held",
  NOT_HELD: "not_held",
  UNKNOWN: "unknown",
});

/**
 * Default reasons for the `unknown` case. Surfaced so operators can
 * distinguish a real RPC failure from an unsupported adapter shape.
 *
 * @constant {Readonly<{RPC_ERROR: 'rpc_error', ADAPTER_ERROR: 'adapter_error'}>}
 */
const LEGAL_HOLD_UNKNOWN_REASONS = Object.freeze({
  RPC_ERROR: "rpc_error",
  ADAPTER_ERROR: "adapter_error",
});

/**
 * Canonical boolean → tri-state coercion. Issue #424 — exported as the
 * single source of truth for the rule (the gate reuses it on the legacy
 * boolean-adapter path so we never drift).
 *
 * Treats truthy / numeric 1 / string 'true' as `held`; anything else
 * (including `null` / `undefined` / `''`) as `not_held`. Adapters that
 * throw or hang are NOT handled here; the caller is expected to route
 * throws through the `unknown` branch.
 *
 * @param {unknown} raw - Adapter return value.
 * @returns {LegalHoldStatus} Normalised status.
 */
function coerceLegalHoldStatus(raw) {
  return raw === true || raw === 1 || raw === "true"
    ? LEGAL_HOLD_STATUS.HELD
    : LEGAL_HOLD_STATUS.NOT_HELD;
}

// Alias for internal use within this module.
const _coerceLegalHoldStatus = coerceLegalHoldStatus;



/**
 * Neutral base-state shape returned when neither the projection nor a test
 * adapter has data for an invoice. Never fabricate funded amounts: a missing
 * projection must look like "not on-chain yet", not like a funded stub.
 *
 * @constant {object}
 */
const NEUTRAL_BASE_STATE = Object.freeze({
  status: "not_found",
  fundedAmount: 0,
  source: "rpc_stub",
});

/**
 * Validates an invoice ID string using the canonical escrow-read Zod schema.
 *
 * Delegates to {@link module:schemas/escrowRead.escrowReadParamsSchema} so
 * all escrow-read paths share one validation rule. The Zod schema already
 * enforces:
 *  - Non-empty string
 *  - Starts with alphanumeric
 *  - Contains only alphanumeric, underscore, hyphen, dot, colon
 *  - Max 128 characters
 *
 * @param {unknown} invoiceId - Value to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateInvoiceId(invoiceId) {
  const result = escrowReadParamsSchema.safeParse({ invoiceId });
  if (result.success) {
    return { valid: true };
  }

  const firstIssue = result.error.issues && result.error.issues[0];
  const reason =
    firstIssue && firstIssue.message
      ? firstIssue.message
      : "invoiceId is invalid";
  return { valid: false, reason };
}

/**
 * Calls the on-chain `get_legal_hold` getter and returns the resolved
 * tri-state. Issue #424 ensures a failed read is reported as `unknown`
 * rather than collapsing to `not_held` (which would silently unblock any
 * caller that naively defaults to `false`).
 *
 * Outcome contract:
 *   - {@link LEGAL_HOLD_STATUS.HELD}     — on-chain flag is truthy.
 *   - {@link LEGAL_HOLD_STATUS.NOT_HELD} — on-chain flag is falsy.
 *   - {@link LEGAL_HOLD_STATUS.UNKNOWN}  — RPC error, timeout, circuit-open,
 *     or any other unrecoverable condition. Always paired with a `reason`
 *     and the original `errorCode` so operators can triage.
 *
 * Production placeholder: with no `adapter`, the stub returns `NOT_HELD`.
 * Real deployments should wire `adapter` through to `sorobanClient.invokeContract`.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function `(invoiceId) => unknown`
 *   whose return value is coerced via {@link _coerceLegalHoldStatus}.
 * @returns {Promise<LegalHoldEnvelope>} Resolved tri-state envelope.
 *   NEVER throws.
 */
async function fetchLegalHoldStatus(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        return false;
      };

  try {
    const result = await callSorobanContract(operation);
    return { status: _coerceLegalHoldStatus(result) };
  } catch (err) {
    logger.warn(
      {
        invoiceId,
        errCode: err?.code,
        reason: LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR,
      },
      "escrowRead: get_legal_hold call failed — status is unknown, gate must fail closed",
    );
    return {
      status: LEGAL_HOLD_STATUS.UNKNOWN,
      reason: LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR,
      errorCode: typeof err?.code === "string" ? err.code : undefined,
    };
  }
}

/**
 * Calls the on-chain `get_legal_hold` getter for the given escrow contract.
 *
 * @deprecated Prefer {@link fetchLegalHoldStatus} for security-sensitive callers.
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function `(invoiceId) => boolean`.
 * @returns {Promise<boolean>}
 */
async function fetchLegalHold(invoiceId, adapter) {
  const { status } = await fetchLegalHoldStatus(invoiceId, adapter);
  return status === LEGAL_HOLD_STATUS.HELD;
}

/**
 * Safely parses the JSON `latest_event_body` written by the indexer projection.
 *
 * @param {unknown} rawBody - Raw value from the projection row.
 * @returns {object} Parsed event body (empty object on failure).
 */
function _parseEventBody(rawBody) {
  if (rawBody && typeof rawBody === "string") {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_err) {
      return {};
    }
  }
  if (rawBody && typeof rawBody === "object") {
    return rawBody;
  }
  return {};
}

/**
 * Normalises a `fundedAmount` candidate to a finite non-negative number.
 *
 * @param {unknown} raw - Any value (string, number).
 * @returns {number} Finite number, 0 when unparseable.
 */
function _coerceFundedAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return n;
}

/**
 * Reads the latest projection row for an invoice and normalises it into the
 * base-state envelope used by the rest of the read path.
 *
 * @param {string} safeId - Validated, trimmed invoice ID.
 * @param {import('knex').Knex} [dbClient=db] - Knex instance.
 * @returns {Promise<object|null>} Normalised base state, or null when missing.
 * Security notes:
 *  - We never trust `eventBody.status` / `eventBody.fundedAmount` to override
 *    `latest_event_type` blindly; the envelope (`latest_event_type`) is the
 *    indexer's source of truth, while `eventBody` provides enrichments.
 *  - Decimals that may appear on the projection are display-only. They are
 *    never copied into the base-state return value and must NEVER be used to
 *    scale on-chain principal math (see `src/services/tokenMeta.js`).
 *  - Soft-deleted rows (`deleted_at` set, issue #31) are treated as absent so
 *    every default read falls through to the neutral `not_found` state. The
 *    filter is applied in JS rather than in the WHERE clause because the row
 *    is fetched by primary key either way, and callers that need the tombstone
 *    (the restore path) go through `services/escrowReadSoftDelete`.
 *
 * @param {string} safeId - Validated, trimmed invoice ID.
 * @param {import('knex').Knex} [dbClient=db] - Knex instance (injectable for tests).
 * @param {object} [options={}]
 * @param {boolean} [options.includeDeleted=false] - Include soft-deleted rows.
 * @returns {Promise<object|null>} Normalised base state, or null when no
 *   projection row exists for the invoice, the row is soft-deleted, or the DB
 *   read fails.
 */
async function _readBaseStateFromProjection(safeId, dbClient = db, options = {}) {
  try {
    const projection = await dbClient("escrow_event_projection")
      .where("invoice_id", safeId)
      .first();

    if (!projection) {
      return null;
    }

    // Issue #31 — soft-deleted escrow-read records are excluded from default
    // reads; they remain restorable until the retention window elapses.
    if (!options.includeDeleted && projection.deleted_at != null) {
      return null;
    }

    const eventBody = _parseEventBody(projection.latest_event_body);
    const status =
      (typeof eventBody.status === "string" && eventBody.status) ||
      (typeof projection.latest_event_type === "string" &&
        projection.latest_event_type) ||
      "unknown";

    const hasMeaningfulProjection =
      status !== "unknown" ||
      Object.prototype.hasOwnProperty.call(eventBody, "fundedAmount") ||
      Object.prototype.hasOwnProperty.call(eventBody, "ledgerCloseTime") ||
      Object.prototype.hasOwnProperty.call(eventBody, "maturityDate") ||
      Object.prototype.hasOwnProperty.call(eventBody, "maturityTimestamp");

    if (!hasMeaningfulProjection) {
      return null;
    }

    const latestLedger = Number(projection.latest_ledger_sequence);
    return {
      invoiceId: safeId,
      status,
      fundedAmount: _coerceFundedAmount(eventBody.fundedAmount),
      latest_ledger_sequence: Number.isFinite(latestLedger)
        ? latestLedger
        : null,
      latest_event_type: projection.latest_event_type || null,
      latest_event_id: projection.latest_event_id || null,
      latest_paging_token: projection.latest_paging_token || null,
      latest_observed_at: projection.latest_observed_at || null,
      source: "projection",
      fromProjection: true,
    };
  } catch (err) {
    logger.warn(
      { invoiceId: safeId, err: err?.message },
      "escrowRead: projection read failed; falling back to RPC stub",
    );
    return null;
  }
}

/**
 * Fetches the base escrow state for an invoice using projection-first ordering.
 *
 * @param {string} invoiceId - Validated invoice ID.
 * @param {Function} [adapter] - Optional async test adapter.
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Override the default
 *   Knex instance for tests.
 * @param {boolean} [options.includeDeleted=false] - When true, soft-deleted
 *   (issue #31) projection rows are read instead of being hidden.
 * @returns {Promise<object>} Base escrow state without `legal_hold`.
 */
async function _fetchBaseEscrowState(invoiceId, adapter, options = {}) {
  if (adapter) {
    return callSorobanContract(() => adapter(invoiceId));
  }

  const projectionState = await _readBaseStateFromProjection(
    invoiceId,
    options.dbClient,
    { includeDeleted: options.includeDeleted === true },
  );
  if (projectionState) {
    return projectionState;
  }

  return callSorobanContract(async () => ({
    invoiceId,
    ...NEUTRAL_BASE_STATE,
  }));
}

/**
 * Reads the full escrow state for an invoice from the Soroban contract and
 * enriches it with the `legal_hold` flag and token metadata.
 *
 * Emits an outbound `escrow_read` event webhook asynchronously.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @returns {Promise<EscrowState>} Enriched escrow state object.
 */
async function readEscrowState(invoiceId, options = {}) {
  const {
    legalHoldAdapter,
    escrowAdapter,
    fundingAsset,
    tokenMetaAdapter,
    dbClient,
  } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = "INVALID_INVOICE_ID";
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  const [baseState, legalHoldResult] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter, { dbClient }),
    fetchLegalHoldStatus(safeId, legalHoldAdapter),
  ]);

  const legalHoldStatus = legalHoldResult.status;
  const legalHoldBool =
    legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
    legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;

  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        "escrowRead: Failed to fetch token metadata, continuing without it",
      );
    }
  }

  const resultState = {
    ...baseState,
    legal_hold: legalHoldBool,
    legalHoldStatus,
    ...(legalHoldResult.reason
      ? { legalHoldReason: legalHoldResult.reason }
      : {}),
    ...(legalHoldResult.errorCode
      ? { legalHoldErrorCode: legalHoldResult.errorCode }
      : {}),
    funding_token: tokenMetadata,
    ...(baseState.ledgerCloseTime != null
      ? { ledgerCloseTime: baseState.ledgerCloseTime }
      : {}),
  };

  // Dispatch outbound escrow-read webhook event asynchronously
  if (typeof emitEscrowReadWebhook === "function") {
    emitEscrowReadWebhook({
      eventType: "escrow.read",
      invoiceId: safeId,
      state: resultState,
      timestamp: new Date().toISOString(),
    }).catch((err) => {
      logger.warn(
        { invoiceId: safeId, err: err?.message },
        "escrowRead: Failed to dispatch escrow.read webhook",
      );
    });
  }

  return resultState;
}

/**
 * Fetches the attestation append log for an invoice from the Soroban contract.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function for testing.
 * @returns {Promise<Array<{index: number, digest: string}>>} Array of attestation entries.
 */
async function fetchAttestationAppendLog(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        return [
          { index: 0, digest: Buffer.from("deadbeef", "hex") },
          { index: 1, digest: Buffer.from("cafebabe", "hex") },
        ];
      };

  try {
    const result = await callSorobanContract(operation);
    if (!Array.isArray(result)) {
      logger.warn(
        { invoiceId },
        "escrowRead: get_attestation_append_log returned non-array",
      );
      return [];
    }
    return result.map((entry) => ({
      index: entry.index,
      digest: entry.digest ? entry.digest.toString("hex") : "",
    }));
  } catch (err) {
    logger.warn(
      { invoiceId, errCode: err?.code },
      "escrowRead: get_attestation_append_log call failed — returning empty array",
    );
    return [];
  }
}

/**
 * Reads full escrow state including attestation digests for investor diligence.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @returns {Promise<EscrowStateWithAttestations>} Enriched escrow state with attestations.
 */
async function readEscrowStateWithAttestations(invoiceId, options = {}) {
  const {
    legalHoldAdapter,
    escrowAdapter,
    attestationAdapter,
    fundingAsset,
    tokenMetaAdapter,
    dbClient,
  } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = "INVALID_INVOICE_ID";
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();

  const [baseState, legalHoldResult, attestations] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter, { dbClient }),
    fetchLegalHoldStatus(safeId, legalHoldAdapter),
    fetchAttestationAppendLog(safeId, attestationAdapter),
  ]);

  const legalHoldStatus = legalHoldResult.status;
  const legalHoldBool =
    legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
    legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;

  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        "escrowRead: Failed to fetch token metadata, continuing without it",
      );
    }
  }

  const resultState = {
    ...baseState,
    legal_hold: legalHoldBool,
    legalHoldStatus,
    ...(legalHoldResult.reason
      ? { legalHoldReason: legalHoldResult.reason }
      : {}),
    ...(legalHoldResult.errorCode
      ? { legalHoldErrorCode: legalHoldResult.errorCode }
      : {}),
    attestations,
    funding_token: tokenMetadata,
    ...(baseState.ledgerCloseTime != null
      ? { ledgerCloseTime: baseState.ledgerCloseTime }
      : {}),
  };

  // Dispatch outbound webhook event asynchronously
  if (typeof emitEscrowReadWebhook === "function") {
    emitEscrowReadWebhook({
      eventType: "escrow.read_attestations",
      invoiceId: safeId,
      state: resultState,
      timestamp: new Date().toISOString(),
    }).catch((err) => {
      logger.warn(
        { invoiceId: safeId, err: err?.message },
        "escrowRead: Failed to dispatch escrow.read_attestations webhook",
      );
    });
  }

  return resultState;
}

/**
 * Reads only the on-chain `funded_amount` for an invoice.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @returns {Promise<number>}
 */
async function readFundedAmount(invoiceId, options = {}) {
  const { escrowAdapter, dbClient } = options;

  const { valid, reason } = validateInvoiceId(invoiceId);
  if (!valid) {
    const err = new Error(reason);
    err.code = "INVALID_INVOICE_ID";
    err.status = 400;
    throw err;
  }

  const safeId = invoiceId.trim();
  const baseState = await _fetchBaseEscrowState(safeId, escrowAdapter, {
    dbClient,
  });

  const raw =
    baseState && typeof baseState === "object"
      ? baseState.fundedAmount
      : baseState;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Retrieves the escrow state from cache or projection, falling back to a live RPC read.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @returns {Promise<Object>}
 * Resolves whether the projection/cache-based escrow read path is enabled.
 * Checks the `ESCROW_READ_PROJECTION_ENABLED` environment flag.
 * Defaults to `true` when config is not yet validated (e.g. in tests).
 *
 * @returns {boolean} `true` when projection-based reads are enabled.
 */
function isProjectionEnabled() {
  try {
    const cfg = getConfig();
    return cfg.ESCROW_READ_PROJECTION_ENABLED === 'true';
  } catch (_e) {
    // Config not validated yet — safe default is enabled
    return true;
  }
}

/**
 * Retrieves the escrow state from the projection or cache,
 * falling back to live read if necessary.
 *
 * When `ESCROW_READ_PROJECTION_ENABLED` is set to `false`, the
 * projection/cache path is skipped entirely and the function falls
 * through directly to a live Soroban contract read.
 *
 * @param {string} invoiceId - Invoice identifier
 * @returns {Promise<Object>} The escrow state
 */
async function getEscrowStateWithProjection(invoiceId, options = {}) {
  const safeId = invoiceId.trim();
  const { dbClient } = options;

  const localCached = escrowReadCache.get(safeId);
  if (localCached !== undefined) {
    return localCached;
  }

  // Gate: if the projection feature flag is disabled, skip cache & DB
  // and go directly to a live Soroban read.
  if (!isProjectionEnabled()) {
    const baseState = await _fetchBaseEscrowState(safeId);
    const legalHold = await fetchLegalHold(safeId);
    return {
      ...baseState,
      legal_hold: legalHold,
      latest_event_type: 'live_read',
    };
  }

  // Try cache first if enabled
  if (cache) {
    const cacheResult = await cache.getSummary(safeId);
    if (cacheResult.hit) {
      escrowReadCache.set(safeId, cacheResult.value);
      return cacheResult.value;
    }
  }

  const projectionState = await _readBaseStateFromProjection(safeId, dbClient);
  if (projectionState) {
    if (cache) {
      await cache.setSummary(
        safeId,
        projectionState,
        projectionState.latest_ledger_sequence,
      );
    }
    escrowReadCache.set(safeId, projectionState);
    return projectionState;
  }

  const baseState = await _fetchBaseEscrowState(safeId, undefined, { dbClient });
  const legalHoldResult = await fetchLegalHoldStatus(safeId);
  const legalHoldStatus = legalHoldResult.status;
  const legalHoldBool =
    legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
    legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;

  const state = {
    ...baseState,
    legal_hold: legalHoldBool,
    legalHoldStatus,
    ...(legalHoldResult.reason
      ? { legalHoldReason: legalHoldResult.reason }
      : {}),
    ...(legalHoldResult.errorCode
      ? { legalHoldErrorCode: legalHoldResult.errorCode }
      : {}),
    latest_event_type: baseState.latest_event_type || "live_read",
    source: baseState.source || "rpc_stub",
  };

  if (cache) {
    await cache.setSummary(safeId, state);
  }
  escrowReadCache.set(safeId, state);

  return state;
}

/**
 * Invalidates the cached response for an invoice after an escrow write.
 * @param {string} invoiceId Invoice whose cached read is stale.
 * @returns {Promise<boolean>}
 */
async function invalidateEscrowReadCache(invoiceId) {
  if (typeof invoiceId !== "string") {
    return false;
  }
  const safeId = invoiceId.trim();
  const localInvalidated = escrowReadCache.invalidate(safeId);
  const redisInvalidated = cache
    ? await cache.deleteSummary(safeId)
    : false;
  return localInvalidated || redisInvalidated;
}

module.exports = {
  readEscrowState,
  readEscrowStateWithAttestations,
  readFundedAmount,
  fetchLegalHold,
  fetchLegalHoldStatus,
  fetchAttestationAppendLog,
  validateInvoiceId,
  getEscrowStateWithProjection,
  invalidateEscrowReadCache,
  isProjectionEnabled,
  LEGAL_HOLD_STATUS,
  LEGAL_HOLD_UNKNOWN_REASONS,
  coerceLegalHoldStatus,
};
