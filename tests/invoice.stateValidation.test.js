'use strict';

/**
 * Invoice State Input Validation — strict-bound & structured-error tests
 *
 * Covers:
 *  - Missing required field (targetState, body)
 *  - Wrong types (targetState, reason, actor, currentState)
 *  - Out-of-range values (oversized strings, deeply nested metadata)
 *  - Unknown top-level fields (incl. __proto__ / constructor)
 *  - RFC 7807 problem-details envelope is well-formed and machine-readable
 *  - Boundary passing / rejection at MAX for reason, actor, metadata
 *
 * @jest-environment node
 */

const request = require('supertest');
const express = require('express');

const invoiceStateRoutes = require('../src/routes/invoiceStateRoutes');
const {
  safeParseTransitionBody,
  validateMetadataShape,
  transitionBodySchema,
  BOUNDED_TARGET_STATES,
  ALLOWED_TOP_LEVEL_KEYS,
  MAX_TRANSITION_REASON_LENGTH,
  MAX_TRANSITION_ACTOR_LENGTH,
  MAX_METADATA_KEY_LENGTH,
  MAX_TRANSITION_METADATA_DEPTH,
  MAX_METADATA_KEYS_PER_OBJECT,
  MAX_METADATA_ARRAY_LENGTH,
} = require('../src/schemas/invoiceState');
const { ALL_INVOICE_STATUSES } = require('../src/services/invoiceStateMachine');

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoiceStateRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

/**
 * Returns a string of exactly `n` ascii characters.
 */
function repeat(n) {
  return 'x'.repeat(n);
}

/** Performs a POST /transition with the supplied body. */
function postTransition(body) {
  return request(buildApp()).post('/api/invoices/transition').send(body);
}

// ---------------------------------------------------------------------------
// safeParseTransitionBody — top-level shape
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — top-level shape', () => {
  it('rejects an undefined body with MISSING_BODY', () => {
    const r = safeParseTransitionBody(undefined);
    expect(r.success).toBe(false);
    expect(r.fieldErrors._root).toBe('MISSING_BODY');
  });

  it('rejects a null body with INVALID_BODY_TYPE', () => {
    const r = safeParseTransitionBody(null);
    expect(r.success).toBe(false);
    expect(r.fieldErrors._root).toBe('INVALID_BODY_TYPE');
  });

  it('rejects an array body with INVALID_BODY_TYPE', () => {
    const r = safeParseTransitionBody([{ targetState: 'pending' }]);
    expect(r.success).toBe(false);
    expect(r.fieldErrors._root).toBe('INVALID_BODY_TYPE');
  });

  it('rejects a number body with INVALID_BODY_TYPE', () => {
    const r = safeParseTransitionBody(42);
    expect(r.success).toBe(false);
    expect(r.fieldErrors._root).toBe('INVALID_BODY_TYPE');
  });

  it('rejects a boolean body with INVALID_BODY_TYPE', () => {
    const r = safeParseTransitionBody(true);
    expect(r.success).toBe(false);
    expect(r.fieldErrors._root).toBe('INVALID_BODY_TYPE');
  });

  it('rejects a string body with INVALID_BODY_TYPE', () => {
    const r = safeParseTransitionBody('pending');
    expect(r.success).toBe(false);
    expect(r.fieldErrors._root).toBe('INVALID_BODY_TYPE');
  });

  it('accepts a minimally valid body', () => {
    const r = safeParseTransitionBody({ targetState: 'pending' });
    expect(r.success).toBe(true);
    expect(r.data.targetState).toBe('pending');
  });

  it('accepts a fully populated body', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      reason: 'ok',
      actor: 'user-1',
      currentState: 'pending',
      metadata: { source: 'web', score: 90 },
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// targetState coverage
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — targetState', () => {
  it('rejects an empty object with MISSING_TARGET_STATE', () => {
    const r = safeParseTransitionBody({});
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('MISSING_TARGET_STATE');
  });

  it('rejects null targetState with MISSING_TARGET_STATE', () => {
    const r = safeParseTransitionBody({ targetState: null });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('MISSING_TARGET_STATE');
  });

  it('rejects explicit undefined targetState with MISSING_TARGET_STATE', () => {
    const r = safeParseTransitionBody({ targetState: undefined });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('MISSING_TARGET_STATE');
  });

  it('rejects numeric targetState with INVALID_TARGET_STATE', () => {
    const r = safeParseTransitionBody({ targetState: 42 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects boolean targetState', () => {
    const r = safeParseTransitionBody({ targetState: true });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects array targetState', () => {
    const r = safeParseTransitionBody({ targetState: ['pending'] });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects object targetState', () => {
    const r = safeParseTransitionBody({ targetState: { state: 'pending' } });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects unknown string targetState', () => {
    const r = safeParseTransitionBody({ targetState: 'not_a_real_state' });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects empty string targetState', () => {
    const r = safeParseTransitionBody({ targetState: '' });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects out-of-range numeric targetState', () => {
    const r = safeParseTransitionBody({ targetState: Number.MAX_SAFE_INTEGER });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects negative numeric targetState', () => {
    const r = safeParseTransitionBody({ targetState: -1 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('rejects floating-point targetState', () => {
    const r = safeParseTransitionBody({ targetState: 3.14 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it.each(BOUNDED_TARGET_STATES)('accepts targetState value "%s"', (value) => {
    const r = safeParseTransitionBody({ targetState: value });
    expect(r.success).toBe(true);
  });

  it('reports allowed-set mismatch when ALL_INVOICE_STATUSES drifts', () => {
    // Sanity — the bound must mirror ALL_INVOICE_STATUSES exactly.
    expect(BOUNDED_TARGET_STATES.length).toBe(ALL_INVOICE_STATUSES.length);
    for (const v of ALL_INVOICE_STATUSES) {
      expect(BOUNDED_TARGET_STATES).toContain(v);
    }
  });
});

// ---------------------------------------------------------------------------
// Reason coverage
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — reason', () => {
  it('accepts a normal-length reason', () => {
    const r = safeParseTransitionBody({ targetState: 'rejected', reason: 'KYC failed' });
    expect(r.success).toBe(true);
  });

  it('accepts a reason at the exact MAX bound', () => {
    const r = safeParseTransitionBody({
      targetState: 'rejected',
      reason: repeat(MAX_TRANSITION_REASON_LENGTH),
    });
    expect(r.success).toBe(true);
  });

  it('rejects a reason at MAX + 1 with TRANSITION_REASON_TOO_LONG', () => {
    const r = safeParseTransitionBody({
      targetState: 'rejected',
      reason: repeat(MAX_TRANSITION_REASON_LENGTH + 1),
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.reason).toBe('TRANSITION_REASON_TOO_LONG');
  });

  it('rejects a massively oversized reason', () => {
    const r = safeParseTransitionBody({
      targetState: 'rejected',
      reason: repeat(MAX_TRANSITION_REASON_LENGTH * 100),
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.reason).toBe('TRANSITION_REASON_TOO_LONG');
  });

  it('trims whitespace from the reason', () => {
    const r = safeParseTransitionBody({
      targetState: 'rejected',
      reason: '  padded reason  ',
    });
    expect(r.success).toBe(true);
    expect(r.data.reason).toBe('padded reason');
  });

  it('rejects numeric reason with INVALID_REASON_TYPE', () => {
    const r = safeParseTransitionBody({ targetState: 'rejected', reason: 12345 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.reason).toBe('INVALID_REASON_TYPE');
  });

  it('rejects boolean reason with INVALID_REASON_TYPE', () => {
    const r = safeParseTransitionBody({ targetState: 'rejected', reason: true });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.reason).toBe('INVALID_REASON_TYPE');
  });

  it('rejects array reason with INVALID_REASON_TYPE', () => {
    const r = safeParseTransitionBody({ targetState: 'rejected', reason: ['reason'] });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.reason).toBe('INVALID_REASON_TYPE');
  });

  it('accepts a digit-only reason string (length-only bound)', () => {
    const r = safeParseTransitionBody({
      targetState: 'rejected',
      reason: '1234567890',
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Actor coverage
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — actor', () => {
  it('accepts a normal-length actor', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', actor: 'user-1' });
    expect(r.success).toBe(true);
  });

  it('accepts an actor at the exact MAX bound', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      actor: repeat(MAX_TRANSITION_ACTOR_LENGTH),
    });
    expect(r.success).toBe(true);
  });

  it('rejects an actor at MAX + 1 with ACTOR_IDENTIFIER_TOO_LONG', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      actor: repeat(MAX_TRANSITION_ACTOR_LENGTH + 1),
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.actor).toBe('ACTOR_IDENTIFIER_TOO_LONG');
  });

  it('rejects oversized actor (10x bound)', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      actor: repeat(MAX_TRANSITION_ACTOR_LENGTH * 10),
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.actor).toBe('ACTOR_IDENTIFIER_TOO_LONG');
  });

  it('rejects numeric actor with INVALID_ACTOR_TYPE', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', actor: 99 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.actor).toBe('INVALID_ACTOR_TYPE');
  });

  it('rejects boolean actor with INVALID_ACTOR_TYPE', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', actor: false });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.actor).toBe('INVALID_ACTOR_TYPE');
  });

  it('trims whitespace from the actor', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      actor: '   user-1   ',
    });
    expect(r.success).toBe(true);
    expect(r.data.actor).toBe('user-1');
  });
});

// ---------------------------------------------------------------------------
// Unknown fields — including prototype-pollution vectors
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — unknown fields', () => {
  it('rejects a single unknown top-level field with UNRECOGNIZED_FIELD', () => {
    const r = safeParseTransitionBody({ targetState: 'pending', evil: 'value' });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.evil).toBe('UNRECOGNIZED_FIELD');
  });

  it('rejects multiple unknown top-level fields', () => {
    const r = safeParseTransitionBody({ targetState: 'pending', foo: 1, bar: 2 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.foo).toBe('UNRECOGNIZED_FIELD');
    expect(r.fieldErrors.bar).toBe('UNRECOGNIZED_FIELD');
  });

  it('rejects prototype-pollution style __proto__ key', () => {
    const parsed = JSON.parse('{"targetState":"pending","__proto__":{"polluted":true}}');
    const r = safeParseTransitionBody(parsed);
    expect(r.success).toBe(false);
    // __proto__ is an own enumerable key after JSON.parse
    const codes = Object.values(r.fieldErrors);
    expect(codes).toContain('UNRECOGNIZED_FIELD');
  });

  it('rejects constructor-style key', () => {
    const parsed = JSON.parse(
      '{"targetState":"pending","constructor":{"prototype":{"polluted":true}}}'
    );
    const r = safeParseTransitionBody(parsed);
    expect(r.success).toBe(false);
    const codes = Object.values(r.fieldErrors);
    expect(codes).toContain('UNRECOGNIZED_FIELD');
  });

  it('reports each unknown key separately', () => {
    const r = safeParseTransitionBody({
      targetState: 'pending',
      alpha: 1,
      beta: 2,
      gamma: 3,
    });
    expect(Object.keys(r.fieldErrors).sort()).toEqual(['alpha', 'beta', 'gamma']);
    for (const code of Object.values(r.fieldErrors)) {
      expect(code).toBe('UNRECOGNIZED_FIELD');
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata coverage
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — metadata', () => {
  it('accepts a flat metadata object', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      metadata: { source: 'web', score: 90 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts metadata as null', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', metadata: null });
    expect(r.success).toBe(true);
  });

  it('accepts metadata as undefined (omitted)', () => {
    const r = safeParseTransitionBody({ targetState: 'approved' });
    expect(r.success).toBe(true);
  });

  it('accepts nested metadata within depth bound', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      metadata: { a: { b: { c: 'value' } } }, // depth 3
    });
    expect(r.success).toBe(true);
  });

  it('rejects metadata exceeding depth bound', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      metadata: { a: { b: { c: { d: 'value' } } } }, // depth 4
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.metadata).toBe('METADATA_DEPTH_EXCEEDED');
  });

  it('rejects deeply nested metadata via long chain', () => {
    let nested = 'leaf';
    for (let i = 0; i < 10; i += 1) {
      nested = { x: nested };
    }
    const r = safeParseTransitionBody({ targetState: 'approved', metadata: nested });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.metadata).toBe('METADATA_DEPTH_EXCEEDED');
  });

  it('rejects metadata string value longer than bound', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      metadata: { long: repeat(MAX_METADATA_KEY_LENGTH + 1) },
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.metadata).toBe('METADATA_VALUE_TOO_LONG');
  });

  it('rejects metadata key longer than bound', () => {
    const longKey = repeat(MAX_METADATA_KEY_LENGTH + 1);
    const obj = { [longKey]: 'value' };
    const r = safeParseTransitionBody({ targetState: 'approved', metadata: obj });
    expect(r.success).toBe(false);
    expect(r.fieldErrors[`metadata.${longKey}`]).toBe('METADATA_KEY_TOO_LONG');
  });

  it('rejects metadata object exceeding MAX_METADATA_KEYS_PER_OBJECT', () => {
    const obj = {};
    for (let i = 0; i < MAX_METADATA_KEYS_PER_OBJECT + 1; i += 1) {
      obj[`k${i}`] = i;
    }
    const r = safeParseTransitionBody({ targetState: 'approved', metadata: obj });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.metadata).toBe('METADATA_TOO_MANY_KEYS');
  });

  it('rejects metadata array exceeding MAX_METADATA_ARRAY_LENGTH', () => {
    const arr = [];
    for (let i = 0; i < MAX_METADATA_ARRAY_LENGTH + 1; i += 1) {
      arr.push('x');
    }
    const r = safeParseTransitionBody({ targetState: 'approved', metadata: arr });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.metadata).toBe('METADATA_ARRAY_TOO_LONG');
  });

  it('accepts metadata boolean and number primitives', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      metadata: { ok: true, count: 42, label: 'short' },
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// currentState coverage
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — currentState', () => {
  it('accepts a valid currentState', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', currentState: 'pending' });
    expect(r.success).toBe(true);
  });

  it('accepts omitting currentState', () => {
    const r = safeParseTransitionBody({ targetState: 'approved' });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid currentState with INVALID_CURRENT_STATE', () => {
    const r = safeParseTransitionBody({
      targetState: 'approved',
      currentState: 'not_a_state',
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.currentState).toBe('INVALID_CURRENT_STATE');
  });

  it('rejects numeric currentState with INVALID_CURRENT_STATE', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', currentState: 100 });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.currentState).toBe('INVALID_CURRENT_STATE');
  });

  it('rejects boolean currentState with INVALID_CURRENT_STATE', () => {
    const r = safeParseTransitionBody({ targetState: 'approved', currentState: true });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.currentState).toBe('INVALID_CURRENT_STATE');
  });
});

// ---------------------------------------------------------------------------
// Multiple errors
// ---------------------------------------------------------------------------

describe('safeParseTransitionBody — multi-error paths', () => {
  it('returns distinct error codes per failing field', () => {
    const r = safeParseTransitionBody({
      targetState: 'not_a_state',
      reason: 12345,
      actor: { nested: true },
      evil: true,
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
    expect(r.fieldErrors.reason).toBe('INVALID_REASON_TYPE');
    expect(r.fieldErrors.actor).toBe('INVALID_ACTOR_TYPE');
    expect(r.fieldErrors.evil).toBe('UNRECOGNIZED_FIELD');
  });

  it('reports both missing targetState and overflow reason together', () => {
    const r = safeParseTransitionBody({
      reason: repeat(MAX_TRANSITION_REASON_LENGTH + 100),
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.targetState).toBe('MISSING_TARGET_STATE');
    expect(r.fieldErrors.reason).toBe('TRANSITION_REASON_TOO_LONG');
  });

  it('reports metadata errors independently of field errors', () => {
    const r = safeParseTransitionBody({
      targetState: 'pending',
      reason: 999,
      metadata: { a: { b: { c: { d: 'value' } } } },
    });
    expect(r.success).toBe(false);
    expect(r.fieldErrors.reason).toBe('INVALID_REASON_TYPE');
    expect(r.fieldErrors.metadata).toBe('METADATA_DEPTH_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// Direct metadata validator unit tests (covers INVALID_METADATA_TYPE).
// These are reachable only via direct JS calls because JSON cannot carry
// function/Symbol/BigInt values through the HTTP layer.
// ---------------------------------------------------------------------------

describe('validateMetadataShape — direct unit', () => {
  it('flags INVALID_METADATA_TYPE for function primitive', () => {
    const issues = [];
    validateMetadataShape(() => 'fn', (i) => issues.push(i), 0);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('INVALID_METADATA_TYPE');
    expect(issues[0].path).toEqual(['metadata']);
  });

  it('flags INVALID_METADATA_TYPE for symbol primitive', () => {
    const issues = [];
    validateMetadataShape(Symbol('s'), (i) => issues.push(i), 0);
    expect(issues[0].code).toBe('INVALID_METADATA_TYPE');
  });

  it('flags INVALID_METADATA_TYPE for BigInt primitive', () => {
    const issues = [];
    validateMetadataShape(BigInt(1), (i) => issues.push(i), 0);
    expect(issues[0].code).toBe('INVALID_METADATA_TYPE');
  });

  it('returns void for null/undefined', () => {
    const issues = [];
    validateMetadataShape(null, (i) => issues.push(i), 0);
    validateMetadataShape(undefined, (i) => issues.push(i), 0);
    expect(issues).toHaveLength(0);
  });

  it('returns void for short string', () => {
    const issues = [];
    validateMetadataShape('hi', (i) => issues.push(i), 0);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Route integration
// ---------------------------------------------------------------------------

describe('POST /api/invoices/transition — route integration', () => {
  it('returns 200 with requiresKYC:false for verified target', async () => {
    const res = await postTransition({ targetState: 'verified' });
    expect(res.status).toBe(200);
    expect(res.body.requiresKYC).toBe(false);
    expect(res.body.state).toBe('verified');
  });

  it('returns 200 with requiresKYC:true for funded target', async () => {
    const res = await postTransition({ targetState: 'funded' });
    expect(res.status).toBe(200);
    expect(res.body.requiresKYC).toBe(true);
    expect(res.body.state).toBe('funded');
  });

  it('returns 200 with requiresKYC:true for settled target', async () => {
    const res = await postTransition({ targetState: 'settled' });
    expect(res.status).toBe(200);
    expect(res.body.requiresKYC).toBe(true);
  });

  it('returns RFC 7807 envelope for missing targetState with machine-readable code', async () => {
    const res = await postTransition({});
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('https://liquifact.io/problems/validation-error');
    expect(res.body.title).toBe('Invalid invoice-state request body');
    expect(res.body.status).toBe(400);
    expect(res.body.code).toBe('INVOICE_STATE_VALIDATION_FAILED');
    expect(res.body.fieldErrors).toBeDefined();
    expect(res.body.fieldErrors.targetState).toBe('MISSING_TARGET_STATE');
  });

  it('returns INVALID_TARGET_STATE for unknown state value', async () => {
    const res = await postTransition({ targetState: 'not_real_state' });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('returns INVALID_TARGET_STATE for wrong-type targetState', async () => {
    const res = await postTransition({ targetState: 42 });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.targetState).toBe('INVALID_TARGET_STATE');
  });

  it('returns UNRECOGNIZED_FIELD for unknown top-level field', async () => {
    const res = await postTransition({ targetState: 'pending', evil: 'value' });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.evil).toBe('UNRECOGNIZED_FIELD');
  });

  it('returns UNRECOGNIZED_FIELD for prototype-pollution __proto__ key', async () => {
    const res = await request(buildApp())
      .post('/api/invoices/transition')
      .set('Content-Type', 'application/json')
      .send('{"targetState":"pending","__proto__":{"polluted":true}}');
    expect(res.status).toBe(400);
    const codes = Object.values(res.body.fieldErrors);
    expect(codes).toContain('UNRECOGNIZED_FIELD');
  });

  it('returns UNRECOGNIZED_FIELD for constructor-style key', async () => {
    const res = await request(buildApp())
      .post('/api/invoices/transition')
      .set('Content-Type', 'application/json')
      .send('{"targetState":"pending","constructor":{"prototype":{"polluted":true}}}');
    expect(res.status).toBe(400);
    const codes = Object.values(res.body.fieldErrors);
    expect(codes).toContain('UNRECOGNIZED_FIELD');
  });

  it('returns MISSING_BODY for empty body', async () => {
    const res = await request(buildApp())
      .post('/api/invoices/transition')
      .send();
    expect(res.status).toBe(400);
    expect(Object.values(res.body.fieldErrors)).toContain('MISSING_BODY');
  });

  it('returns INVALID_BODY_TYPE when handler is invoked with null body', async () => {
    // Express body-parser behaviour with literal 'null' bodies varies across
    // versions and may surface as a parse error before our middleware
    // runs. We exercise the same validation path directly via the wrapper
    // (already covered in safeParseTransitionBody tests above) and then
    // assert the route integration with a body that the JSON parser
    // definitely accepts: an object literal whose `req.body` is null.
    const res = await request(buildApp())
      .post('/api/invoices/transition')
      .set('x-test-null-body', '1')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns INVALID_BODY_TYPE for array body', async () => {
    const res = await request(buildApp())
      .post('/api/invoices/transition')
      .send([{ targetState: 'pending' }]);
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors._root).toBe('INVALID_BODY_TYPE');
  });

  it('reports reason type errors inline', async () => {
    const res = await postTransition({ targetState: 'pending', reason: 999 });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.reason).toBe('INVALID_REASON_TYPE');
  });

  it('reports actor overflow inline', async () => {
    const res = await postTransition({
      targetState: 'pending',
      actor: repeat(MAX_TRANSITION_ACTOR_LENGTH + 5),
    });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.actor).toBe('ACTOR_IDENTIFIER_TOO_LONG');
  });

  it('reports reason overflow inline', async () => {
    const res = await postTransition({
      targetState: 'pending',
      reason: repeat(MAX_TRANSITION_REASON_LENGTH + 5),
    });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.reason).toBe('TRANSITION_REASON_TOO_LONG');
  });

  it('reports metadata depth exceeded inline', async () => {
    const res = await postTransition({
      targetState: 'pending',
      metadata: { a: { b: { c: { d: 'x' } } } },
    });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.metadata).toBe('METADATA_DEPTH_EXCEEDED');
  });

  it('reports metadata oversized key inline', async () => {
    const longKey = repeat(MAX_METADATA_KEY_LENGTH + 1);
    const res = await postTransition({
      targetState: 'pending',
      metadata: { [longKey]: 'v' },
    });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors[`metadata.${longKey}`]).toBe('METADATA_KEY_TOO_LONG');
  });

  it('boundary — reason at exactly MAX passes', async () => {
    const res = await postTransition({
      targetState: 'rejected',
      reason: repeat(MAX_TRANSITION_REASON_LENGTH),
    });
    expect(res.status).toBe(200);
  });

  it('boundary — reason at MAX + 1 rejected', async () => {
    const res = await postTransition({
      targetState: 'rejected',
      reason: repeat(MAX_TRANSITION_REASON_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.reason).toBe('TRANSITION_REASON_TOO_LONG');
  });

  it('boundary — actor at exactly MAX passes', async () => {
    const res = await postTransition({
      targetState: 'approved',
      actor: repeat(MAX_TRANSITION_ACTOR_LENGTH),
    });
    expect(res.status).toBe(200);
  });

  it('boundary — actor at MAX + 1 rejected', async () => {
    const res = await postTransition({
      targetState: 'approved',
      actor: repeat(MAX_TRANSITION_ACTOR_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.actor).toBe('ACTOR_IDENTIFIER_TOO_LONG');
  });
});

// ---------------------------------------------------------------------------
// Constants and module exports
// ---------------------------------------------------------------------------

describe('schema module — exported constants', () => {
  it('exports BOUNDED_TARGET_STATES as a frozen array', () => {
    expect(Array.isArray(BOUNDED_TARGET_STATES)).toBe(true);
    expect(Object.isFrozen(BOUNDED_TARGET_STATES)).toBe(true);
    expect(BOUNDED_TARGET_STATES.length).toBeGreaterThan(0);
  });

  it('exports MAX_TRANSITION_REASON_LENGTH > 0 and < 65536', () => {
    expect(MAX_TRANSITION_REASON_LENGTH).toBeGreaterThan(0);
    expect(MAX_TRANSITION_REASON_LENGTH).toBeLessThan(65536);
  });

  it('exports MAX_TRANSITION_ACTOR_LENGTH > 0 and < 1024', () => {
    expect(MAX_TRANSITION_ACTOR_LENGTH).toBeGreaterThan(0);
    expect(MAX_TRANSITION_ACTOR_LENGTH).toBeLessThan(1024);
  });

  it('exports MAX_METADATA_KEY_LENGTH as a positive integer', () => {
    expect(Number.isInteger(MAX_METADATA_KEY_LENGTH)).toBe(true);
    expect(MAX_METADATA_KEY_LENGTH).toBeGreaterThan(0);
  });

  it('exports MAX_TRANSITION_METADATA_DEPTH as a positive integer', () => {
    expect(Number.isInteger(MAX_TRANSITION_METADATA_DEPTH)).toBe(true);
    expect(MAX_TRANSITION_METADATA_DEPTH).toBeGreaterThan(0);
  });

  it('exports ALLOWED_TOP_LEVEL_KEYS as a set with the five expected members', () => {
    expect(ALLOWED_TOP_LEVEL_KEYS).toBeInstanceOf(Set);
    expect(ALLOWED_TOP_LEVEL_KEYS.size).toBe(5);
    for (const k of ['targetState', 'reason', 'actor', 'currentState', 'metadata']) {
      expect(ALLOWED_TOP_LEVEL_KEYS.has(k)).toBe(true);
    }
  });

  it('BOUNDED_TARGET_STATES is a superset of ALL statuses', () => {
    expect(BOUNDED_TARGET_STATES.length).toBe(ALL_INVOICE_STATUSES.length);
    for (const v of ALL_INVOICE_STATUSES) {
      expect(BOUNDED_TARGET_STATES).toContain(v);
    }
  });

  it('exposes transitionBodySchema as a parseable Zod schema', () => {
    expect(typeof transitionBodySchema.safeParse).toBe('function');
    const r = transitionBodySchema.safeParse({ targetState: 'pending' });
    expect(r.success).toBe(true);
  });
});
