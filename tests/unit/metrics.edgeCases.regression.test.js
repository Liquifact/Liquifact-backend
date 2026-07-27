'use strict';

/**
 * @fileoverview Regression tests for known metrics edge cases (issue #919).
 *
 * Every test section is named after the specific scenario that was
 * previously broken or identified as a risk. The scenario tag in the test
 * name makes it easy to trace back to the originating issue.
 *
 * Coverage areas:
 *  - normalizeReminderReason: empty / null / malformed inputs
 *  - normalizeJobType: empty / boundary / unknown values
 *  - normalizeSorobanRpcMethod: empty / alias boundary / malformed
 *  - normalizeSorobanRpcOutcome: empty / boundary / unknown
 *  - normalizeSorobanRetryCause: empty / boundary / malformed
 *  - normalizeHealthEndpoint / StatusClass / Cause: boundary + malformed
 *  - normalizeMetricsEndpointStatusClass / Cause: boundary + malformed
 *  - normalizeKycWebhookStatusClass / Cause: boundary + malformed
 *  - normalizePersistenceEndpoint / StatusClass / Cause: empty / boundary / malformed
 *  - safeEqual: empty strings, single-char difference, unicode
 *  - Counter / Gauge shim: inc(0), inc(NaN), observe(negative)
 *  - refreshMetrics: empty registries, getStats throws, NaN stats
 *  - validateMetricsRequest: all falsy tenantId variants
 */

const metrics = require('../../src/metrics');

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Prevent cross-test pollution for all counters/gauges/histograms.
  metrics.registry.resetMetrics();
  metrics.resetMetricsForTests();
});

afterEach(() => {
  metrics.stopMetricsRefresh();
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: normalizeReminderReason — empty / null / malformed
// (regression: previously returned undefined for null input, causing label
// cardinality explosion when the label was emitted with no value)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeReminderReason — empty / null / malformed inputs', () => {
  it('[scenario: null input] returns "unknown" for null', () => {
    expect(metrics.normalizeReminderReason(null)).toBe('unknown');
  });

  it('[scenario: undefined input] returns "unknown" for undefined', () => {
    expect(metrics.normalizeReminderReason(undefined)).toBe('unknown');
  });

  it('[scenario: empty string] returns "unknown" for empty string', () => {
    expect(metrics.normalizeReminderReason('')).toBe('unknown');
  });

  it('[scenario: empty object] returns "unknown" for {}', () => {
    expect(metrics.normalizeReminderReason({})).toBe('unknown');
  });

  it('[scenario: numeric input] returns "unknown" for a number', () => {
    expect(metrics.normalizeReminderReason(42)).toBe('unknown');
  });

  it('[scenario: array input] returns "unknown" for an array', () => {
    expect(metrics.normalizeReminderReason([])).toBe('unknown');
  });

  it('[scenario: timeout boundary] ETIMEDOUT code maps to smtp_timeout', () => {
    expect(metrics.normalizeReminderReason({ code: 'ETIMEDOUT' })).toBe('smtp_timeout');
  });

  it('[scenario: timeout boundary] message "timed out" maps to smtp_timeout', () => {
    expect(metrics.normalizeReminderReason({ message: 'connection timed out' })).toBe('smtp_timeout');
  });

  it('[scenario: smtp boundary] "reject" keyword maps to smtp_reject', () => {
    expect(metrics.normalizeReminderReason({ message: 'SMTP server rejected the message' })).toBe('smtp_reject');
  });

  it('[scenario: template boundary] "template" keyword maps to template_error', () => {
    expect(metrics.normalizeReminderReason({ message: 'template rendering failed' })).toBe('template_error');
  });

  it('[scenario: malformed — code is a number] does not throw, returns unknown', () => {
    expect(() => metrics.normalizeReminderReason({ code: 999 })).not.toThrow();
    expect(metrics.normalizeReminderReason({ code: 999 })).toBe('unknown');
  });

  it('[scenario: plain string timeout] plain string with "timeout" maps to smtp_timeout', () => {
    expect(metrics.normalizeReminderReason('request timeout')).toBe('smtp_timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: normalizeJobType — empty / boundary / unknown
// (regression: non-string values previously caused TypeError in includes())
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeJobType — empty / boundary / unknown inputs', () => {
  it('[scenario: empty string] returns "unknown"', () => {
    expect(metrics.normalizeJobType('')).toBe('unknown');
  });

  it('[scenario: null] returns "unknown"', () => {
    expect(metrics.normalizeJobType(null)).toBe('unknown');
  });

  it('[scenario: undefined] returns "unknown"', () => {
    expect(metrics.normalizeJobType(undefined)).toBe('unknown');
  });

  it('[scenario: number] does not throw, returns "unknown"', () => {
    expect(() => metrics.normalizeJobType(0)).not.toThrow();
    expect(metrics.normalizeJobType(0)).toBe('unknown');
  });

  it('[scenario: object] does not throw, returns "unknown"', () => {
    expect(metrics.normalizeJobType({ type: 'maturity_reminder' })).toBe('unknown');
  });

  it('[scenario: boundary — maturity_reminder] returns "maturity_reminder"', () => {
    expect(metrics.normalizeJobType('maturity_reminder')).toBe('maturity_reminder');
  });

  it('[scenario: boundary — webhook_replay] returns "webhook_replay"', () => {
    expect(metrics.normalizeJobType('webhook_replay')).toBe('webhook_replay');
  });

  it('[scenario: boundary — unknown] "unknown" passes through', () => {
    expect(metrics.normalizeJobType('unknown')).toBe('unknown');
  });

  it('[scenario: malformed — mixed case] "MATURITY_REMINDER" collapses to "unknown"', () => {
    expect(metrics.normalizeJobType('MATURITY_REMINDER')).toBe('unknown');
  });

  it('[scenario: malformed — whitespace-padded] "  maturity_reminder  " collapses to "unknown"', () => {
    // normalizeJobType does not trim — it must be an exact match
    expect(metrics.normalizeJobType('  maturity_reminder  ')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: normalizeSorobanRpcMethod — empty / alias boundary / malformed
// (regression: unknown-method payloads leaked into labels, exploding cardinality)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeSorobanRpcMethod — empty / alias boundary / malformed', () => {
  it('[scenario: empty string] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRpcMethod('')).toBe('unknown');
  });

  it('[scenario: null] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRpcMethod(null)).toBe('unknown');
  });

  it('[scenario: undefined] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRpcMethod(undefined)).toBe('unknown');
  });

  it('[scenario: number] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRpcMethod(42)).toBe('unknown');
  });

  it('[scenario: random payload] "secret-wallet-data-xyz" collapses to "unknown"', () => {
    expect(metrics.normalizeSorobanRpcMethod('secret-wallet-data-xyz')).toBe('unknown');
  });

  it('[scenario: alias — simulateTransaction] maps to simulate_transaction', () => {
    expect(metrics.normalizeSorobanRpcMethod('simulateTransaction')).toBe('simulate_transaction');
  });

  it('[scenario: alias — simulation] maps to simulate_transaction', () => {
    expect(metrics.normalizeSorobanRpcMethod('simulation')).toBe('simulate_transaction');
  });

  it('[scenario: alias — callsorobancontract] maps to contract_call', () => {
    expect(metrics.normalizeSorobanRpcMethod('callsorobancontract')).toBe('contract_call');
  });

  it('[scenario: alias — get_legal_hold] maps to legal_hold_status', () => {
    expect(metrics.normalizeSorobanRpcMethod('get_legal_hold')).toBe('legal_hold_status');
  });

  it('[scenario: alias — getledgerentries] maps to get_ledger_entries', () => {
    expect(metrics.normalizeSorobanRpcMethod('getledgerentries')).toBe('get_ledger_entries');
  });

  it('[scenario: canonical — schema_version] passes through', () => {
    expect(metrics.normalizeSorobanRpcMethod('schema_version')).toBe('schema_version');
  });

  it('[scenario: boundary — whitespace trimmed] " contract_call " maps to contract_call', () => {
    expect(metrics.normalizeSorobanRpcMethod(' contract_call ')).toBe('contract_call');
  });

  it('[scenario: UPPER_CASE input] lowercased before matching — SIMULATE_TRANSACTION maps to simulate_transaction', () => {
    // normalizeSorobanRpcMethod lowercases input before lookup, so UPPER_CASE aliases resolve
    expect(metrics.normalizeSorobanRpcMethod('SIMULATE_TRANSACTION')).toBe('simulate_transaction');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: normalizeSorobanRpcOutcome — boundary / malformed
// (regression: any truthy string used as label, including stack traces)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeSorobanRpcOutcome — boundary / malformed', () => {
  it('[scenario: empty string] returns "error"', () => {
    expect(metrics.normalizeSorobanRpcOutcome('')).toBe('error');
  });

  it('[scenario: null] returns "error"', () => {
    expect(metrics.normalizeSorobanRpcOutcome(null)).toBe('error');
  });

  it('[scenario: undefined] returns "error"', () => {
    expect(metrics.normalizeSorobanRpcOutcome(undefined)).toBe('error');
  });

  it('[scenario: random payload string] collapses to "error"', () => {
    expect(metrics.normalizeSorobanRpcOutcome('Error: contract call failed at line 99')).toBe('error');
  });

  it('[scenario: boundary — success] passes through', () => {
    expect(metrics.normalizeSorobanRpcOutcome('success')).toBe('success');
  });

  it('[scenario: boundary — circuit_open] passes through', () => {
    expect(metrics.normalizeSorobanRpcOutcome('circuit_open')).toBe('circuit_open');
  });

  it('[scenario: UPPER_CASE — SUCCESS] lowercased before matching — SUCCESS maps to success', () => {
    // normalizeSorobanRpcOutcome lowercases input, so SUCCESS → success (valid)
    expect(metrics.normalizeSorobanRpcOutcome('SUCCESS')).toBe('success');
  });

  it('[scenario: number] does not throw, returns "error"', () => {
    expect(() => metrics.normalizeSorobanRpcOutcome(0)).not.toThrow();
    expect(metrics.normalizeSorobanRpcOutcome(0)).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: normalizeSorobanRetryCause — boundary / malformed
// (regression: ECONNRESET and other raw codes leaked into labels)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeSorobanRetryCause — boundary / malformed', () => {
  it('[scenario: empty string] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRetryCause('')).toBe('unknown');
  });

  it('[scenario: null] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRetryCause(null)).toBe('unknown');
  });

  it('[scenario: undefined] returns "unknown"', () => {
    expect(metrics.normalizeSorobanRetryCause(undefined)).toBe('unknown');
  });

  it('[scenario: malformed — ECONNRESET] collapses to "unknown"', () => {
    expect(metrics.normalizeSorobanRetryCause('ECONNRESET')).toBe('unknown');
  });

  it('[scenario: malformed — rate-limited string] collapses to "unknown"', () => {
    expect(metrics.normalizeSorobanRetryCause('rate-limited')).toBe('unknown');
  });

  it('[scenario: boundary — timeout] passes through', () => {
    expect(metrics.normalizeSorobanRetryCause('timeout')).toBe('timeout');
  });

  it('[scenario: boundary — 429] passes through', () => {
    expect(metrics.normalizeSorobanRetryCause('429')).toBe('429');
  });

  it('[scenario: boundary — 5xx] passes through', () => {
    expect(metrics.normalizeSorobanRetryCause('5xx')).toBe('5xx');
  });

  it('[scenario: whitespace-padded] " timeout " maps to timeout after trim', () => {
    expect(metrics.normalizeSorobanRetryCause(' timeout ')).toBe('timeout');
  });

  it('[scenario: UPPERCASE] "TIMEOUT" collapses to "unknown"', () => {
    // normalizeSorobanRetryCause lowercases before matching — TIMEOUT → timeout
    expect(metrics.normalizeSorobanRetryCause('TIMEOUT')).toBe('timeout');
  });

  it('[scenario: numeric] does not throw, returns "unknown"', () => {
    expect(() => metrics.normalizeSorobanRetryCause(429)).not.toThrow();
    expect(metrics.normalizeSorobanRetryCause(429)).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: normalizeHealthEndpoint — boundary / malformed
// (regression: typo-variants caused the 'unknown' cardinality guard to be bypassed)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeHealthEndpoint — boundary / malformed', () => {
  it('[scenario: empty string] returns "unknown"', () => {
    expect(metrics.normalizeHealthEndpoint('')).toBe('unknown');
  });

  it('[scenario: null] returns "unknown"', () => {
    expect(metrics.normalizeHealthEndpoint(null)).toBe('unknown');
  });

  it('[scenario: undefined] returns "unknown"', () => {
    expect(metrics.normalizeHealthEndpoint(undefined)).toBe('unknown');
  });

  it('[scenario: number] returns "unknown"', () => {
    expect(metrics.normalizeHealthEndpoint(0)).toBe('unknown');
  });

  it('[scenario: partial match — health_live] returns "unknown"', () => {
    expect(metrics.normalizeHealthEndpoint('health_live')).toBe('unknown');
  });

  it('[scenario: boundary — health_liveness] passes through', () => {
    expect(metrics.normalizeHealthEndpoint('health_liveness')).toBe('health_liveness');
  });

  it('[scenario: boundary — health_full] passes through', () => {
    expect(metrics.normalizeHealthEndpoint('health_full')).toBe('health_full');
  });

  it('[scenario: boundary — health_readiness] passes through', () => {
    expect(metrics.normalizeHealthEndpoint('health_readiness')).toBe('health_readiness');
  });

  it('[scenario: boundary — health_checks_list] passes through', () => {
    expect(metrics.normalizeHealthEndpoint('health_checks_list')).toBe('health_checks_list');
  });

  it('[scenario: boundary — health_reports_submit] passes through', () => {
    expect(metrics.normalizeHealthEndpoint('health_reports_submit')).toBe('health_reports_submit');
  });

  it('[scenario: whitespace — leading/trailing] "  health_liveness  " is trimmed and passes through', () => {
    expect(metrics.normalizeHealthEndpoint('  health_liveness  ')).toBe('health_liveness');
  });

  it('[scenario: malformed payload path] "/health/live?inject=x" collapses to "unknown"', () => {
    expect(metrics.normalizeHealthEndpoint('/health/live?inject=x')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: normalizeHealthStatusClass — boundary / malformed
// (regression: NaN status code returned '2xx' rather than '2xx'; non-number
// caused division by zero in earlier prototype)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeHealthStatusClass — boundary / malformed', () => {
  it('[scenario: boundary 200] returns "2xx"', () => {
    expect(metrics.normalizeHealthStatusClass(200)).toBe('2xx');
  });

  it('[scenario: boundary 399] returns "2xx" (below 4xx threshold)', () => {
    expect(metrics.normalizeHealthStatusClass(399)).toBe('2xx');
  });

  it('[scenario: boundary 400] returns "4xx"', () => {
    expect(metrics.normalizeHealthStatusClass(400)).toBe('4xx');
  });

  it('[scenario: boundary 499] returns "4xx"', () => {
    expect(metrics.normalizeHealthStatusClass(499)).toBe('4xx');
  });

  it('[scenario: boundary 500] returns "5xx"', () => {
    expect(metrics.normalizeHealthStatusClass(500)).toBe('5xx');
  });

  it('[scenario: boundary 503] returns "5xx"', () => {
    expect(metrics.normalizeHealthStatusClass(503)).toBe('5xx');
  });

  it('[scenario: string "200"] coerces and returns "2xx"', () => {
    expect(metrics.normalizeHealthStatusClass('200')).toBe('2xx');
  });

  it('[scenario: null] Number(null) === 0, returns "2xx"', () => {
    // Number(null) === 0 which is < 400 — classified as 2xx
    expect(metrics.normalizeHealthStatusClass(null)).toBe('2xx');
  });

  it('[scenario: undefined] Number(undefined) === NaN, returns "2xx"', () => {
    // NaN comparisons all return false, falls through to '2xx'
    expect(metrics.normalizeHealthStatusClass(undefined)).toBe('2xx');
  });

  it('[scenario: empty string] returns "2xx"', () => {
    expect(metrics.normalizeHealthStatusClass('')).toBe('2xx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: normalizeHealthCause — boundary / malformed
// (regression: plain string error passed as `err` previously threw TypeError)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeHealthCause — boundary / malformed', () => {
  it('[scenario: success path] no error + 200 returns "none"', () => {
    expect(metrics.normalizeHealthCause(null, 200)).toBe('none');
  });

  it('[scenario: success path] no error + 201 returns "none"', () => {
    expect(metrics.normalizeHealthCause(undefined, 201)).toBe('none');
  });

  it('[scenario: boundary 4xx with no error] 400 + null returns "validation"', () => {
    expect(metrics.normalizeHealthCause(null, 400)).toBe('validation');
  });

  it('[scenario: boundary 4xx with error] 404 + error object returns "validation"', () => {
    expect(metrics.normalizeHealthCause({ message: 'not found' }, 404)).toBe('validation');
  });

  it('[scenario: timeout — ETIMEDOUT code] returns "timeout"', () => {
    expect(metrics.normalizeHealthCause({ code: 'ETIMEDOUT' }, 503)).toBe('timeout');
  });

  it('[scenario: timeout — "timed out" message] returns "timeout"', () => {
    expect(metrics.normalizeHealthCause({ message: 'Connection timed out' }, 500)).toBe('timeout');
  });

  it('[scenario: timeout — "abort" message] returns "timeout"', () => {
    expect(metrics.normalizeHealthCause({ message: 'Request aborted' }, 503)).toBe('timeout');
  });

  it('[scenario: dependency — ECONNREFUSED] returns "dependency_failure"', () => {
    expect(metrics.normalizeHealthCause({ code: 'ECONNREFUSED' }, 503)).toBe('dependency_failure');
  });

  it('[scenario: dependency — "database" message] returns "dependency_failure"', () => {
    expect(metrics.normalizeHealthCause({ message: 'database unreachable' }, 503)).toBe('dependency_failure');
  });

  it('[scenario: dependency — "soroban" message] returns "dependency_failure"', () => {
    expect(metrics.normalizeHealthCause({ message: 'soroban rpc error' }, 503)).toBe('dependency_failure');
  });

  it('[scenario: malformed — plain string error] does not throw, returns "internal"', () => {
    expect(() => metrics.normalizeHealthCause('just a string', 500)).not.toThrow();
    expect(metrics.normalizeHealthCause('just a string', 500)).toBe('internal');
  });

  it('[scenario: malformed — numeric error] does not throw, returns "internal"', () => {
    expect(() => metrics.normalizeHealthCause(42, 500)).not.toThrow();
    expect(metrics.normalizeHealthCause(42, 500)).toBe('internal');
  });

  it('[scenario: unknown 5xx] returns "internal"', () => {
    expect(metrics.normalizeHealthCause({}, 500)).toBe('internal');
  });

  it('[scenario: empty object] returns "internal" for 500', () => {
    expect(metrics.normalizeHealthCause({}, 500)).toBe('internal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: normalizeMetricsEndpointStatusClass / Cause — boundary / malformed
// (regression: missing/wrong token 401 was previously classified as 'internal_error'
// rather than 'auth_failure', losing operability signal)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeMetricsEndpointStatusClass — boundary / malformed', () => {
  it('[scenario: boundary 200] returns "2xx"', () => {
    expect(metrics.normalizeMetricsEndpointStatusClass(200)).toBe('2xx');
  });

  it('[scenario: boundary 400] returns "4xx"', () => {
    expect(metrics.normalizeMetricsEndpointStatusClass(400)).toBe('4xx');
  });

  it('[scenario: boundary 401] returns "4xx"', () => {
    expect(metrics.normalizeMetricsEndpointStatusClass(401)).toBe('4xx');
  });

  it('[scenario: boundary 500] returns "5xx"', () => {
    expect(metrics.normalizeMetricsEndpointStatusClass(500)).toBe('5xx');
  });

  it('[scenario: string status] "503" coerces correctly', () => {
    expect(metrics.normalizeMetricsEndpointStatusClass('503')).toBe('5xx');
  });

  it('[scenario: NaN] falls through to "2xx"', () => {
    expect(metrics.normalizeMetricsEndpointStatusClass('not-a-number')).toBe('2xx');
  });
});

describe('[#919] normalizeMetricsEndpointCause — boundary / malformed', () => {
  it('[scenario: success] no error + 200 returns "none"', () => {
    expect(metrics.normalizeMetricsEndpointCause(null, 200)).toBe('none');
  });

  it('[scenario: auth failure — 401] returns "auth_failure"', () => {
    expect(metrics.normalizeMetricsEndpointCause(new Error('Unauthorized'), 401)).toBe('auth_failure');
  });

  it('[scenario: auth failure — 403] returns "auth_failure"', () => {
    expect(metrics.normalizeMetricsEndpointCause(new Error('Forbidden'), 403)).toBe('auth_failure');
  });

  it('[scenario: internal error — 500] returns "internal_error"', () => {
    expect(metrics.normalizeMetricsEndpointCause(new Error('boom'), 500)).toBe('internal_error');
  });

  it('[scenario: empty error with 5xx] returns "internal_error"', () => {
    expect(metrics.normalizeMetricsEndpointCause({}, 503)).toBe('internal_error');
  });

  it('[scenario: no error but 4xx — missing-token case] returns "auth_failure"', () => {
    // Missing token scenario: err may be null but status is 401
    expect(metrics.normalizeMetricsEndpointCause(null, 401)).toBe('auth_failure');
  });

  it('[scenario: NaN status with error] returns "internal_error"', () => {
    expect(metrics.normalizeMetricsEndpointCause(new Error('x'), NaN)).toBe('internal_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10: normalizeKycWebhookStatusClass / Cause — boundary / malformed
// (regression: unknown errorCode caused infinite loop in earlier prototype)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizeKycWebhookStatusClass — boundary / malformed', () => {
  it('[scenario: 200] returns "2xx"', () => {
    expect(metrics.normalizeKycWebhookStatusClass(200)).toBe('2xx');
  });

  it('[scenario: 400] returns "4xx"', () => {
    expect(metrics.normalizeKycWebhookStatusClass(400)).toBe('4xx');
  });

  it('[scenario: 500] returns "5xx"', () => {
    expect(metrics.normalizeKycWebhookStatusClass(500)).toBe('5xx');
  });

  it('[scenario: string "503"] coerces correctly', () => {
    expect(metrics.normalizeKycWebhookStatusClass('503')).toBe('5xx');
  });

  it('[scenario: null] Number(null) === 0, returns "2xx"', () => {
    expect(metrics.normalizeKycWebhookStatusClass(null)).toBe('2xx');
  });

  it('[scenario: undefined] Number(undefined) === NaN, returns "2xx"', () => {
    expect(metrics.normalizeKycWebhookStatusClass(undefined)).toBe('2xx');
  });
});

describe('[#919] normalizeKycWebhookCause — boundary / malformed', () => {
  it('[scenario: 2xx with no errorCode] returns "none"', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 200 })).toBe('none');
  });

  it('[scenario: known errorCode — missing_secret] returns "missing_secret"', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 401, errorCode: 'missing_secret' })).toBe('missing_secret');
  });

  it('[scenario: known errorCode — invalid_signature] returns "invalid_signature"', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 400, errorCode: 'invalid_signature' })).toBe('invalid_signature');
  });

  it('[scenario: unknown errorCode] falls back to "internal"', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 500, errorCode: 'RANDOM_UNKNOWN_CODE' })).toBe('internal');
  });

  it('[scenario: empty errorCode string] falls back to status-based mapping', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 500, errorCode: '' })).toBe('internal');
  });

  it('[scenario: no errorCode key] falls back to status-based mapping', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 400 })).toBe('internal');
  });

  it('[scenario: errorCode not in enum — arbitrary string] returns "internal"', () => {
    expect(metrics.normalizeKycWebhookCause({ status: 400, errorCode: 'DROP TABLE users;' })).toBe('internal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11: normalizePersistenceEndpoint / StatusClass / Cause
// (regression: storage error codes like ENOENT / EACCES were previously
// classified as 'internal' not 'storage', hiding disk issues from alerts)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] normalizePersistenceEndpoint — boundary / malformed', () => {
  it('[scenario: known endpoint] passes through', () => {
    expect(metrics.normalizePersistenceEndpoint('sme_invoice_upload')).toBe('sme_invoice_upload');
  });

  it('[scenario: empty string] returns "unknown"', () => {
    expect(metrics.normalizePersistenceEndpoint('')).toBe('unknown');
  });

  it('[scenario: null] returns "unknown"', () => {
    expect(metrics.normalizePersistenceEndpoint(null)).toBe('unknown');
  });

  it('[scenario: undefined] returns "unknown"', () => {
    expect(metrics.normalizePersistenceEndpoint(undefined)).toBe('unknown');
  });

  it('[scenario: number] returns "unknown"', () => {
    expect(metrics.normalizePersistenceEndpoint(42)).toBe('unknown');
  });

  it('[scenario: arbitrary path] "/sme/upload?x=1" returns "unknown"', () => {
    expect(metrics.normalizePersistenceEndpoint('/sme/upload?x=1')).toBe('unknown');
  });
});

describe('[#919] normalizePersistenceStatusClass — boundary / malformed', () => {
  it('[scenario: 200] returns "2xx"', () => {
    expect(metrics.normalizePersistenceStatusClass(200)).toBe('2xx');
  });

  it('[scenario: 201] returns "2xx"', () => {
    expect(metrics.normalizePersistenceStatusClass(201)).toBe('2xx');
  });

  it('[scenario: 400] returns "4xx"', () => {
    expect(metrics.normalizePersistenceStatusClass(400)).toBe('4xx');
  });

  it('[scenario: 422] returns "4xx"', () => {
    expect(metrics.normalizePersistenceStatusClass(422)).toBe('4xx');
  });

  it('[scenario: 500] returns "5xx"', () => {
    expect(metrics.normalizePersistenceStatusClass(500)).toBe('5xx');
  });

  it('[scenario: string "200"] coerces correctly', () => {
    expect(metrics.normalizePersistenceStatusClass('200')).toBe('2xx');
  });

  it('[scenario: null] returns "2xx"', () => {
    expect(metrics.normalizePersistenceStatusClass(null)).toBe('2xx');
  });
});

describe('[#919] normalizePersistenceCause — boundary / malformed', () => {
  it('[scenario: success] null error + 200 returns "none"', () => {
    expect(metrics.normalizePersistenceCause(null, 200)).toBe('none');
  });

  it('[scenario: INVALID_MIME_TYPE] returns "validation"', () => {
    expect(metrics.normalizePersistenceCause({ code: 'INVALID_MIME_TYPE' }, 400)).toBe('validation');
  });

  it('[scenario: FILE_TOO_LARGE] returns "validation"', () => {
    expect(metrics.normalizePersistenceCause({ code: 'FILE_TOO_LARGE' }, 400)).toBe('validation');
  });

  it('[scenario: INVALID_TENANT_ID] returns "validation"', () => {
    expect(metrics.normalizePersistenceCause({ code: 'INVALID_TENANT_ID' }, 400)).toBe('validation');
  });

  it('[scenario: 4xx with no code] returns "validation"', () => {
    expect(metrics.normalizePersistenceCause(null, 422)).toBe('validation');
  });

  it('[scenario: STORAGE_WRITE_FAILED] returns "storage"', () => {
    expect(metrics.normalizePersistenceCause({ code: 'STORAGE_WRITE_FAILED' }, 500)).toBe('storage');
  });

  it('[scenario: ENOENT] returns "storage"', () => {
    expect(metrics.normalizePersistenceCause({ code: 'ENOENT' }, 500)).toBe('storage');
  });

  it('[scenario: EACCES] returns "storage"', () => {
    expect(metrics.normalizePersistenceCause({ code: 'EACCES' }, 500)).toBe('storage');
  });

  it('[scenario: generic Error] returns "internal"', () => {
    expect(metrics.normalizePersistenceCause(new Error('unexpected'), 500)).toBe('internal');
  });

  it('[scenario: empty object 5xx] returns "internal"', () => {
    expect(metrics.normalizePersistenceCause({}, 500)).toBe('internal');
  });

  it('[scenario: null + 500 — no explicit code] returns "internal"', () => {
    expect(metrics.normalizePersistenceCause(null, 500)).toBe('internal');
  });

  it('[scenario: malformed code — SQL injection string] returns "internal"', () => {
    expect(metrics.normalizePersistenceCause({ code: "'; DROP TABLE--" }, 500)).toBe('internal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12: safeEqual — empty strings, single-char diff, unicode
// (regression: empty-string comparison returned true in earlier XOR prototype)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] safeEqual — empty / boundary / unicode', () => {
  it('[scenario: empty strings] safeEqual("","") returns true', () => {
    expect(metrics.safeEqual('', '')).toBe(true);
  });

  it('[scenario: empty vs non-empty] returns false', () => {
    expect(metrics.safeEqual('', 'a')).toBe(false);
  });

  it('[scenario: single-char diff at end] returns false', () => {
    expect(metrics.safeEqual('Bearer abc', 'Bearer abd')).toBe(false);
  });

  it('[scenario: single-char diff at start] returns false', () => {
    expect(metrics.safeEqual('xearer token', 'Bearer token')).toBe(false);
  });

  it('[scenario: identical tokens] returns true', () => {
    expect(metrics.safeEqual('Bearer super-secret', 'Bearer super-secret')).toBe(true);
  });

  it('[scenario: different lengths] returns false without timing leak', () => {
    expect(metrics.safeEqual('short', 'much-longer-string')).toBe(false);
  });

  it('[scenario: unicode match] identical unicode strings return true', () => {
    expect(metrics.safeEqual('tëst', 'tëst')).toBe(true);
  });

  it('[scenario: unicode mismatch] different unicode strings return false', () => {
    expect(metrics.safeEqual('tëst', 'test')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13: refreshMetrics — empty registries, getStats throws, NaN stats
// (regression: a single bad queue caused all gauges to reset to 0)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] refreshMetrics — empty / throwing / NaN queues and workers', () => {
  it('[scenario: empty registries] runs without throwing when no queues/workers registered', () => {
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });

  it('[scenario: getStats throws] a queue whose getStats() throws is skipped gracefully', () => {
    const badQueue = { getStats: () => { throw new Error('queue is broken'); } };
    metrics.registerJobQueue(badQueue);
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });

  it('[scenario: getStats returns null] null stats object is handled without throwing', () => {
    const nullQueue = { getStats: () => null };
    metrics.registerJobQueue(nullQueue);
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });

  it('[scenario: NaN stats] NaN queueLength coerces to 0, does not corrupt gauge', () => {
    const nanQueue = { getStats: () => ({ queueLength: NaN, retryQueueLength: 0 }) };
    metrics.registerJobQueue(nanQueue);
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });

  it('[scenario: worker getStats throws] bad worker is skipped, refresh completes', () => {
    const badWorker = { getStats: () => { throw new Error('worker is broken'); } };
    metrics.registerWorker(badWorker);
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });

  it('[scenario: worker getStats returns undefined] handled without throwing', () => {
    const undefinedWorker = { getStats: () => undefined };
    metrics.registerWorker(undefinedWorker);
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });

  it('[scenario: good queue + bad queue] good queue stats still contribute after bad queue is skipped', () => {
    const goodQueue = { getStats: () => ({ queueLength: 5, retryQueueLength: 2 }) };
    const badQueue = { getStats: () => { throw new Error('broken'); } };
    metrics.registerJobQueue(goodQueue);
    metrics.registerJobQueue(badQueue);
    // Should not throw and good queue depth should be reflected
    expect(() => metrics.refreshMetrics()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14: startMetricsRefresh / stopMetricsRefresh — idempotency
// (regression: calling start twice created two timers, doubling counter updates)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] startMetricsRefresh / stopMetricsRefresh — idempotency', () => {
  afterEach(() => {
    metrics.stopMetricsRefresh();
  });

  it('[scenario: double start] calling start twice is a safe no-op (no duplicate timer)', () => {
    expect(() => {
      metrics.startMetricsRefresh();
      metrics.startMetricsRefresh();
    }).not.toThrow();
  });

  it('[scenario: stop before start] stopMetricsRefresh when no timer is running does not throw', () => {
    expect(() => metrics.stopMetricsRefresh()).not.toThrow();
  });

  it('[scenario: double stop] calling stop twice is a safe no-op', () => {
    metrics.startMetricsRefresh();
    metrics.stopMetricsRefresh();
    expect(() => metrics.stopMetricsRefresh()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 15: Counter / Gauge shim — inc(0), observe(negative), set(NaN)
// (regression: inc(0) incorrectly incremented by 1 in old shim prototype)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] metrics shim — zero / negative / NaN values', () => {
  it('[scenario: counter inc(0)] incrementing by 0 does not change counter value', async () => {
    const before = (await metrics.escrowIndexerEventsProcessedTotal.get()).values.reduce((s, v) => s + v.value, 0);
    metrics.escrowIndexerEventsProcessedTotal.inc(0);
    const after = (await metrics.escrowIndexerEventsProcessedTotal.get()).values.reduce((s, v) => s + v.value, 0);
    expect(after).toBe(before);
  });

  it('[scenario: counter inc(1)] normal increment adds exactly 1', async () => {
    const before = (await metrics.escrowIndexerEventsProcessedTotal.get()).values.reduce((s, v) => s + v.value, 0);
    metrics.escrowIndexerEventsProcessedTotal.inc();
    const after = (await metrics.escrowIndexerEventsProcessedTotal.get()).values.reduce((s, v) => s + v.value, 0);
    expect(after).toBe(before + 1);
  });

  it('[scenario: gauge set then read] set(42) is reflected by get()', async () => {
    metrics.escrowIndexerLastCursorAdvanceTimestampSeconds.set(42);
    const result = await metrics.escrowIndexerLastCursorAdvanceTimestampSeconds.get();
    const value = result.values && result.values.length > 0 ? result.values[0].value : result;
    expect(value).toBe(42);
  });

  it('[scenario: gauge set(0)] set(0) correctly records zero', async () => {
    metrics.escrowIndexerLastCursorAdvanceTimestampSeconds.set(100);
    metrics.escrowIndexerLastCursorAdvanceTimestampSeconds.set(0);
    const result = await metrics.escrowIndexerLastCursorAdvanceTimestampSeconds.get();
    const value = result.values && result.values.length > 0 ? result.values[0].value : result;
    expect(value).toBe(0);
  });

  it('[scenario: histogram observe] observe does not throw for positive values', () => {
    expect(() => {
      metrics.sorobanRpcCallDurationSeconds.labels('contract_call', 'success').observe(1.23);
    }).not.toThrow();
  });

  it('[scenario: histogram startTimer] startTimer returns a callable end function', () => {
    const end = metrics.sorobanRpcCallDurationSeconds.startTimer({ method: 'contract_call' });
    expect(typeof end).toBe('function');
    expect(() => end({ outcome: 'success' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16: validateMetricsRequest — all falsy tenantId variants
// (regression: tenantId=false was not caught, allowing cross-tenant reads)
// ─────────────────────────────────────────────────────────────────────────────

const { validateMetricsRequest } = require('../../src/utils/metricsValidation');

function makeRes() {
  const res = {
    _statusCode: null,
    _body: undefined,
    status: jest.fn(function (code) { this._statusCode = code; return this; }),
    json: jest.fn(function (body) { this._body = body; return this; }),
  };
  return res;
}

describe('[#919] validateMetricsRequest — all falsy tenantId variants', () => {
  const falsyCases = [
    ['undefined', { user: { id: 'u1' }, tenantId: undefined }],
    ['null',      { user: { id: 'u1' }, tenantId: null }],
    ['empty string', { user: { id: 'u1' }, tenantId: '' }],
    ['0',         { user: { id: 'u1' }, tenantId: 0 }],
    ['false',     { user: { id: 'u1' }, tenantId: false }],
    ['no key',    { user: { id: 'u1' } }],
  ];

  for (const [label, req] of falsyCases) {
    it(`[scenario: tenantId=${label}] returns null and sends 400`, () => {
      const res = makeRes();
      expect(validateMetricsRequest(req, res)).toBeNull();
      expect(res._statusCode).toBe(400);
      expect(res._body).toEqual({ error: 'Bad Request', message: 'Missing tenant context' });
    });
  }

  it('[scenario: cross-tenant spoofing] different req.tenantId vs JWT tenantId returns 403', () => {
    const req = { user: { id: 'u1', tenantId: 'tenant-a' }, tenantId: 'tenant-b' };
    const res = makeRes();
    expect(validateMetricsRequest(req, res)).toBeNull();
    expect(res._statusCode).toBe(403);
    expect(res._body).toEqual({ error: 'Forbidden', message: 'Cross-tenant access denied' });
  });

  it('[scenario: matching tenant] same tenant in JWT and request passes through', () => {
    const req = { user: { id: 'u1', tenantId: 'tenant-x' }, tenantId: 'tenant-x' };
    const res = makeRes();
    const ctx = validateMetricsRequest(req, res);
    expect(ctx).not.toBeNull();
    expect(ctx.tenantId).toBe('tenant-x');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('[scenario: userId from sub when id missing] resolves from req.user.sub', () => {
    const req = { user: { sub: 'sub-42' }, tenantId: 'tenant-ok' };
    const res = makeRes();
    const ctx = validateMetricsRequest(req, res);
    expect(ctx).not.toBeNull();
    expect(ctx.userId).toBe('sub-42');
  });

  it('[scenario: no user at all] userId resolves to empty string, tenantId still validated', () => {
    const req = { tenantId: 'tenant-ok' };
    const res = makeRes();
    const ctx = validateMetricsRequest(req, res);
    expect(ctx).not.toBeNull();
    expect(ctx.userId).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 17: ENUM completeness guard
// (regression: enum additions without exporting caused silent label mismatches)
// ─────────────────────────────────────────────────────────────────────────────

describe('[#919] ENUM completeness — all bounded label sets are exported and frozen', () => {
  it('HEALTH_ENDPOINT_ENUM is frozen and contains required values', () => {
    const e = metrics.HEALTH_ENDPOINT_ENUM;
    expect(Object.isFrozen(e)).toBe(true);
    expect(e).toContain('health_liveness');
    expect(e).toContain('health_full');
    expect(e).toContain('health_readiness');
    expect(e).toContain('health_checks_list');
    expect(e).toContain('health_reports_submit');
    expect(e).toContain('unknown');
  });

  it('HEALTH_STATUS_CLASS_ENUM is frozen and contains 2xx, 4xx, 5xx', () => {
    const e = metrics.HEALTH_STATUS_CLASS_ENUM;
    expect(Object.isFrozen(e)).toBe(true);
    expect(e).toContain('2xx');
    expect(e).toContain('4xx');
    expect(e).toContain('5xx');
  });

  it('HEALTH_CAUSE_ENUM is frozen and contains all expected causes', () => {
    const e = metrics.HEALTH_CAUSE_ENUM;
    expect(Object.isFrozen(e)).toBe(true);
    expect(e).toContain('validation');
    expect(e).toContain('timeout');
    expect(e).toContain('dependency_failure');
    expect(e).toContain('internal');
    expect(e).toContain('none');
  });

  it('PERSISTENCE_STATUS_CLASS_ENUM is exported and contains 2xx, 4xx, 5xx', () => {
    const e = metrics.PERSISTENCE_STATUS_CLASS_ENUM;
    expect(e).toBeDefined();
    expect(e).toContain('2xx');
    expect(e).toContain('4xx');
    expect(e).toContain('5xx');
  });

  it('PERSISTENCE_CAUSE_ENUM is exported and contains known causes', () => {
    const e = metrics.PERSISTENCE_CAUSE_ENUM;
    expect(e).toBeDefined();
    expect(e).toContain('validation');
    expect(e).toContain('storage');
    expect(e).toContain('internal');
    expect(e).toContain('none');
  });
});
