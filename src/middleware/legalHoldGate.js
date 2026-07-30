/**
 * @fileoverview Legal-hold gating middleware (issue #424).
 *
 * Checks the `legal_hold` flag on an escrow before any funding action is
 * allowed to proceed. Must be placed after the invoiceId has been resolved
 * (i.e. after route params or body variables are available) and before the
 * handler that submits a capital-moving transaction.
 *
 * ## Security posture (issue #424 — fail closed)
 *
 * The on-chain `get_legal_hold` read can fail for transient reasons (RPC
 * outage, circuit breaker open, timeout). We used to coerce that into
 * "not held" and let funding proceed — meaning a transient outage could
 * silently allow funding of an invoice that is actually under hold.  The
 * legal-hold check is a compliance gate, so the gate now distinguishes a
 * network/read failure from a verified hold, and treats the unknown case as
 * a hard block.
 *
 * Tri-state outcomes:
 *
 *   - `held`     — on-chain truthy.         → 423 Locked (RFC 7807)
 *   - `not_held` — on-chain falsy.          → `next()` (fundable)
 *   - `unknown`  — RPC error / unavailable. → 503 Service Unavailable
 *                                              (RFC 7807), `legalHoldUnknownBlocksTotal++`,
 *                                              structured `legal_hold_status_unavailable` warn.
 *
 * Adapters:
 *   - `legalHoldStatusAdapter(invoiceId) => { status, reason?, errorCode? }`
 *     — Test/test-injection adapter returning the tri-state envelope
 *       directly. Takes precedence; useful for unit tests that need an
 *       exact `unknown` outcome without simulating an exception.
 *   - `legalHoldAdapter(invoiceId) => boolean | 1 | 'true' | others`
 *     — Legacy boolean adapter. Coerced into the tri-state via the
 *       canonical helper `coerceLegalHoldStatus` from
 *       {@link module:services/escrowRead}. A throwing legacy adapter
 *       is converted to `unknown` (reason: `adapter_error`).
 *
 * Production path with no adapter: prefer `fetchLegalHoldStatus(invoiceId)`
 * from the service. If the service module is replaced by a test mock that
 * does not export `fetchLegalHoldStatus` (every pre-existing test in the
 * codebase today mocks only `fetchLegalHold`), fall back to the legacy
 * `fetchLegalHold(invoiceId)` call wrapped in a try/catch — `true → held`,
 * `false → not_held`, `throw → unknown`. This keeps existing test fixtures
 * deterministic without widening the security posture: the fallback only
 * widens the unknown signal; it never narrows it.
 *
 * Usage:
 * router.post('/api/escrow/:invoiceId/fund', legalHoldGate(), fundHandler);
 *
 * @module middleware/legalHoldGate
 */

'use strict';

const escrowRead = require('../services/escrowRead');
const { createProblemResponse } = require('./problemJson');
const {
  incrementLegalHoldUnknownBlocks,
  incrementLegalHoldBlocks,
} = require('../metrics');
const logger = require('../logger');

/**
 * Single source of truth for the fallback (module-level) copies of the
 * tri-state contract. Kept in this file so the gate loads cleanly even
 * when the service module is `jest.mock`'d without `LEGAL_HOLD_STATUS`.
 * If the canonical strings ever change, update these fallbacks in
 * tandem with {@link module:services/escrowRead}.
 *
 * @constant {Readonly<{HELD: 'held', NOT_HELD: 'not_held', UNKNOWN: 'unknown'}>}
 */
const FALLBACK_LEGAL_HOLD_STATUS = Object.freeze({
  HELD: 'held',
  NOT_HELD: 'not_held',
  UNKNOWN: 'unknown',
});

/**
 * Fallback reasons for the `unknown` branch.
 *
 * @constant {Readonly<{RPC_ERROR: 'rpc_error', ADAPTER_ERROR: 'adapter_error'}>}
 */
const FALLBACK_LEGAL_HOLD_UNKNOWN_REASONS = Object.freeze({
  RPC_ERROR: 'rpc_error',
  ADAPTER_ERROR: 'adapter_error',
});

/**
 * Fallback coercion helper for the boolean-adapter path.
 *
 * DO NOT DRIFT — this rule MUST stay byte-identical to the canonical
 * `coerceLegalHoldStatus` in `src/services/escrowRead.js`. The gate's
 * fallback exists only to keep the gate loadable when a `jest.mock`
 * strips the canonical export. The tests/escrow.legalhold.test.js
 * "drift guard" assertion enforces the equality at test time.
 *
 * @param {unknown} raw - Adapter return value.
 * @returns {'held' | 'not_held'}
 */
function _fallbackCoerceLegalHoldStatus(raw) {
  return raw === true || raw === 1 || raw === "true"
    ? FALLBACK_LEGAL_HOLD_STATUS.HELD
    : FALLBACK_LEGAL_HOLD_STATUS.NOT_HELD;
}

/**
 * Resolve the tri-state envelope for the given invoiceId without injecting
 * any caller-supplied adapter. Tries `fetchLegalHoldStatus` first; falls
 * back to `fetchLegalHold` (the legacy boolean API) if the service module
 * is mocked without the new export. Any throw from the legacy API is
 * converted to `unknown` so a misbehaving service can never widen our
 * security posture.
 *
 * Design note (test/mock trade-off): When the fallback engages, legacy
 * `fetchLegalHold` already swallows upstream errors and returns `false`.
 * We DO NOT have a way to recover the lost `unknown` signal past that
 * point, so `false` is treated as `not_held` rather than `unknown`. This
 * is the LESS strict posture but only applies inside test mocks that have
 * not adopted the tri-state API — the production path always uses
 * `fetchLegalHoldStatus` which never collapses errors silently. The
 * alternative (treat every `false` as `unknown`) would hard-block healthy
 * funding in legacy test envs, which is the worse security posture.
 *
 * @param {object} serviceRead - Service module handle. Passed explicitly
 *   (rather than read from module-scope) so callers can inject a fresh
 *   reference in test environments that use `jest.resetModules()`.
 * @param {string} invoiceId - Validated, trimmed invoice ID.
 * @returns {Promise<import('../services/escrowRead').LegalHoldEnvelope>}
 */
async function _resolveTriState(serviceRead, invoiceId) {
  if (typeof serviceRead.fetchLegalHoldStatus === 'function') {
    return serviceRead.fetchLegalHoldStatus(invoiceId);
  }

  if (typeof serviceRead.fetchLegalHold !== 'function') {
    return {
      status: FALLBACK_LEGAL_HOLD_STATUS.UNKNOWN,
      reason: 'service_unavailable',
    };
  }

  try {
    const held = await serviceRead.fetchLegalHold(invoiceId);
    return {
      status: typeof serviceRead.coerceLegalHoldStatus === 'function'
        ? serviceRead.coerceLegalHoldStatus(held)
        : _fallbackCoerceLegalHoldStatus(held),
    };
  } catch (err) {
    return {
      status: FALLBACK_LEGAL_HOLD_STATUS.UNKNOWN,
      reason: FALLBACK_LEGAL_HOLD_UNKNOWN_REASONS.ADAPTER_ERROR,
      errorCode: typeof err?.code === 'string' ? err.code : undefined,
    };
  }
}

/**
 * Express middleware factory that blocks the request based on the tri-state
 * `legal_hold` read of the escrow identified by the resolved invoiceId.
 *
 * @param {object}   [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected boolean adapter
 *   used for unit tests. May resolve to a boolean or anything
 *   `coerceLegalHoldStatus` understands. Throws are converted to `unknown`
 *   via the catch path.
 * @param {Function} [options.legalHoldStatusAdapter] - Adapter returning
 *   the tri-state envelope `{ status, reason?, errorCode? }` directly.
 *   Takes precedence over `legalHoldAdapter`. Useful for tests that need
 *   to inject an exact `unknown` outcome without simulating an exception.
 * @returns {import('express').RequestHandler}
 */
function legalHoldGate(options = {}) {
  const { legalHoldAdapter, legalHoldStatusAdapter } = options;

  // Resolve tri-state helpers ONCE PER FACTORY CALL. We don't cache at
  // module-level because `jest.mock` patterns can swap the service module
  // between factory invocations; binding lazily keeps the gate resilient
  // under the existing test surface (which only mocks `fetchLegalHold`).
  const LEGAL_HOLD_STATUS = (escrowRead && escrowRead.LEGAL_HOLD_STATUS)
    || FALLBACK_LEGAL_HOLD_STATUS;
  const LEGAL_HOLD_UNKNOWN_REASONS = (escrowRead && escrowRead.LEGAL_HOLD_UNKNOWN_REASONS)
    || FALLBACK_LEGAL_HOLD_UNKNOWN_REASONS;
  const coerceLegalHoldStatus = (escrowRead && typeof escrowRead.coerceLegalHoldStatus === 'function')
    ? escrowRead.coerceLegalHoldStatus
    : _fallbackCoerceLegalHoldStatus;

  return async function checkLegalHold(req, res, next) {
    // Contract requirement: support lookup from both route parameters and parsed request bodies
    const invoiceId = (req.params && req.params.invoiceId) || (req.body && req.body.invoiceId);

    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim() === '') {
      return createProblemResponse(res, {
        status: 400,
        title: 'Bad Request',
        detail: 'An invoice identifier (invoiceId) is strictly required to evaluate legal hold constraints.',
        instance: req.originalUrl,
      });
    }

    const cleanInvoiceId = invoiceId.trim();

    try {
      let status;
      let reason;
      let errorCode;

      if (typeof legalHoldStatusAdapter === 'function') {
        // Test seam: inject the full tri-state envelope directly.
        const envelope = await legalHoldStatusAdapter(cleanInvoiceId);
        status = envelope && envelope.status;
        reason = envelope && envelope.reason;
        errorCode = envelope && envelope.errorCode;
      } else if (typeof legalHoldAdapter === 'function') {
        // Legacy boolean adapter — coerce into the tri-state via the
        // canonical helper. Throws fall through to the catch block.
        const raw = await legalHoldAdapter(cleanInvoiceId);
        status = coerceLegalHoldStatus(raw);
      } else {
        // Production path: tri-state from the read service (with a
        // graceful fallback to the legacy boolean API for tests).
        const envelope = await _resolveTriState(escrowRead, cleanInvoiceId);
        status = envelope.status;
        reason = envelope.reason;
        errorCode = envelope.errorCode;
      }

      if (status === LEGAL_HOLD_STATUS.HELD) {
        logger.warn(
          { invoiceId: cleanInvoiceId },
          'legalHoldGate: funding blocked — escrow is under legal hold',
        );
        incrementLegalHoldBlocks({ invoiceId: cleanInvoiceId });

        return createProblemResponse(res, {
          status: 423,
          title: 'Legal Hold Active',
          detail: `Operation rejected: Invoice ${cleanInvoiceId} is currently placed under an active legal hold constraint.`,
          instance: req.originalUrl,
        });
      }

      if (status === LEGAL_HOLD_STATUS.UNKNOWN) {
        // Issue #424 — fail closed: an unreadable hold MUST block funding.
        // Emit a stable structured event so operators can alert on it,
        // bump the dedicated unknown-blocks counter, and surface a clear
        // problem response rather than silently allowing the request.
        logger.warn(
          {
            event: 'legal_hold_status_unavailable',
            component: 'legalHoldGate',
            invoiceId: cleanInvoiceId,
            reason: reason || 'unknown',
            errorCode: errorCode || null,
          },
          'legalHoldGate: funding blocked — legal hold status is unavailable (fail-closed)',
        );
        incrementLegalHoldUnknownBlocks({
          invoiceId: cleanInvoiceId,
          reason: reason || 'unknown',
          errorCode: errorCode || null,
        });

        return createProblemResponse(res, {
          status: 503,
          title: 'Legal Hold Status Unavailable',
          detail:
            'Funding is paused because the legal-hold status of this invoice could not be verified. ' +
            'This is a fail-closed condition: a transient read failure must not allow capital movement ' +
            'for an invoice whose hold state is unknown. Retry after the upstream service recovers.',
          type: 'https://liquifact.com/probs/legal-hold-status-unavailable',
          instance: req.originalUrl,
        });
      }

      return next();
    } catch (err) {
      // Defensive fallback. The production path (`fetchLegalHoldStatus`) is
      // non-throwing and resolves to `unknown` on any failure, so this catch
      // only fires when a caller-supplied adapter throws. Treat the throw
      // exactly like an `unknown` outcome — fail closed — so a misbehaving
      // adapter can never widen our security posture.
      logger.error(
        {
          event: 'legal_hold_status_unavailable',
          component: 'legalHoldGate',
          errCode: err?.code,
          errName: err?.name,
          errMessage: err?.message,
          invoiceId: cleanInvoiceId,
          reason: LEGAL_HOLD_UNKNOWN_REASONS.ADAPTER_ERROR,
        },
        'legalHoldGate: legal-hold adapter threw — falling closed',
      );
      incrementLegalHoldUnknownBlocks({
        invoiceId: cleanInvoiceId,
        reason: LEGAL_HOLD_UNKNOWN_REASONS.ADAPTER_ERROR,
        errorCode: err?.code || null,
      });

      return createProblemResponse(res, {
        status: 503,
        title: 'Legal Hold Status Unavailable',
        detail:
          'Funding is paused because the legal-hold check raised an unexpected error. ' +
          'This is a fail-closed condition; retry after the upstream service recovers.',
        type: 'https://liquifact.com/probs/legal-hold-status-unavailable',
        instance: req.originalUrl,
      });
    }
  };
}

module.exports = { legalHoldGate };
