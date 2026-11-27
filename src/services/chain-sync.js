'use strict';

/**
 * @fileoverview Applies decoded on-chain escrow events to the invoice data store.
 *
 * Idempotent: reapplying an event id is a no-op. Each applied event is audited
 * with actor "indexer" and emits the same webhook events the API routes emit,
 * so downstream subscriptions see on-chain-driven state changes identically.
 *
 * Event mapping (see src/indexer/decode.js EVENT_TYPE_MAP):
 *   funded                  — one investor contribution; records it via store.fund()
 *   funding_target_reached  — invoice has reached its funding target (status already
 *                             flipped by store.fund() when the last contribution arrived)
 *   settled                 — invoice settled; flip to settled, emit invoice.settled
 *   refunded                — refund issued; flip to cancelled, emit invoice.cancelled
 *   funding_cancelled       — funding cancelled; flip to cancelled, emit invoice.cancelled
 *
 * @module services/chain-sync
 */

const defaultAuditLog = require('../audit/audit-log');
const defaultEmitter = require('../webhooks/emitter');
const defaultData = require('../data/store');
const defaultContributions = require('../data/contributions');

/** Process-lifetime set of event ids already applied. */
const appliedEventIds = new Set();

/**
 * Returns the first present, non-empty field from `names` on `obj`.
 *
 * @param {object|null|undefined} obj
 * @param {string[]} names
 * @returns {unknown}
 */
function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') { return undefined; }
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== '') { return v; }
  }
  return undefined;
}

/**
 * @param {object[]} events decoded events (any order)
 * @param {object} [opts]
 * @param {object} [opts.data]          invoice store (default: ../data/store)
 * @param {object} [opts.contributions] contributions store (default: ../data/contributions)
 * @param {object} [opts.audit]         audit log (default: ../audit/audit-log.auditLog)
 * @param {object} [opts.emitter]       webhook emitter (default: ../webhooks/emitter)
 * @param {Set<string>} [opts.appliedIds] applied-id set (default: module singleton)
 * @returns {{applied:number, ignored:number, byType:object, ignoredReasons:object}}
 */
function applyEvents(events, opts = {}) {
  const data = opts.data || defaultData;
  const contribs = opts.contributions || defaultContributions;
  const auditLog = opts.audit || defaultAuditLog.auditLog;
  const em = opts.emitter || defaultEmitter;
  const appliedIds = opts.appliedIds || appliedEventIds;

  const summary = { applied: 0, ignored: 0, byType: {}, ignoredReasons: {} };
  const bump = (k) => { summary.byType[k] = (summary.byType[k] || 0) + 1; };
  const bumpIgnore = (k) => { summary.ignoredReasons[k] = (summary.ignoredReasons[k] || 0) + 1; };

  const sorted = [...events].sort((a, b) => {
    const la = Number(a.ledger ?? 0); const lb = Number(b.ledger ?? 0);
    if (la !== lb) { return la - lb; }
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  for (const evt of sorted) {
    if (!evt || !evt.id || appliedIds.has(evt.id)) {
      summary.ignored += 1; bumpIgnore('duplicate'); continue;
    }
    if (!evt.contractId) {
      summary.ignored += 1; bumpIgnore('noContractId'); continue;
    }

    const invoice = data.list().find((inv) => inv.escrowContractId === evt.contractId);
    if (!invoice) {
      summary.ignored += 1; bumpIgnore('unknownContract'); continue;
    }

    const terminal = invoice.status === 'settled' || invoice.status === 'cancelled';
    let mutated = false;

    switch (evt.type) {
      case 'funded': {
        if (terminal) { summary.ignored += 1; bumpIgnore('stateConflict'); continue; }
        const investor = pickField(evt.data, ['investor', 'investor_address', 'from', 'sender']);
        const rawAmount = pickField(evt.data, ['amount', 'amount_minor', 'amountMinor', 'amount_i128', 'amt']);
        if (!investor || rawAmount === undefined) {
          summary.ignored += 1; bumpIgnore('malformedData'); continue;
        }
        try {
          data.fund(invoice, Number(rawAmount), String(investor));
        } catch (err) {
          summary.ignored += 1; bumpIgnore('fundRejected'); continue;
        }
        em.emit('invoice.funding_received', invoice);
        mutated = true;
        break;
      }
      case 'funding_target_reached': {
        // Status was flipped by store.fund() when the last contribution arrived.
        // Emit the webhook if the invoice is funded and we have not yet (the emitter
        // is idempotent per subscriber; duplicate deliveries are acceptable per
        // the existing webhook contract, and the applied-id set prevents re-firing
        // for the same event).
        if (invoice.status !== 'funded') {
          summary.ignored += 1; bumpIgnore('stateConflict'); continue;
        }
        em.emit('invoice.funded', invoice);
        mutated = true;
        break;
      }
      case 'settled': {
        if (invoice.status === 'settled') { summary.ignored += 1; bumpIgnore('duplicate'); continue; }
        if (invoice.status === 'cancelled') { summary.ignored += 1; bumpIgnore('stateConflict'); continue; }
        data.settle(invoice);
        em.emit('invoice.settled', invoice);
        mutated = true;
        break;
      }
      case 'refunded':
      case 'funding_cancelled': {
        if (invoice.status === 'cancelled') { summary.ignored += 1; bumpIgnore('duplicate'); continue; }
        if (invoice.status === 'settled') { summary.ignored += 1; bumpIgnore('stateConflict'); continue; }
        data.cancel(invoice);
        em.emit('invoice.cancelled', invoice);
        mutated = true;
        break;
      }
      default: {
        summary.ignored += 1; bumpIgnore('unknownType:' + evt.type); continue;
      }
    }

    if (mutated) {
      try {
        if (auditLog && typeof auditLog.append === 'function') {
          auditLog.append({
            action: 'invoice.chain_sync',
            resourceType: 'invoice',
            resourceId: invoice.id,
            actor: 'indexer',
            outcome: 'success',
            statusCode: 200,
            metadata: { eventId: evt.id, eventType: evt.type, ledger: evt.ledger, txHash: evt.txHash },
          });
        }
      } catch (err) {
        // Audit failures must not break sync
      }
      appliedIds.add(evt.id);
      summary.applied += 1;
      bump(evt.type);
    }
  }

  return summary;
}

/** @returns {void} clears the applied-event-id set (tests only) */
function resetAppliedIdsForTests() { appliedEventIds.clear(); }

module.exports = { applyEvents, resetAppliedIdsForTests, _appliedIds: appliedEventIds };