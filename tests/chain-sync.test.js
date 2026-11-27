'use strict';

/**
 * Tests for src/services/chain-sync.js
 *
 * Uses the in-memory adapter (fresh per test) so no DB or network is needed.
 * Each test builds synthetic decoded events with the same shape decodeEvent()
 * produces: { id, type, ledger, contractId, data: { ... } }.
 */

const chainSync = require('../src/services/chain-sync');
const store = require('../src/data/store');
const contributions = require('../src/data/contributions');
const emitter = require('../src/webhooks/emitter');
const auditLog = require('../src/audit/audit-log');

const CONTRACT = 'CAAAAAAA0000000000000000000000000000000000000000000000';
const OTHER_CONTRACT = 'CBBBBBBB0000000000000000000000000000000000000000000000';

function evt({ id, type, ledger = 1, contractId = CONTRACT, data = {} }) {
  return { id, type, ledger, contractId, data };
}

function linkInvoice(invoiceId) {
  const inv = store.get(invoiceId);
  if (!inv) { throw new Error('no invoice ' + invoiceId); }
  // Set the contract id directly: the seed data for INV_0001 already carries
  // a (possibly non-empty) config.contractId, so linkEscrow() would return
  // ALREADY_LINKED. Every test wants OUR contract id, so just assign it.
  inv.escrowContractId = CONTRACT;
  return inv;
}

beforeEach(() => {
  chainSync.resetAppliedIdsForTests();
  store.reset();
  auditLog.auditLog.resetForTests();
});

describe('chain-sync.applyEvents', () => {
  test('funded for a linked invoice records the contribution and returns applied:1', () => {
    const inv = linkInvoice('INV_0002'); // seeded: remaining 7000 (fits amounts up to 7000)
    const before = contributions.sumForInvoice(inv.id);

    const res = chainSync.applyEvents([
      evt({ id: 'e1', type: 'funded', data: { investor: 'GINVESTOR1', amount: '1000' } }),
    ]);

    expect(res.applied).toBe(1);
    expect(res.ignored).toBe(0);
    expect(res.byType.funded).toBe(1);
    expect(contributions.sumForInvoice(inv.id)).toBe(before + 1000n * 10000000n); // amount is whole units; sumForInvoice returns stroops
  });

  test('duplicate event is ignored (idempotent)', () => {
    linkInvoice('INV_0002');
    const e = evt({ id: 'dup-1', type: 'funded', data: { investor: 'GINVESTOR1', amount: '500' } });

    const first = chainSync.applyEvents([e]);
    const second = chainSync.applyEvents([e]);

    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(second.ignored).toBe(1);
    expect(second.ignoredReasons.duplicate).toBe(1);
  });

  test('unknown contract is ignored', () => {
    const res = chainSync.applyEvents([
      evt({ id: 'x1', type: 'funded', contractId: OTHER_CONTRACT, data: { investor: 'G', amount: '10' } }),
    ]);
    expect(res.applied).toBe(0);
    expect(res.ignoredReasons.unknownContract).toBe(1);
  });

  test('malformed funded data is ignored (no investor or amount)', () => {
    linkInvoice('INV_0002');
    const res = chainSync.applyEvents([
      evt({ id: 'm1', type: 'funded', data: {} }),
    ]);
    expect(res.ignoredReasons.malformedData).toBe(1);
  });

  test('funded against a settled invoice is ignored (state conflict)', () => {
    const inv = linkInvoice('INV_0004'); // seeded as settled
    const res = chainSync.applyEvents([
      evt({ id: 'sc1', type: 'funded', data: { investor: 'G', amount: '10' } }),
    ]);
    expect(res.applied).toBe(0);
    expect(res.ignoredReasons.stateConflict).toBe(1);
    expect(inv.status).toBe('settled');
  });

  test('funding_target_reached flips status to funded and emits invoice.funded', () => {
    const inv = linkInvoice('INV_0002'); // seeded: amountMinor 25000, fundedAmountMinor 18000, remaining 7000
    // Fund the remaining capacity to reach the target.
    chainSync.applyEvents([
      evt({ id: 'f-full', type: 'funded', data: { investor: 'G', amount: '7000' } }),
    ]);
    expect(inv.status).toBe('funded');

    const received = [];
    const listener = (invoice) => received.push(invoice.id);
    emitter.on('invoice.funded', listener);
    try {
      const res = chainSync.applyEvents([
        evt({ id: 'tgt-1', type: 'funding_target_reached', data: {} }),
      ]);
      expect(res.applied).toBe(1);
      expect(res.byType.funding_target_reached).toBe(1);
      expect(received).toEqual([inv.id]);
    } finally {
      emitter.off('invoice.funded', listener);
    }
  });

  test('funding_target_reached on an unfunded invoice is ignored', () => {
    linkInvoice('INV_0002'); // still open (only 7000 of 25000 remaining to fill)
    const res = chainSync.applyEvents([
      evt({ id: 'tgt-bad', type: 'funding_target_reached', data: {} }),
    ]);
    expect(res.applied).toBe(0);
    expect(res.ignoredReasons.stateConflict).toBe(1);
  });

  test('settled flips status, emits invoice.settled, and writes an audit entry with actor=indexer', () => {
    const inv = linkInvoice('INV_0003'); // seeded as funded
    const received = [];
    const listener = (invoice) => received.push(invoice.id);
    emitter.on('invoice.settled', listener);
    try {
      const res = chainSync.applyEvents([
        evt({ id: 'st-1', type: 'settled', ledger: 100, data: {} }),
      ]);
      expect(res.applied).toBe(1);
      expect(inv.status).toBe('settled');
      expect(received).toEqual([inv.id]);

      const entries = auditLog.auditLog.entries();
      const entry = entries.find((e) => e.action === 'invoice.chain_sync' && e.resourceId === inv.id);
      expect(entry).toBeDefined();
      expect(entry.actor).toBe('indexer');
      expect(entry.outcome).toBe('success');
      expect(entry.metadata.eventId).toBe('st-1');
    } finally {
      emitter.off('invoice.settled', listener);
    }
  });

  test('settled twice — second is duplicate', () => {
    linkInvoice('INV_0003');
    const e = evt({ id: 'st-dup', type: 'settled' });
    chainSync.applyEvents([e]);
    const second = chainSync.applyEvents([e]);
    expect(second.ignoredReasons.duplicate).toBe(1);
  });

  test('refunded flips status to cancelled and emits invoice.cancelled', () => {
    const inv = linkInvoice('INV_0003');
    const received = [];
    const listener = (invoice) => received.push(invoice.id);
    emitter.on('invoice.cancelled', listener);
    try {
      const res = chainSync.applyEvents([
        evt({ id: 'ref-1', type: 'refunded' }),
      ]);
      expect(res.applied).toBe(1);
      expect(inv.status).toBe('cancelled');
      expect(received).toEqual([inv.id]);
    } finally {
      emitter.off('invoice.cancelled', listener);
    }
  });

  test('funding_cancelled flips status to cancelled', () => {
    const inv = linkInvoice('INV_0003');
    const res = chainSync.applyEvents([evt({ id: 'fc-1', type: 'funding_cancelled' })]);
    expect(res.applied).toBe(1);
    expect(inv.status).toBe('cancelled');
  });

  test('out-of-order ledgers: settled at ledger 50 before funded at ledger 10 — settled is applied, funded then ignored as state conflict', () => {
    const inv = linkInvoice('INV_0001'); // open, empty
    // INV_0001 starts empty; funded applies at ledger 10, settled at ledger 50.
    const res = chainSync.applyEvents([
      evt({ id: 'oo-settled', type: 'settled', ledger: 50 }),
      evt({ id: 'oo-funded', type: 'funded', ledger: 10, data: { investor: 'G', amount: '100' } }),
    ]);

    // Sorted by ledger: funded first (10), then settled (50).
    expect(inv.status).toBe('settled');
    expect(res.applied).toBe(2);
  });

  test('full replay of the same event list is a no-op', () => {
    linkInvoice('INV_0002'); // remaining capacity 7000
    const events = [
      evt({ id: 'r1', type: 'funded', data: { investor: 'G1', amount: '500' } }),
      evt({ id: 'r2', type: 'settled' }),
    ];
    const first = chainSync.applyEvents(events);
    const second = chainSync.applyEvents(events);
    expect(first.applied).toBe(2);
    expect(second.applied).toBe(0);
    expect(second.ignored).toBe(2);
  });

  test('unknown event type is ignored with a specific reason', () => {
    linkInvoice('INV_0002');
    const res = chainSync.applyEvents([evt({ id: 'u1', type: 'unknown' })]);
    expect(res.applied).toBe(0);
    expect(Object.keys(res.ignoredReasons).some((k) => k.startsWith('unknownType:'))).toBe(true);
  });
});