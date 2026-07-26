/**
 * Invoice-State DTO Boundary Tests
 *
 * Covers:
 *   - Request mappers: every body variant (valid, malformed, absent, wrong
 *     types, empty strings, extra keys) so undefined/optional fields always
 *     land in a well-known shape on the internal side of the boundary.
 *   - Response mappers: every DTO field including missing optional fields
 *     (reason, escrowId, fromState/toState, ipAddress) and the JSON
 *     serialisation footprint (undefined keys are absent, not null).
 *   - Round-trip mapping: a request body is mapped in, combined with a
 *     canonical service-layer transition result, then mapped back out — the
 *     serialised JSON matches the original route contract exactly.
 *   - Edge cases: null / undefined auditLog, empty allowedTransitions array,
 *     zero-length history, wrong-typed inputs falling back to defaults.
 *
 * @jest-environment node
 */

'use strict';

const {
  mapTransitionRequest,
  mapApproveRequest,
  mapLinkEscrowRequest,
  mapRejectRequest,
  toInvoiceStateResponse,
  toTransitionResponse,
  toLinkEscrowResponse,
  toHistoryEntryDto,
  toInvoiceHistoryResponse,
} = require('../src/dtos/invoiceStateDtos');

/* ------------------------------------------------------------------ */
/*  Shared fixtures                                                    */
/* ------------------------------------------------------------------ */

const TS = '2026-01-15T10:30:00.000Z';
const ACTOR = 'user-42';
const INVOICE_ID = 'inv-001';

/** Canonical service-layer transition result (used by transition / approve /
 *  reject / link-escrow routes). */
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

/** JSON round-trip helper — mirrors what `res.json()` does. */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/*  Request mappers                                                    */
/* ------------------------------------------------------------------ */
describe('Request mappers', () => {
  describe('mapTransitionRequest', () => {
    it('extracts targetState and reason from a complete body', () => {
      const out = mapTransitionRequest({
        targetState: 'approved',
        reason: 'Looks good',
      });
      expect(out).toEqual({ targetState: 'approved', reason: 'Looks good' });
    });

    it('leaves reason undefined when absent', () => {
      const out = mapTransitionRequest({ targetState: 'rejected' });
      expect(out).toEqual({ targetState: 'rejected', reason: undefined });
      expect('reason' in out).toBe(true);
    });

    it('leaves targetState undefined when absent', () => {
      const out = mapTransitionRequest({ reason: 'some reason' });
      expect(out.targetState).toBeUndefined();
    });

    it('coerces non-string reason to undefined', () => {
      expect(mapTransitionRequest({ targetState: 'approved', reason: 42 }).reason).toBeUndefined();
      expect(mapTransitionRequest({ targetState: 'approved', reason: null }).reason).toBeUndefined();
      expect(mapTransitionRequest({ targetState: 'approved', reason: {} }).reason).toBeUndefined();
    });

    it('treats null body identically to an empty object', () => {
      const outNull = mapTransitionRequest(null);
      const outUndef = mapTransitionRequest(undefined);
      const outEmpty = mapTransitionRequest({});
      expect(outNull).toEqual(outEmpty);
      expect(outUndef).toEqual(outEmpty);
      expect(outNull.targetState).toBeUndefined();
      expect(outNull.reason).toBeUndefined();
    });

    it('treats primitive / array bodies as empty', () => {
      expect(mapTransitionRequest('string-body')).toEqual({
        targetState: undefined,
        reason: undefined,
      });
      expect(mapTransitionRequest([1, 2, 3])).toEqual({
        targetState: undefined,
        reason: undefined,
      });
    });

    it('ignores extra keys (defensive against prototype pollution)', () => {
      const out = mapTransitionRequest({
        targetState: 'approved',
        reason: 'ok',
        __proto__: { polluted: true },
        constructor: 'oops',
        unexpected: 'field',
      });
      expect(Object.keys(out)).toEqual(['targetState', 'reason']);
      expect(out).toEqual({ targetState: 'approved', reason: 'ok' });
    });
  });

  describe('mapApproveRequest', () => {
    it('returns reason from body when provided', () => {
      expect(mapApproveRequest({ reason: 'All checks passed' })).toEqual({
        reason: 'All checks passed',
      });
    });

    it('returns undefined reason when absent or non-string', () => {
      expect(mapApproveRequest({}).reason).toBeUndefined();
      expect(mapApproveRequest({ reason: true }).reason).toBeUndefined();
      expect(mapApproveRequest(null).reason).toBeUndefined();
    });
  });

  describe('mapLinkEscrowRequest', () => {
    it('extracts both escrowId and reason from complete body', () => {
      expect(
        mapLinkEscrowRequest({ escrowId: 'esc-999', reason: 'Linked' }),
      ).toEqual({ escrowId: 'esc-999', reason: 'Linked' });
    });

    it('defaults escrowId to null when missing / non-string', () => {
      expect(mapLinkEscrowRequest({}).escrowId).toBeNull();
      expect(mapLinkEscrowRequest({ escrowId: 123 }).escrowId).toBeNull();
      expect(mapLinkEscrowRequest({ escrowId: null }).escrowId).toBeNull();
    });

    it('preserves explicitly null escrowId (client sends none)', () => {
      const out = mapLinkEscrowRequest({ reason: 'No escrow yet' });
      expect(out.escrowId).toBeNull();
      expect(out.reason).toBe('No escrow yet');
    });
  });

  describe('mapRejectRequest', () => {
    it('returns reason when string', () => {
      expect(mapRejectRequest({ reason: 'Missing docs' })).toEqual({
        reason: 'Missing docs',
      });
    });

    it('returns undefined reason when non-string / absent', () => {
      expect(mapRejectRequest({}).reason).toBeUndefined();
      expect(mapRejectRequest({ reason: ['not', 'a', 'string'] }).reason).toBeUndefined();
      expect(mapRejectRequest(undefined).reason).toBeUndefined();
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Response mappers                                                   */
/* ------------------------------------------------------------------ */
describe('Response mappers', () => {
  describe('toInvoiceStateResponse', () => {
    it('builds non-terminal state DTO with all allowed transitions', () => {
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: ['approved', 'rejected', 'cancelled'],
      });
      expect(dto).toEqual({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: ['approved', 'rejected', 'cancelled'],
        isTerminal: false,
      });
    });

    it('sets isTerminal=true when allowedTransitions is empty', () => {
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'linked_escrow',
        allowedTransitions: [],
      });
      expect(dto.isTerminal).toBe(true);
      expect(dto.allowedTransitions).toEqual([]);
    });

    it('guards against non-array allowedTransitions (defensive)', () => {
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        allowedTransitions: null,
      });
      expect(dto.allowedTransitions).toEqual([]);
      expect(dto.isTerminal).toBe(false);

      const dto2 = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'approved',
        allowedTransitions: 'not-an-array',
      });
      expect(Array.isArray(dto2.allowedTransitions)).toBe(true);
    });

    it('returns a fresh array copy (caller mutation cannot poison mapper)', () => {
      const allowed = ['approved'];
      const dto = toInvoiceStateResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        allowedTransitions: allowed,
      });
      dto.allowedTransitions.push('rejected');
      expect(allowed).toEqual(['approved']);
    });
  });

  describe('toTransitionResponse', () => {
    it('builds DTO with reason echoed back when supplied', () => {
      const result = makeServiceResult();
      const dto = toTransitionResponse({
        invoiceId: INVOICE_ID,
        result,
        reason: 'Looks good to me',
      });
      expect(dto).toEqual({
        invoiceId: INVOICE_ID,
        previousState: 'pending',
        currentState: 'approved',
        transitionedAt: TS,
        transitionedBy: ACTOR,
        reason: 'Looks good to me',
        auditLogId: 'audit-abc-123',
      });
    });

    it('omits reason entirely when not supplied (JSON footprint)', () => {
      const dto = toTransitionResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult(),
      });
      expect('reason' in dto).toBe(false);
      expect(jsonRoundTrip(dto)).not.toHaveProperty('reason');
    });

    it('omits reason when explicitly undefined / null', () => {
      const dto1 = toTransitionResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult(),
        reason: undefined,
      });
      const dto2 = toTransitionResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult(),
        reason: null,
      });
      expect('reason' in dto1).toBe(false);
      expect('reason' in dto2).toBe(false);
    });

    it('handles missing / malformed auditLog defensively', () => {
      const noAudit = makeServiceResult({ auditLog: null });
      const dto = toTransitionResponse({ invoiceId: INVOICE_ID, result: noAudit });
      expect(dto.auditLogId).toBe('');

      const emptyAudit = makeServiceResult({ auditLog: {} });
      const dto2 = toTransitionResponse({ invoiceId: INVOICE_ID, result: emptyAudit });
      expect(dto2.auditLogId).toBe('');
    });
  });

  describe('toLinkEscrowResponse', () => {
    it('includes escrowId when provided as string', () => {
      const dto = toLinkEscrowResponse({
        invoiceId: INVOICE_ID,
        result: makeServiceResult({ newState: 'linked_escrow', previousState: 'approved' }),
        escrowId: 'esc-abc',
      });
      expect(dto).toEqual({
        invoiceId: INVOICE_ID,
        previousState: 'approved',
        currentState: 'linked_escrow',
        escrowId: 'esc-abc',
        transitionedAt: TS,
        transitionedBy: ACTOR,
        auditLogId: 'audit-abc-123',
      });
    });

    it('coerces non-string escrowId to null (undefined / number / object)', () => {
      const base = {
        invoiceId: INVOICE_ID,
        result: makeServiceResult({ newState: 'linked_escrow' }),
      };
      expect(toLinkEscrowResponse({ ...base, escrowId: undefined }).escrowId).toBeNull();
      expect(toLinkEscrowResponse({ ...base, escrowId: 1234 }).escrowId).toBeNull();
      expect(toLinkEscrowResponse({ ...base, escrowId: {} }).escrowId).toBeNull();
    });
  });

  describe('toHistoryEntryDto', () => {
    it('maps a full audit-log record with every optional field present', () => {
      const rawLog = {
        id: 'audit-1',
        timestamp: TS,
        actor: ACTOR,
        changes: { before: { state: 'pending' }, after: { state: 'approved' } },
        metadata: { reason: 'Approved by finance' },
        ipAddress: '10.0.0.1',
      };
      expect(toHistoryEntryDto(rawLog)).toEqual({
        id: 'audit-1',
        timestamp: TS,
        actor: ACTOR,
        fromState: 'pending',
        toState: 'approved',
        reason: 'Approved by finance',
        ipAddress: '10.0.0.1',
      });
    });

    it('omits optional fields when the raw log has no changes / metadata / ip', () => {
      const minimalLog = { id: 'audit-2', timestamp: TS, actor: ACTOR };
      const dto = toHistoryEntryDto(minimalLog);
      expect(dto).toEqual({ id: 'audit-2', timestamp: TS, actor: ACTOR });
      expect('fromState' in dto).toBe(false);
      expect('toState' in dto).toBe(false);
      expect('reason' in dto).toBe(false);
      expect('ipAddress' in dto).toBe(false);
    });

    it('handles partial changes (before without after, and vice versa)', () => {
      const beforeOnly = {
        id: 'a',
        timestamp: TS,
        actor: ACTOR,
        changes: { before: { state: 'pending' } },
      };
      expect(toHistoryEntryDto(beforeOnly)).toEqual({
        id: 'a',
        timestamp: TS,
        actor: ACTOR,
        fromState: 'pending',
      });

      const afterOnly = {
        id: 'b',
        timestamp: TS,
        actor: ACTOR,
        changes: { after: { state: 'rejected' } },
        metadata: {},
      };
      expect(toHistoryEntryDto(afterOnly)).toEqual({
        id: 'b',
        timestamp: TS,
        actor: ACTOR,
        toState: 'rejected',
      });
    });

    it('treats null metadata reason the same as absent (JSON safety)', () => {
      const log = {
        id: 'c',
        timestamp: TS,
        actor: ACTOR,
        changes: {},
        metadata: { reason: undefined },
        ipAddress: undefined,
      };
      const dto = toHistoryEntryDto(log);
      expect('reason' in dto).toBe(false);
      expect('ipAddress' in dto).toBe(false);
    });
  });

  describe('toInvoiceHistoryResponse', () => {
    it('builds response with transitions and total count', () => {
      const transitions = [
        {
          id: 'h1',
          timestamp: TS,
          actor: ACTOR,
          fromState: 'approved',
          toState: 'linked_escrow',
        },
        {
          id: 'h0',
          timestamp: TS,
          actor: ACTOR,
          fromState: 'pending',
          toState: 'approved',
        },
      ];
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'linked_escrow',
        transitions,
      });
      expect(dto).toEqual({
        invoiceId: INVOICE_ID,
        currentState: 'linked_escrow',
        transitions,
        totalTransitions: 2,
      });
      // Identity preserved — entries are not mutated or re-cloned.
      expect(dto.transitions[0]).toBe(transitions[0]);
    });

    it('handles empty transitions list defensively', () => {
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        transitions: [],
      });
      expect(dto.totalTransitions).toBe(0);
      expect(dto.transitions).toEqual([]);
    });

    it('guards against non-array transitions input', () => {
      const dto = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        transitions: null,
      });
      expect(dto.transitions).toEqual([]);
      expect(dto.totalTransitions).toBe(0);

      const dto2 = toInvoiceHistoryResponse({
        invoiceId: INVOICE_ID,
        currentState: 'pending',
        transitions: 'whoops',
      });
      expect(Array.isArray(dto2.transitions)).toBe(true);
      expect(dto2.totalTransitions).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Round-trip mapping: request → service → response                  */
/* ------------------------------------------------------------------ */
describe('Boundary round-trip mapping', () => {
  function simulateTransitionRoute(requestBody) {
    // 1. Map inbound body (defensive coercion at the boundary).
    const req = mapTransitionRequest(requestBody);
    // 2. "Service" layer combines the request into a transition result.  The
    //    DTOs are deliberately not coupled — the internal service shape is
    //    free to evolve and the mapper isolates callers from that change.
    const serviceResult = makeServiceResult({
      previousState: 'pending',
      newState: req.targetState || 'approved',
      transitionedAt: TS,
      transitionedBy: ACTOR,
    });
    // 3. Map outbound DTO and then JSON-serialise just like Express would.
    const response = toTransitionResponse({
      invoiceId: INVOICE_ID,
      result: serviceResult,
      reason: req.reason,
    });
    return { mappedRequest: req, response, json: jsonRoundTrip(response) };
  }

  it('full body → service → response preserves user-visible fields exactly', () => {
    const rt = simulateTransitionRoute({
      targetState: 'approved',
      reason: 'All checks passed',
    });
    expect(rt.mappedRequest).toEqual({
      targetState: 'approved',
      reason: 'All checks passed',
    });
    expect(rt.json).toEqual({
      invoiceId: INVOICE_ID,
      previousState: 'pending',
      currentState: 'approved',
      transitionedAt: TS,
      transitionedBy: ACTOR,
      reason: 'All checks passed',
      auditLogId: 'audit-abc-123',
    });
  });

  it('missing optional reason does not appear in the JSON envelope', () => {
    const rt = simulateTransitionRoute({ targetState: 'approved' });
    expect(rt.mappedRequest.reason).toBeUndefined();
    expect(rt.json).not.toHaveProperty('reason');
    expect(rt.json).toEqual({
      invoiceId: INVOICE_ID,
      previousState: 'pending',
      currentState: 'approved',
      transitionedAt: TS,
      transitionedBy: ACTOR,
      auditLogId: 'audit-abc-123',
    });
  });

  it('link-escrow route round-trips escrowId=null when user omitted it', () => {
    const linkReq = mapLinkEscrowRequest({ reason: 'Linked by admin' });
    expect(linkReq.escrowId).toBeNull();

    const serviceResult = makeServiceResult({
      previousState: 'approved',
      newState: 'linked_escrow',
    });
    const response = toLinkEscrowResponse({
      invoiceId: INVOICE_ID,
      result: serviceResult,
      escrowId: linkReq.escrowId,
    });
    // Escrow ID is an explicit null on the wire (matches route contract).
    expect(jsonRoundTrip(response).escrowId).toBeNull();
    expect(response.escrowId).toBeNull();
  });

  it('reject route echoes non-empty reason through the response envelope', () => {
    const body = { reason: 'Failed KYC / sanctions check' };
    const { reason } = mapRejectRequest(body);
    const result = makeServiceResult({
      previousState: 'pending',
      newState: 'rejected',
    });
    const response = toTransitionResponse({
      invoiceId: INVOICE_ID,
      result,
      reason,
    });
    expect(jsonRoundTrip(response).reason).toBe('Failed KYC / sanctions check');
  });

  it('state + history routes produce well-known JSON shapes end-to-end', () => {
    const state = toInvoiceStateResponse({
      invoiceId: INVOICE_ID,
      currentState: 'approved',
      allowedTransitions: ['linked_escrow', 'cancelled'],
    });
    const history = toInvoiceHistoryResponse({
      invoiceId: INVOICE_ID,
      currentState: 'approved',
      transitions: [
        {
          id: 'h0',
          timestamp: TS,
          actor: ACTOR,
          fromState: 'pending',
          toState: 'approved',
          reason: 'First pass',
          ipAddress: '127.0.0.1',
        },
      ],
    });
    expect(jsonRoundTrip(state)).toEqual({
      invoiceId: INVOICE_ID,
      currentState: 'approved',
      allowedTransitions: ['linked_escrow', 'cancelled'],
      isTerminal: false,
    });
    expect(jsonRoundTrip(history)).toEqual({
      invoiceId: INVOICE_ID,
      currentState: 'approved',
      totalTransitions: 1,
      transitions: [
        {
          id: 'h0',
          timestamp: TS,
          actor: ACTOR,
          fromState: 'pending',
          toState: 'approved',
          reason: 'First pass',
          ipAddress: '127.0.0.1',
        },
      ],
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Mapper determinism / referential-integrity smoke tests            */
/* ------------------------------------------------------------------ */
describe('Mapper determinism', () => {
  it('two calls with identical inputs produce deeply-equal but independent objects', () => {
    const input = {
      invoiceId: INVOICE_ID,
      currentState: 'pending',
      allowedTransitions: ['approved', 'rejected'],
    };
    const a = toInvoiceStateResponse(input);
    const b = toInvoiceStateResponse(input);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.allowedTransitions.push('cancelled');
    expect(b.allowedTransitions).toEqual(['approved', 'rejected']);
  });

  it('mappers accept frozen inputs without throwing (no defensive mutation)', () => {
    const frozenResult = Object.freeze(makeServiceResult());
    expect(() =>
      toTransitionResponse({ invoiceId: INVOICE_ID, result: frozenResult }),
    ).not.toThrow();
    expect(() =>
      toLinkEscrowResponse({
        invoiceId: INVOICE_ID,
        result: frozenResult,
        escrowId: 'esc-1',
      }),
    ).not.toThrow();
  });
});
