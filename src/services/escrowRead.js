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
 * @constant {Readonly<{HEL: 'held', NOT_HELD: 'not_held', UNKNOWN: 'unknown'}>}
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
 * Regex that a valid invoice ID must satisfy.
 * Aligned with IDENTIFIER_PATTERN in escrowSubmit.js.
 * Allows alphanumeric start, followed by alphanumeric, underscores, hyphens, dots, or colons, 1–128 chars.
 *
 * @constant {RegExp}
 */
const INVOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
 * Validates an invoice ID string.
 *
 * @param {unknown} invoiceId - Value to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateInvoiceId(invoiceId) {
  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    return { valid: false, reason: "invoiceId must be a non-empty string" };
  }
  if (!INVOICE_ID_RE.test(invoiceId.trim())) {
    return {
      valid: false,
      reason: "invoiceId contains invalid characters (allowed: a-z A-Z 0-9 _ -)",
    };
  }
  return { valid: true };
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
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_legal_hold', [invoiceId]);
        return false;
      };

  try {
    const result = await callSorobanContract(operation);
    return { status: _coerceLegalHoldStatus(result) };
  } catch (err) {
    // Issue #424: a transient RPC failure MUST NOT be reported as NOT_HELD.
    // The middleware (legalHoldGate.js) treats `unknown` as 503 service
    // unavailable and blocks the funding path.
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
 * @deprecated Prefer {@link fetchLegalHoldStatus} for security-sensitive
 *   callers; the boolean return value silently collapses `unknown` into
 *   `false` and provides no signal to distinguish the two. This function is
 *   retained for backward compatibility with `readEscrowState` and any
 *   legacy caller that simply wants `if (await fetchLegalHold(id))`.
 *
 * Behaviour:
 *   - `true`  → on-chain flag is truthy.
 *   - `false` → everything else, INCLUDING a failed RPC read. The companion
 *     `readEscrowState` flips `state.legal_hold` to `true` for an `unknown`
 *     read so failures are still failed-closed at the data-consumer level.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function `(invoiceId) => boolean`.
 *   Defaults to the production Soroban stub.
 * @returns {Promise<boolean>} Resolves to `true` when the escrow is under legal
 *   hold, `false` for any other outcome.
 */
async function fetchLegalHold(invoiceId, adapter) {
  const { status } = await fetchLegalHoldStatus(invoiceId, adapter);
  return status === LEGAL_HOLD_STATUS.HELD;
}

/**
 * Safely parses the JSON `latest_event_body` written by the indexer projection.
 * Returns an empty object on parse failure so callers can fall back to the
 * envelope-level event type without crashing.
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
 * Normalises a `fundedAmount` candidate to a finite non-negative number. Falls
 * back to `0` when the value is missing, NaN, or wrong-shaped so downstream
 * arithmetic stays NaN-free.
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
      // Backwards-compatible flag retained for callers that branch on it.
      fromProjection: true,
    };
  } catch (err) {
    // Treat any DB failure as "no projection" so the caller can attempt the
    // RPC fallback instead of failing the whole read.
    logger.warn(
      { invoiceId: safeId, err: err?.message },
      "escrowRead: projection read failed; falling back to RPC stub",
    );
    return null;
  }
}

/**
 * Fetches the base escrow state for an invoice using the projection-first
 * ordering:
 *
 *   1. Test adapter (when provided)
 *   2. `escrow_event_projection` row written by the indexer
 *   3. Neutral RPC stub (no fabricated values)
 *
 * Previously the RPC fallback returned hardcoded funded_invoice /
 * settled_invoice fixtures. Those were removed because they fabricated state
 * for invoices the indexer had not yet recorded, which misled the
 * reconciliation job and any investor-facing reads.
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
  // 1. Test adapter always wins — keeps unit tests deterministic.
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

  // 3. Neutral RPC stub — never fabricate state for arbitrary invoice IDs.
  return callSorobanContract(async () => ({
    invoiceId,
    ...NEUTRAL_BASE_STATE,
  }));
}

/**
 * Reads the full escrow state for an invoice from the Soroban contract and
 * enriches it with the `legal_hold` flag and token metadata.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object}  [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for
 *   `get_legal_hold`; used in tests.
 * @param {Function} [options.escrowAdapter] - Injected adapter for the base
 *   escrow state read; used in tests.
 * @param {Object} [options.fundingAsset] - Funding asset descriptor for token metadata.
 * @param {Function} [options.tokenMetaAdapter] - Injected adapter for token metadata.
 * @returns {Promise<EscrowState>} Enriched escrow state object.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowState
 * @property {string}  invoiceId    - The invoice identifier.
 * @property {string}  status       - On-chain escrow status string.
 * @property {number}  fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold   - Whether the escrow is under legal hold.
 * @property {Object|null} funding_token - Token metadata (symbol, name, decimals).
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

  // Fetch base escrow state and legal hold status concurrently.
  const [baseState, legalHoldResult] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter, { dbClient }),
    fetchLegalHoldStatus(safeId, legalHoldAdapter),
  ]);

  // Issue #424 — fail-closed at the data layer:
  //   * `state.legal_hold` (boolean) is `true` for both `held` and `unknown`
  //     so any caller that branches on `if (!state.legal_hold)` cannot
  //     accidentally fund an invoice whose hold status is unreadable.
  //   * `state.legalHoldStatus` carries the full tri-state for callers that
  //     need to distinguish a verified hold from an outage.
  const legalHoldStatus = legalHoldResult.status;
  const legalHoldBool =
    legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
    legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;

  // Fetch token metadata if funding asset is provided. This is best-effort:
  // any failure is logged but does not fail the whole read (warn-and-continue).
  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      // Log error but don't fail the entire request
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        "escrowRead: Failed to fetch token metadata, continuing without it",
      );
    }
  }

  return {
    ...baseState,
    legal_hold: legalHoldBool,
    legalHoldStatus,
    // Surface failure context so operators can investigate 'unknown' outcomes
    // without needing to re-read the service logs.
    ...(legalHoldResult.reason
      ? { legalHoldReason: legalHoldResult.reason }
      : {}),
    ...(legalHoldResult.errorCode
      ? { legalHoldErrorCode: legalHoldResult.errorCode }
      : {}),
    funding_token: tokenMetadata,
    // Forward ledger close time so callers can pass opts.ledgerCloseTime to
    // computeEscrowDerivedFields.  The field is present only when the Soroban
    // response includes it; absent otherwise (undefined is stripped by spread).
    ...(baseState.ledgerCloseTime != null
      ? { ledgerCloseTime: baseState.ledgerCloseTime }
      : {}),
  };
}

/**
 * Fetches the attestation append log for an invoice from the Soroban contract.
 * Returns an array of attestation entries with index and hex-encoded digest.
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @param {Function} [adapter] - Optional async function for testing.
 * @returns {Promise<Array<{index: number, digest: string}>>} Array of attestation entries.
 */
async function fetchAttestationAppendLog(invoiceId, adapter) {
  const operation = adapter
    ? () => adapter(invoiceId)
    : async () => {
        // Production stub — replace with real Soroban RPC invocation:
        //   return sorobanClient.invokeContract(contractId, 'get_attestation_append_log', [invoiceId]);
        // Expected return: array of {index: number, digest: Buffer}
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
    // Decode each entry: convert digest to hex string
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
 * Reads the full escrow state including attestation digests for investor diligence.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for `get_legal_hold`.
 * @param {Function} [options.escrowAdapter] - Injected adapter for base escrow state.
 * @param {Function} [options.attestationAdapter] - Injected adapter for attestation log.
 * @param {Object} [options.fundingAsset] - Funding asset descriptor for token metadata.
 * @param {Function} [options.tokenMetaAdapter] - Injected adapter for token metadata.
 * @returns {Promise<EscrowStateWithAttestations>} Enriched escrow state with attestations.
 * @throws {EscrowReadError} When `invoiceId` is invalid.
 *
 * @typedef {object} EscrowStateWithAttestations
 * @property {string} invoiceId - The invoice identifier.
 * @property {string} status - On-chain escrow status string.
 * @property {number} fundedAmount - Amount currently held in escrow.
 * @property {boolean} legal_hold - Whether the escrow is under legal hold.
 * @property {Array<{index: number, digest: string}>} attestations - Append-only attestation digests.
 * @property {Object|null} funding_token - Token metadata (symbol, name, decimals).
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

  // Issue #424 — same tri-state propagation as `readEscrowState`.
  const [baseState, legalHoldResult, attestations] = await Promise.all([
    _fetchBaseEscrowState(safeId, escrowAdapter, { dbClient }),
    fetchLegalHoldStatus(safeId, legalHoldAdapter),
    fetchAttestationAppendLog(safeId, attestationAdapter),
  ]);
  const legalHoldStatus = legalHoldResult.status;
  const legalHoldBool =
    legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
    legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;

  // Fetch token metadata if funding asset is provided (best-effort).
  let tokenMetadata = null;
  if (fundingAsset) {
    try {
      if (tokenMetaAdapter) {
        tokenMetadata = await tokenMetaAdapter(fundingAsset);
      } else {
        tokenMetadata = await getTokenMetadata(fundingAsset);
      }
    } catch (error) {
      // Log error but don't fail the entire request
      logger.warn(
        { invoiceId: safeId, asset: fundingAsset, error: error.message },
        "escrowRead: Failed to fetch token metadata, continuing without it",
      );
    }
  }

  return {
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
}

/**
 * Reads only the on-chain `funded_amount` for an invoice.
 *
 * This is a focused read used by the nightly reconciliation job, which only
 * needs the funded amount and not the full enriched escrow state (legal hold,
 * token metadata, attestations). It reuses the same validation and
 * projection-first ordering as the rest of the escrow read surface so
 * behaviour stays consistent.
 *
 * @param {string} invoiceId - Invoice identifier (validated internally).
 * @param {object} [options={}]
 * @param {Function} [options.escrowAdapter] - Injected adapter
 *   `(invoiceId) => { fundedAmount } | number` for tests. Defaults to the
 *   production projection-first base-state read.
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @returns {Promise<number>} The funded amount as a finite number. Falls back
 *   to `0` when the projection, adapter, or RPC stub returns no data so the
 *   reconciliation job never sees a fabricated value.
 * @throws {Error} With `code = 'INVALID_INVOICE_ID'` and `status = 400` when
 *   `invoiceId` is invalid.
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

  // Adapters may return either the full base-state object or a bare number.
  const raw =
    baseState && typeof baseState === "object"
      ? baseState.fundedAmount
      : baseState;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Retrieves the escrow state from the cache or projection, falling back to a
 * live RPC read if neither has data.
 *
 * Ordering (matches the docstring at the top of this module):
 *   1. Redis cache (when enabled) — short-circuit on hit.
 *   2. `escrow_event_projection` row (durable, written by the indexer).
 *      Reuses {@link _readBaseStateFromProjection} via
 *      {@link _fetchBaseEscrowState} so the projection shape and the
 *      reconciliation-friendly shape stay in lock-step.
 *   3. Live RPC stub — returns the neutral `not_found` envelope when neither
 *      cache nor projection know about the invoice.
 *
 * @param {string} invoiceId - Invoice identifier.
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (tests).
 * @returns {Promise<Object>} The escrow state.
 */
async function getEscrowStateWithProjection(invoiceId, options = {}) {
  const safeId = invoiceId.trim();
  const { dbClient } = options;

  // 1. The bounded local cache avoids DB/Redis work on the hottest reads.
  const localCached = escrowReadCache.get(safeId);
  if (localCached !== undefined) {
    return localCached;
  }

  // 2. Try the optional shared Redis cache. Cache wins on hit.
  if (cache) {
    const cacheResult = await cache.getSummary(safeId);
    if (cacheResult.hit) {
      escrowReadCache.set(safeId, cacheResult.value);
      return cacheResult.value;
    }
  }

  // 3. Read from the projection table via the shared helper, so projection
  //    shape stays consistent with readEscrowState / readFundedAmount /
  //    readEscrowStateWithAttestations.
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

  // 4. Fallback to live RPC read (neutral stub currently; real Soroban call
  //    once the contract is deployed).
  const baseState = await _fetchBaseEscrowState(safeId, undefined, { dbClient });
  // Issue #424 — read the tri-state so unknown failures stay distinguishable
  // from "not held" downstream.
  const legalHoldResult = await fetchLegalHoldStatus(safeId);
  const legalHoldStatus = legalHoldResult.status;
  const legalHoldBool =
    legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
    legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;

  // Preserve the legacy `latest_event_type === 'live_read'` marker so callers
  // and existing tests that branch on it keep working with the projection-first
  // refactor.
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
    // For live reads, we might not know the exact ledger, so we omit it.
    await cache.setSummary(safeId, state);
  }
  escrowReadCache.set(safeId, state);

  return state;
}

/**
 * Invalidates the cached response for an invoice after an escrow write.
 * @param {string} invoiceId Invoice whose cached read is stale.
 * @returns {Promise<boolean>} Whether a local or shared entry was removed.
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
  LEGAL_HOLD_STATUS,
  LEGAL_HOLD_UNKNOWN_REASONS,
  // Exported so the gate can reuse the canonical rule instead of
  // duplicating the inline coerce. Issue #424.
  coerceLegalHoldStatus,
};
