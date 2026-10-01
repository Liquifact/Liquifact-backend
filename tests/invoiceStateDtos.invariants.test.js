/**
 * Invoice-state DTO state-invariant tests (issue #1363).
 *
 * The existing `invoiceStateDtos.test.js` suite pins the *shape* of every
 * mapper's output. This suite pins what happens to that output afterwards,
 * which is where the data-integrity invariants live —
 *
 *   - a response DTO cannot be mutated once it has been classified,
 *   - `totalTransitions` can never drift away from the list it counts, even
 *     when the caller keeps mutating the array it passed in,
 *   - `isTerminal` keeps its documented fail-safe meaning for malformed input,
 *   - copying is shallow, so entry identity and the JSON footprint the routes
 *     depend on are unchanged,
 *   - the one deliberate exception (`allowedTransitions`) stays usable.
 *
 * @jest-environment node
 */

'use strict';

const {
  mapTransitionRequest,
  toInvoiceStateResponse,
  toTransitionResponse,
  toLinkEscrowResponse,
  toHistoryEntryDto,
  toInvoiceHistoryResponse,
} = require('../src/dtos/invoiceStateDtos');

const TS = '2026-01-15T10:30:00.000Z';
const ACTOR = 'user-42';
const INVOICE_ID = 'inv-001';

function makeServiceResult(overrides = {}) {
  return Object.assign(
    {
      success: true,
      previousState: 'pending',
      newState: 'approved',
      auditLog: { id: 'audit-abc-123', timestamp: TS },
      transitionedAt: TS,
      transitionedBy: ACTOR,
    },
    overrides,
  );
}

function makeHistoryEntry(id) {
  return {
    id,
    timestamp: TS,
    actor: ACTOR,
    fromState: 'pending',
    toState: 'approved',
  };
}

describe('invoice-state DTO state invariants', () => {
  describe('frozen response DTOs', () => {
    it('freezes the state-query DTO', () => {
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: ['approved', 'rejected'],
      });

      expect(Object.isFrozen(dto)).toBe(true);
    });

    it('freezes the transition DTO', () => {
      const dto = toTransitionResponse({ invoiceId: INVOICE_ID, result: makeServiceResult() });

      expect(Object.isFrozen(dto)).toBe(true);
    });

    it('freezes the link-escrow DTO', () => {
      const dto = toLinkEscrowResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult({ newState: 'linked_escrow' }),
        escrowId: 'esc-1',
      });

      expect(Object.isFrozen(dto)).toBe(true);
    });

    it('freezes a history entry DTO', () => {
      const entry = toHistoryEntryDto({ id: 'a', timestamp: TS, actor: ACTOR });

      expect(Object.isFrozen(entry)).toBe(true);
    });

    it('freezes the history response DTO', () => {
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: [makeHistoryEntry('h1')],
      });

      expect(Object.isFrozen(dto)).toBe(true);
    });

    it('refuses to let a classified transition be rewritten', () => {
      // The response has already been classified; rewriting the state here
      // would desync it from the audit log the transition actually wrote.
      const dto = toTransitionResponse({ invoiceId: INVOICE_ID, result: makeServiceResult() });

      expect(() => {
        dto.currentState = 'rejected';
      }).toThrow(TypeError);
      expect(dto.currentState).toBe('approved');
    });

    it('refuses to rewrite previousState, invoiceId, or a history entry', () => {
      const transition = toTransitionResponse({ invoiceId: INVOICE_ID, result: makeServiceResult() });
      const entry = toHistoryEntryDto({ id: 'a', timestamp: TS, actor: ACTOR });

      expect(() => {
        transition.previousState = 'rejected';
      }).toThrow(TypeError);
      expect(() => {
        transition.invoiceId = 'other';
      }).toThrow(TypeError);
      expect(() => {
        entry.actor = 'someone-else';
      }).toThrow(TypeError);

      expect(transition.previousState).toBe('pending');
      expect(transition.invoiceId).toBe(INVOICE_ID);
      expect(entry.actor).toBe(ACTOR);
    });

    it('refuses to add new fields to a frozen DTO', () => {
      const dto = toLinkEscrowResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult({ newState: 'linked_escrow' }),
        escrowId: 'esc-1',
      });

      expect(() => {
        dto.injected = true;
      }).toThrow(TypeError);
      expect(dto.injected).toBeUndefined();
    });
  });

  describe('totalTransitions cannot drift from transitions', () => {
    it('reports a count that matches the list it was built with', () => {
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: [makeHistoryEntry('h1'), makeHistoryEntry('h2'), makeHistoryEntry('h3')],
      });

      expect(dto.totalTransitions).toBe(3);
      expect(dto.transitions).toHaveLength(dto.totalTransitions);
    });

    it('ignores later mutation of the caller-supplied array', () => {
      // Regression: the DTO used to expose the caller's array by reference, so
      // appending here produced a response advertising one count alongside a
      // different number of entries.
      const callerArray = [makeHistoryEntry('h1'), makeHistoryEntry('h2')];
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: callerArray,
      });

      callerArray.push(makeHistoryEntry('h3'));
      callerArray.splice(0, 1);

      expect(dto.transitions).toHaveLength(2);
      expect(dto.totalTransitions).toBe(2);
      expect(dto.transitions.map((entry) => entry.id)).toEqual(['h1', 'h2']);
    });

    it('does not expose the caller array itself', () => {
      const callerArray = [makeHistoryEntry('h1')];
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: callerArray,
      });

      expect(dto.transitions).not.toBe(callerArray);
      expect(dto.transitions).toEqual(callerArray);
    });

    it('refuses to grow or shrink its own transition list', () => {
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: [makeHistoryEntry('h1')],
      });

      expect(() => dto.transitions.push(makeHistoryEntry('h2'))).toThrow(TypeError);
      expect(() => dto.transitions.splice(0, 1)).toThrow(TypeError);
      expect(dto.transitions).toHaveLength(1);
      expect(dto.totalTransitions).toBe(1);
    });

    it('keeps entry identity (the copy is shallow, entries are not cloned)', () => {
      const entry = makeHistoryEntry('h1');
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: [entry],
      });

      expect(dto.transitions[0]).toBe(entry);
    });

    it('does not freeze caller-owned entries as a side effect', () => {
      const entry = makeHistoryEntry('h1');
      const callerArray = [entry];

      toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: callerArray,
      });

      expect(Object.isFrozen(entry)).toBe(false);
      expect(Object.isFrozen(callerArray)).toBe(false);
    });
  });

  describe('isTerminal fail-safe semantics', () => {
    it('marks an empty transition list as terminal', () => {
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'linked_escrow',
        allowedTransitions: [],
      });

      expect(dto.isTerminal).toBe(true);
    });

    it('marks a populated transition list as non-terminal', () => {
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: ['approved'],
      });

      expect(dto.isTerminal).toBe(false);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not-an-array'],
      ['a number', 7],
      ['an object', { approved: true }],
    ])('reports non-terminal for %s input, never terminal', (_label, allowedTransitions) => {
      // A malformed transition list must not be read as "no further
      // transitions exist", which would wrongly declare an invoice finished.
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        allowedTransitions,
      });

      expect(dto.allowedTransitions).toEqual([]);
      expect(dto.isTerminal).toBe(false);
    });

    it('snapshots isTerminal at mapping time', () => {
      // Documented limitation: `allowedTransitions` is intentionally a mutable
      // copy, so isTerminal reflects the state as mapped rather than tracking
      // later edits to that copy.
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: ['approved'],
      });
      const before = dto.isTerminal;

      dto.allowedTransitions.push('rejected');

      expect(before).toBe(false);
      expect(dto.isTerminal).toBe(false);
    });
  });

  describe('allowedTransitions stays a fresh, usable copy', () => {
    it('is not the caller array', () => {
      const callerArray = ['approved'];
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: callerArray,
      });

      expect(dto.allowedTransitions).not.toBe(callerArray);
      expect(dto.allowedTransitions).toEqual(callerArray);
    });

    it('can still be built on without poisoning the mapper input', () => {
      const callerArray = ['approved'];
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: callerArray,
      });

      expect(() => dto.allowedTransitions.push('rejected')).not.toThrow();
      expect(callerArray).toEqual(['approved']);
    });
  });

  describe('JSON footprint is unchanged by freezing', () => {
    it('serialises the transition DTO exactly as before', () => {
      const dto = toTransitionResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult(),
        reason: 'Looks good',
      });

      expect(JSON.parse(JSON.stringify(dto))).toEqual({
        invoiceId: INVOICE_ID,
        previousState: 'pending',
        currentState: 'approved',
        transitionedAt: TS,
        transitionedBy: ACTOR,
        auditLogId: 'audit-abc-123',
        reason: 'Looks good',
      });
    });

    it('still omits reason entirely when it was not supplied', () => {
      const dto = toTransitionResponse({ invoiceId: INVOICE_ID, result: makeServiceResult() });

      expect('reason' in dto).toBe(false);
      expect(JSON.parse(JSON.stringify(dto))).not.toHaveProperty('reason');
    });

    it('still omits an undefined escrowId from a history entry', () => {
      const dto = toHistoryEntryDto({ id: 'a', timestamp: TS, actor: ACTOR });

      expect('fromState' in dto).toBe(false);
      expect(Object.isFrozen(dto)).toBe(true);
    });
  });

  describe('determinism and isolation across calls', () => {
    it('returns deeply-equal but independent objects for identical input', () => {
      const args = {
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: [makeHistoryEntry('h1')],
      };

      const first = toInvoiceHistoryResponse(args);
      const second = toInvoiceHistoryResponse(args);

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first.transitions).not.toBe(second.transitions);
    });

    it('accepts frozen input without throwing', () => {
      const frozen = Object.freeze({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        transitions: Object.freeze([Object.freeze(makeHistoryEntry('h1'))]),
      });

      expect(() => toInvoiceHistoryResponse(frozen)).not.toThrow();
      expect(toInvoiceHistoryResponse(frozen).totalTransitions).toBe(1);
    });

    it('accepts a frozen service result', () => {
      const frozenResult = Object.freeze(makeServiceResult());

      expect(() =>
        toTransitionResponse({ invoiceId: INVOICE_ID, result: frozenResult }),
      ).not.toThrow();
      expect(() =>
        toLinkEscrowResponse({ invoiceId: INVOICE_ID, result: frozenResult, escrowId: 'esc-1' }),
      ).not.toThrow();
    });

    it('rejects a missing args object rather than inventing a response', () => {
      // These mappers take an internal args object, never raw user input, so a
      // missing argument is a programming error that should surface loudly.
      expect(() => toInvoiceStateResponse(undefined)).toThrow(TypeError);
      expect(() => toTransitionResponse(undefined)).toThrow(TypeError);
      expect(() => toLinkEscrowResponse(null)).toThrow(TypeError);
      expect(() => toInvoiceHistoryResponse(undefined)).toThrow(TypeError);
    });
  });

  describe('request mappers remain untouched by the response-side invariants', () => {
    it('still coerces a malformed body into a stable shape', () => {
      expect(mapTransitionRequest({ targetState: 'approved', reason: 42 })).toEqual({
        targetState: 'approved',
        reason: undefined,
      });
      expect(mapTransitionRequest(null)).toEqual({ targetState: undefined, reason: undefined });
    });
  });
});
