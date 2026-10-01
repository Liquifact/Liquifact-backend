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

/**
 * Compatibility contract version for the escrow-read service surface.
 * Bump only when a breaking change is made to the returned envelope shape
 * or to the exported symbol set. Consumers may pin against this value to
 * detect incompatible upgrades. See `src/config/escrowVersions.js` for the
 * canonical registry.
 *
 * @constant {string}
 */
const ESCROW_READ_CONTRACT_VERSION = "1.0.0";

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
 * Canonical set of keys that every escrow-read envelope is guaranteed to
 * expose. Downstream consumers (routes, dashboards, webhook subscribers)
 * may rely on these being present regardless of the read path taken
 * (adapter, projection, cache, or RPC stub). Adding a key is a
 * non-breaking change; removing or renaming one requires a major version
 * bump of {@link ESCROW_READ_CONTRACT_VERSION}.
 *
 * @constant {ReadonlyArray<string>}
 */
const ESCROW_READ_REQUIRED_KEYS = Object.freeze([
  "invoiceId",
  "status",
  "fundedAmount",
  "legal_hold",
  "legalHoldStatus",
  "source",
]);

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
  latest_event_type: "live_read",
});

/**
 * Ensures the given envelope exposes every key in
 * {@link ESCROW_READ_REQUIRED_KEYS}. Missing keys are filled with safe
 * defaults so callers never observe `undefined` for a contract-guaranteed
 * field. This is the single place where the compatibility contract is
 * enforced; all public read functions route their return value through it.
 *
 * Invariants:
 *  - `invoiceId` is always the trimmed input ID.
 *  - `status` defaults to `"unknown"` (never fabricated as funded).
 *  - `fundedAmount` defaults to `0` (never fabricated as funded).
 *  - `legal_hold` defaults to `true` (fail-closed) when absent.
 *  - `legalHoldStatus` defaults to `"unknown"` when absent.
 *  - `source` defaults to `"rpc_stub"` when absent.
 *
 * @param {object} state - Candidate envelope.
 * @param {string} safeId - Validated, trimmed invoice ID.
 * @returns {object} Envelope with all required keys present.
 */
function _enforceReadContract(state, safeId) {
  const base =
    state && typeof state === "object" && !Array.isArray(state)
      ? state
      : {};
  const legalHoldStatus =
    typeof base.legalHoldStatus === "string"
      ? base.legalHoldStatus
      : LEGAL_HOLD_STATUS.UNKNOWN;
  const legalHold =
    typeof base.legal_hold === "boolean"
      ? base.legal_hold
      : legalHoldStatus === LEGAL_HOLD_STATUS.HELD ||
        legalHoldStatus === LEGAL_HOLD_STATUS.UNKNOWN;
  return {
    invoiceId: safeId,
    status: typeof base.status === "string" ? base.status : "unknown",
    fundedAmount: _coerceFundedAmount(base.fundedAmount),
    source: typeof base.source === "string" ? base.source : "rpc_stub",
    ...base,
    invoiceId: safeId,
    legal_hold: legalHold,
    legalHoldStatus,
  };
}

/**
 * Validates an invoice ID string using the canonical escrow-read Zod schema.
 *
 * Delegates to {@link module:schemas/escrowRead.escrowReadParamsSchema} so
 * all escrow-read paths share one validation rule. The Zod schema already
 * enforces:
 *  - Non-empty string
 *  - Starts with alphanumeric
 *  - Contains only alphanumeric, undersczore, hyphen, dot, colon
 *  - Max 128 characters
 *
 * @param {unknown} invoiceId - Value to validate.
 * @returns {{valid: boolean, reason?: string}}
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
 *   - {@link LEGAL_HOLD_STATUS.UNKNOWN}  — rPC error, timeout, circuit-open,
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
        errCode: err.code,
        reason: LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR,
      },
      "escrowRead: get_legal_hold call failed — status is unknown, gate must fail closed",
    );
    return {
      status: LEGAL_HOLD_STATUS.UNKNOWN,
      reason: LEGAL_HOLD_UNKNOWN_REASONS.RPC_ERROR,
      errorCode: typeof err.code === "string" ? err.code : undefined,
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
 * Reads the latest projection row for a
 *
 * @param {string} invoiceId - Validated invoice identifier.
 * @returns {Promise<object>} Projection derived state or null when not found.
 */
async function _readProjection(invoiceId) {
  try {
    const row = await db
      ("escrow_event_projection")
      .where({ invoice_id: invoiceId })
      .first();
    if (!row) {
      return null;
    }
    const body = _parseEventBody(row.latest_event_body);
    const legalHoldStatus =
      typeof body.legalHoldStatus === "string"
        ? body.legalHoldStatus
        : typeof body.legal_hold === "boolean"
          ? _coerceLegalHoldStatus(body.legal_hold)
          : LEGAL_HOLD_STATUS.UNKNOWN;
    return {
      status: typeof row.status === "string" ? row.status : "unknown",
      fundedAmount: _coerceFundedAmount(row.funded_amount),
      source: "projection",
      latest_event_type: row.latest_event_type || "live_read",
      legalHoldStatus,
      legal_hold: legalHoldStatus === LEGAL_HOLD_STATUS.HELD,
    };
  } catch (err) {
    logger.warn(
      { invoiceId, errCode: err.code },
      "escrowRead: projection read failed",
    );
    return null;
  }
}

/**
 * Fetches the escrow state for an invoice, routing through the cache,
 * projection, and RPC stub fallback chain. The returned envelope is
 * guaranteed to expose every key in {@link ESCROW_READ_REQUIRED_KEYS}.
 *
 * @param {string} invoiceId - Raw invoice identifier.
 * @param {object} [opts] - Options.
 * @param {Function} [opts.escrowAdapter] - Test adapter that returns the
 *   full escrow state for the invoice.
 * @returns {Promise<object>} Escrow state envelope.
 */
async function getEscrowState(invoiceId, opts = {}) {
  const validation = validateInvoiceId(invoiceId);
  if (!validation.valid) {
    const err = new Error(validation.reason);
    err.code = "INVALID_INVOICE_ID";
    throw err;
  }
  const safeId = String(invoiceId).trim();

  if (typeof opts.escrowAdapter === "function") {
    const adapted = await opts.escrowAdapter(safeId);
    return _enforceReadContract(
      { ...NEUTRAL_BASE_STATE, ...adapted, source: "adapter" },
      safeId,
    );
  }

  const cached = await cache.get(safeId);
  if (cached) {
    return _enforceReadContract(cached, safeId);
  }

  const projection = await _readProjection(safeId);
  if (projection) {
    await cache.set(safeId, projection);
    return _enforceReadContract(projection, safeId);
  }

  return _enforceReadContract(NEUTRAL_BASE_STATE, safeId);
}

/**
 * Returns the escrow state together with the derived projection fields
 * (legal hold tri-state, days to maturity, etc.) used by the HTTP routes.
 *
 * @param {string} invoiceId - Raw invoice identifier.
 * @param {object} [opts] - Options forwarded to {@link getEscrowState}.
 * @returns {Promise<object>} Escrow state envelope.
 */
async function getEscrowStateWithProjection(invoiceId, opts = {}) {
  return getEscrowState(invoiceId, opts);
}

module.exports = {
  ESCROW_READ_CONTRACT_VERSION,
  ESCROW_READ_REQUIRED_KEYS,
  LEGAL_HOLD_STATUS,
  LEGAL_HOLD_UNKNOWN_REASONS,
  NEUTRAL_BASE_STATE,
  coerceLegalHoldStatus,
  fetchLegalHoldStatus,
  fetchLegalHold,
  validateInvoiceId,
  getEscrowState,
  getEscrowStateWithProjection,
};
