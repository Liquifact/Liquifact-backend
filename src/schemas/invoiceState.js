'use strict';

/**
 * @fileoverview Zod schemas and validation wrapper for invoice-state bodies.
 *
 * Source of truth for the inbound shape of state-machine write operations on
 * invoices (e.g. `POST /transition`). It hardens the endpoints against:
 *
 *   - Unknown top-level keys (including prototype-pollution vectors like
 *     `__proto__` / `constructor`)
 *   - Wrong field types (numbers/booleans/arrays passed where strings/enums
 *     belong)
 *   - Out-of-range and oversized string/numeric values
 *   - Excessively nested metadata payloads
 *
 * Exposes:
 *
 *   - `safeParseTransitionBody(body)` — primary API: returns either
 *     `{ success: true, data }` or `{ success: false, fieldErrors }` where
 *     `fieldErrors` keys are field paths and values are machine-readable
 *     uppercase error codes.
 *   - `transitionBodySchema` — the inner Zod schema, exposed for callers
 *     that prefer to consume raw Zod results.
 *   - `validateMetadataShape(value, addIssue, depth)` — recursive metadata
 *     validator, also exported for direct unit testing.
 *   - Bounds: `MAX_TRANSITION_REASON_LENGTH`, `MAX_TRANSITION_ACTOR_LENGTH`,
 *     `MAX_METADATA_KEY_LENGTH`, `MAX_TRANSITION_METADATA_DEPTH`,
 *     `MAX_METADATA_KEYS_PER_OBJECT`, `MAX_METADATA_ARRAY_LENGTH`.
 *   - `BOUNDED_TARGET_STATES` (frozen allow-list) and `ALLOWED_TOP_LEVEL_KEYS`.
 *
 * @module schemas/invoiceState
 */

const { z } = require('zod');
const { ALL_INVOICE_STATUSES } = require('../services/invoiceStateMachine');

// ---------------------------------------------------------------------------
// Bounds & constants
// ---------------------------------------------------------------------------

/** Maximum allowed length for a human-readable `reason` string. */
const MAX_TRANSITION_REASON_LENGTH = 1024;

/** Maximum allowed length for the `actor` identifier. */
const MAX_TRANSITION_ACTOR_LENGTH = 100;

/** Maximum allowed length for individual metadata key strings. */
const MAX_METADATA_KEY_LENGTH = 64;

/** Maximum allowed depth for nested metadata objects. */
const MAX_TRANSITION_METADATA_DEPTH = 3;

/** Maximum allowed number of keys in a single metadata object. */
const MAX_METADATA_KEYS_PER_OBJECT = 50;

/** Maximum allowed length of a single metadata array. */
const MAX_METADATA_ARRAY_LENGTH = 100;

/**
 * Authoritative allow-list of legal invoice state strings for `targetState`.
 *
 * @type {readonly string[]}
 */
const BOUNDED_TARGET_STATES = Object.freeze(
  Array.isArray(ALL_INVOICE_STATUSES) ? [...ALL_INVOICE_STATUSES] : []
);

/**
 * Centralised transition table.
 *
 * A transition is valid when `targetState` is the same as `currentState`
 * (idempotent retry) or appears later in `ALL_INVOICE_STATUSES`. The order
 * of `ALL_INVOICE_STATUSES` is therefore the source of truth for forward
 * progress.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const ALLOWED_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    BOUNDED_TARGET_STATES.map((state, index) => [
      state,
      Object.freeze(BOUNDED_TARGET_STATES.slice(index)),
    ])
  )
);

/**
 * Set of allowed top-level keys for the transition body.
 *
 * Anything outside this set is rejected with `UNRECOGNIZED_FIELD`.  The set
 * is checked explicitly (not just via Zod's `.strict()`) so prototype-
 * pollution vectors like `__proto__` / `constructor` are caught
 * deterministically regardless of Zod internals.
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_TOP_LEVEL_KEYS = Object.freeze(
  new Set(['targetState', 'reason', 'actor', 'currentState', 'revision', 'metadata'])
);

// ---------------------------------------------------------------------------
// Recursive metadata validator
// ---------------------------------------------------------------------------

/**
 * Recursively validates the shape of an optional `metadata` value.
 *
 * Emits machine-readable codes via `addIssue({ path, code })`.  Once
 * `METADATA_DEPTH_EXCEEDED` has been emitted for a subtree, recursion
 * short-circuits to keep issue volume bounded for adversarial input.
 *
 * Constraints enforced:
 *   - `null` / `undefined` are accepted as "no metadata".
 *   - `string` is accepted when `length <= MAX_METADATA_KEY_LENGTH`.
 *   - `number` / `boolean` are accepted unconditionally.
 *   - `array` is accepted when `length <= MAX_METADATA_ARRAY_LENGTH`.
 *   - `object` is accepted when key count <= MAX_METADATA_KEYS_PER_OBJECT
 *     AND no key exceeds MAX_METADATA_KEY_LENGTH.
 *   - Recursion depth is bounded by MAX_TRANSITION_METADATA_DEPTH.
 *   - Anything else (function, symbol, BigInt) emits `INVALID_METADATA_TYPE`;
 *     these reach the validator only via direct JS callers because JSON
 *     cannot transport them through HTTP.
 *
 * @param {unknown} value - Candidate metadata value.
 * @param {(i: { path: string[], code: string }) => void} addIssue - Emits a finding.
 * @param {number} depth - Current nesting depth (root call uses 0).
 * @returns {void}
 */
function validateMetadataShape(value, addIssue, depth) {
  if (depth > MAX_TRANSITION_METADATA_DEPTH) {
    addIssue({ path: ['metadata'], code: 'METADATA_DEPTH_EXCEEDED' });
    return;
  }
  if (value === null || value === undefined) {
    return;
  }

  const t = typeof value;

  if (t === 'string') {
    if (value.length > MAX_METADATA_KEY_LENGTH) {
      addIssue({ path: ['metadata'], code: 'METADATA_VALUE_TOO_LONG' });
    }
    return;
  }

  if (t === 'number' || t === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_LENGTH) {
      addIssue({ path: ['metadata'], code: 'METADATA_ARRAY_TOO_LONG' });
      return;
    }
    for (let i = 0; i < value.length; i += 1) {
      validateMetadataShape(value[i], addIssue, depth + 1);
    }
    return;
  }

  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length > MAX_METADATA_KEYS_PER_OBJECT) {
      addIssue({ path: ['metadata'], code: 'METADATA_TOO_MANY_KEYS' });
      return;
    }
    for (const key of keys) {
      if (key.length > MAX_METADATA_KEY_LENGTH) {
        addIssue({ path: ['metadata', key], code: 'METADATA_KEY_TOO_LONG' });
      }
      validateMetadataShape(value[key], addIssue, depth + 1);
    }
    return;
  }

  // Function, Symbol, BigInt etc. — only reachable from direct JS callers.
  addIssue({ path: ['metadata'], code: 'INVALID_METADATA_TYPE' });
}

// ---------------------------------------------------------------------------
// Inner Zod schema
// ---------------------------------------------------------------------------

/**
 * Inner Zod schema for the transition body.  This is wrapped by
 * `safeParseTransitionBody` which converts Zod issues into the canonical
 * machine-readable code vocabulary exposed to API clients.
 *
 * @type {import('zod').ZodObject}
 */
const transitionBodySchema = z.object({
  targetState: z
    .enum(/** @type {[string, ...string[]]} */ (BOUNDED_TARGET_STATES), {
      error: 'INVALID_TARGET_STATE',
    }),

  reason: z
    .string({ error: 'INVALID_REASON_TYPE' })
    .trim()
    .max(MAX_TRANSITION_REASON_LENGTH, {
      error: 'TRANSITION_REASON_TOO_LONG',
    })
    .optional(),

  actor: z
    .string({ error: 'INVALID_ACTOR_TYPE' })
    .trim()
    .max(MAX_TRANSITION_ACTOR_LENGTH, {
      error: 'ACTOR_IDENTIFIER_TOO_LONG',
    })
    .optional(),

  currentState: z
    .enum(/** @type {[string, ...string[]]} */ (BOUNDED_TARGET_STATES), {
      error: 'INVALID_CURRENT_STATE',
    })
    .optional(),

  revision: z
    .number({ error: 'INVALID_REVISION_TYPE' })
    .int({ error: 'INVALID_REVISION_TYPE' })
    .nonnegative({ error: 'INVALID_REVISION' }),

  metadata: z.unknown().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Issue remapping (with `input` context for distinguishing missing/invalid)
// ---------------------------------------------------------------------------

/**
 * Normalises a field path for use as a code suffix.
 *
 * Splits camelCase boundaries (so `currentState` becomes `CURRENT_STATE`),
 * replaces `.` with `_` (so nested metadata paths read cleanly), then
 * uppercases.  This must be kept in sync with every test assertion that
 * builds codes by hand (e.g. `INVALID_CURRENT_STATE`).
 *
 * @param {string} field - Dot-separated field path (e.g. `metadata.foo`).
 * @returns {string} Uppercase underscore-delimited path.
 */
function pathToBase(field) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/\./g, '_')
    .toUpperCase();
}

/**
 * Uppercase-underscore pattern that matches a Zod static `error: 'CODE'`
 * string when emitted verbatim.
 *
 * @type {RegExp}
 */
const CODE_MESSAGE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Converts a Zod issue into a machine-readable code, in priority order:
 *
 *   1. `targetState` (required enum) — distinguishes missing-vs-invalid by
 *      inspecting the raw input (Zod 4 reports `received: undefined` for
 *      both genuine missing and some wrong-value cases).
 *   2. If the Zod issue has a static uppercase-underscore `message`
 *      (e.g. `TRANSITION_REASON_TOO_LONG`, `INVALID_REASON_TYPE`),
 *      return that message verbatim.  This honours the per-field static
 *      codes declared on the inline `.max(..., { error: '...' })` and
 *      `.string({ error: '...' })` calls.
 *   3. Otherwise derive deterministically from the issue code:
 *      `invalid_type` → `INVALID_<BASE>_TYPE`,
 *      `too_big` → `<BASE>_TOO_LONG`,
 *      `invalid_value` → `INVALID_<BASE>`,
 *      `unrecognized_keys` → `UNRECOGNIZED_FIELD`.
 *
 * @param {object} issue - Zod issue.
 * @param {string} field - Joined issue path.
 * @param {object} input - Original parsed input.
 * @returns {string} Uppercase machine-readable code.
 */
function remapIssueCode(issue, field, input) {
  if (field === 'targetState') {
    const raw = input ? input.targetState : undefined;
    if (raw === undefined || raw === null) {
      return 'MISSING_TARGET_STATE';
    }
    return 'INVALID_TARGET_STATE';
  }

  if (field === 'revision') {
    const raw = input ? input.revision : undefined;
    if (raw === undefined || raw === null) {
      return 'MISSING_REVISION';
    }
  }

  if (typeof issue.message === 'string' && CODE_MESSAGE_PATTERN.test(issue.message)) {
    return issue.message;
  }

  const base = pathToBase(field);

  switch (issue.code) {
    case 'invalid_type':
      return `INVALID_${base}_TYPE`;
    case 'too_big':
      return `${base}_TOO_LONG`;
    case 'too_small':
      return `${base}_TOO_SHORT`;
    case 'invalid_value':
      return `INVALID_${base}`;
    case 'unrecognized_keys':
      return 'UNRECOGNIZED_FIELD';
    default:
      return `INVALID_${base}`;
  }
}

/**
 * Builds a `fieldErrors` object with a null prototype so keys like
 * `__proto__` and `constructor` cannot accidentally be reinterpreted as
 * accessor-driven lookups during error map construction.
 *
 * @returns {Record<string, string>} Empty error map.
 */
function newFieldErrors() {
  return Object.create(null);
}

/**
 * Validates a request body for the invoice-state transition endpoint.
 *
 * Performs the following checks in order, accumulating all errors before
 * returning so callers can render every offending field in a single
 * response:
 *
 *   1. Top-level shape — body must be a non-null, non-array object.
 *   2. Unknown top-level keys — every key must be in `ALLOWED_TOP_LEVEL_KEYS`.
 *   3. Field-level validation — runs Zod against the bounded schema;
 *      remaps default messages to machine-readable uppercase codes via
 *      `remapIssueCode`.
 *   4. Recursive `metadata` shape — runs independently of the Zod result
 *      so depth / key-length / value-length / key-count / type violations
 *      surface even when sibling fields are also invalid.
 *
 * @param {unknown} input - Raw request body (typically `req.body`).
 * @returns {{ success: true, data: object } | { success: false, fieldErrors: Record<string,string> }}
 */
function safeParseTransitionBody(input) {
  const fieldErrors = newFieldErrors();

  // 1. Top-level shape check.
  if (input === undefined) {
    fieldErrors._root = 'MISSING_BODY';
    return { success: false, fieldErrors };
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fieldErrors._root = 'INVALID_BODY_TYPE';
    return { success: false, fieldErrors };
  }

  // 2. Explicit unknown-key detection (catches __proto__/constructor reliably).
  const inputKeys = Object.keys(input);
  for (const key of inputKeys) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      fieldErrors[key] = 'UNRECOGNIZED_FIELD';
    }
  }

  // 3. Field-level Zod validation.
  let parsedData = null;
  const zodResult = transitionBodySchema.safeParse(input);
  if (!zodResult.success) {
    for (const issue of zodResult.error.issues) {
      // Skip Zod-emitted unrecognized_keys findings: we already handled
      // every unknown top-level key in step 2 and would otherwise assign
      // a redundant `_root` entry.
      if (issue.code === 'unrecognized_keys') {
        continue;
      }
      const field = issue.path.length === 0 ? '_root' : issue.path.join('.');
      if (!fieldErrors[field]) {
        fieldErrors[field] = remapIssueCode(issue, field, input);
      }
    }
  } else {
    parsedData = zodResult.data;
  }

  // 4. Metadata recursive shape check (always runs when metadata is present).
  if (Object.prototype.hasOwnProperty.call(input, 'metadata')) {
    const meta = input.metadata;
    if (meta !== undefined && meta !== null && typeof meta === 'object') {
      const metadataIssues = [];
      validateMetadataShape(
        meta,
        (finding) => metadataIssues.push(finding),
        0
      );
      for (const finding of metadataIssues) {
        const field = finding.path.length === 0 ? 'metadata' : finding.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = finding.code;
        }
      }
    }
  }

  if (parsedData && parsedData.currentState !== undefined) {
    const allowedTargets = ALLOWED_TRANSITIONS[parsedData.currentState];
    if (!allowedTargets || !allowedTargets.includes(parsedData.targetState)) {
      fieldErrors.currentState = 'INVALID_STATE_TRANSITION';
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }
  return { success: true, data: parsedData };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  safeParseTransitionBody,
  transitionBodySchema,
  validateMetadataShape,
  MAX_TRANSITION_REASON_LENGTH,
  MAX_TRANSITION_ACTOR_LENGTH,
  MAX_METADATA_KEY_LENGTH,
  MAX_TRANSITION_METADATA_DEPTH,
  MAX_METADATA_KEYS_PER_OBJECT,
  MAX_METADATA_ARRAY_LENGTH,
  BOUNDED_TARGET_STATES,
  ALLOWED_TRANSITIONS,
  ALLOWED_TOP_LEVEL_KEYS,
};
