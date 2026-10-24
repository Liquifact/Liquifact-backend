'use strict';

/**
 * Tamper-evident, append-only audit log.
 *
 * Every entry carries `prevHash` (the hash of the entry before it) and its own
 * `hash`, where
 *
 *   hash = sha256(prevHash + canonicalJSON(entryWithoutHash))
 *
 * so changing, deleting or reordering any retained entry breaks the chain from
 * that point on and `verifyChain` reports the first sequence number that fails.
 * The first entry ever written links to GENESIS_HASH.
 *
 * Entries are sanitised before they are hashed: secrets are dropped, client IPs
 * are truncated and oversized fields are cut down, so nothing sensitive is ever
 * stored or hashed.
 *
 * Known limit (durable storage and external anchoring are out of scope): the
 * newest entries can be dropped, or the whole retained chain rewritten
 * consistently, by anyone with write access to the underlying store. The HTTP
 * API exposes no way to do either.
 */

const crypto = require('crypto');
const net = require('net');
const config = require('../config');

const GENESIS_HASH = '0'.repeat(64);
const OUTCOMES = ['success', 'rejected'];

const MAX_DEPTH = 6;
const MAX_STRING = 512;
const MAX_ARRAY = 50;
const MAX_FIELD_CHARS = 2048;
const MAX_ID_CHARS = 128;

/** Keys whose values are never stored (matched anywhere in the key, any case). */
const SENSITIVE_KEY =
  /authorization|api[-_]?key|secret|seed|passw(or)?d|token|cookie|private[-_]?key|mnemonic/i;
const BEARER_VALUE = /^\s*(bearer|basic)\s+\S+/i;

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` omitted.
 * Used for hashing only.
 *
 * @param {*} value JSON-compatible value
 * @returns {string} canonical JSON text
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
  }
  return `{${parts.join(',')}}`;
}

/**
 * Makes a value JSON-safe and strips secrets: sensitive keys are dropped at
 * every depth, bearer/basic credentials are masked, long strings and arrays are
 * clipped and anything deeper than MAX_DEPTH is cut off (which also stops
 * circular structures).
 *
 * @param {*} value anything
 * @param {number} [depth] current depth (internal)
 * @returns {*} JSON-compatible, secret-free copy
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) {
    return null;
  }
  switch (typeof value) {
    case 'string':
      if (BEARER_VALUE.test(value)) {
        return '[redacted]';
      }
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (!SENSITIVE_KEY.test(key) && value[key] !== undefined && typeof value[key] !== 'function') {
      out[key] = redact(value[key], depth + 1);
    }
  }
  return out;
}

/**
 * Expands an IPv6 address into its eight 16-bit groups.
 *
 * @param {string} address valid IPv6 text
 * @returns {number[]} eight groups
 */
function ipv6Groups(address) {
  let addr = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    addr = `${addr.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const first = head ? head.split(':') : [];
  if (tail === undefined) {
    return first.map((g) => parseInt(g, 16));
  }
  const last = tail ? tail.split(':') : [];
  const zeros = new Array(8 - first.length - last.length).fill('0');
  return [...first, ...zeros, ...last].map((g) => parseInt(g, 16));
}

/**
 * Truncates a client IP for privacy: IPv4 to its /24, IPv6 to its /48.
 * IPv4-mapped IPv6 addresses are treated as IPv4.
 *
 * @param {string} ip raw client address
 * @returns {string|null} truncated CIDR text, or null if not an IP
 */
function truncateIp(ip) {
  if (typeof ip !== 'string') {
    return null;
  }
  let addr = ip.trim().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) {
    addr = mapped[1];
  }
  if (net.isIPv4(addr)) {
    const p = addr.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (net.isIPv6(addr)) {
    const g = ipv6Groups(addr);
    return `${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}::/48`;
  }
  return null;
}

/**
 * @param {object} entryWithoutHash entry fields excluding `hash`
 * @returns {string} sha256 hex of prevHash + canonicalJSON(entryWithoutHash)
 */
function computeHash(entryWithoutHash) {
  return crypto
    .createHash('sha256')
    .update(String(entryWithoutHash.prevHash) + canonicalJson(entryWithoutHash))
    .digest('hex');
}

/**
 * Verifies a list of entries (oldest first). The first entry's `prevHash` is
 * the anchor, so a log whose oldest entries were evicted still verifies; when
 * that first entry is seq 1 its `prevHash` must be GENESIS_HASH.
 *
 * @param {object[]} entries entries, oldest first
 * @returns {{ valid: true, entries: number } | { valid: false, brokenAt: number }} result
 */
function verifyChain(entries) {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const previous = i > 0 ? entries[i - 1] : null;
    const brokenAt = entry && Number.isInteger(entry.seq) ? entry.seq : i + 1;
    if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
      return { valid: false, brokenAt };
    }
    if (previous && entry.seq !== previous.seq + 1) {
      return { valid: false, brokenAt };
    }
    if (previous ? entry.prevHash !== previous.hash : entry.seq === 1 && entry.prevHash !== GENESIS_HASH) {
      return { valid: false, brokenAt };
    }
    const { hash, ...rest } = entry;
    if (computeHash(rest) !== hash) {
      return { valid: false, brokenAt };
    }
  }
  return { valid: true, entries: entries.length };
}

/**
 * @param {*} value entry or nested value
 * @returns {*} the same value, deeply frozen
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/**
 * Bounded in-memory store. Keeps the most recent `maxEntries` entries; older
 * ones are evicted. Stored entries are deeply frozen and reads return a copy of
 * the list, so callers cannot edit history through it.
 *
 * Store interface (synchronous): last(), append(entry), entries(), size().
 *
 * @param {{ maxEntries?: number }} [options] store options
 * @returns {{ last: Function, append: Function, entries: Function, size: Function, resetForTests: Function }} store
 */
function createMemoryStore({ maxEntries = 10000 } = {}) {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 10000;
  let items = [];
  return {
    last: () => (items.length ? items[items.length - 1] : null),
    append(entry) {
      items.push(deepFreeze(entry));
      if (items.length > limit) {
        items = items.slice(items.length - limit);
      }
    },
    entries: () => items.slice(),
    size: () => items.length,
    /** Empties the store. Not reachable from the HTTP API; tests only. */
    resetForTests() {
      items = [];
    },
  };
}

/**
 * @param {*} value field value
 * @returns {*} sanitised value, or a marker when it is still too large
 */
function sanitiseField(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const clean = redact(value);
  return canonicalJson(clean).length > MAX_FIELD_CHARS ? { truncated: true } : clean;
}

/**
 * @param {*} value identifier-like value
 * @returns {string|null} clipped string, or null
 */
function sanitiseId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return String(redact(String(value))).slice(0, MAX_ID_CHARS);
}

/**
 * Creates an audit log on top of a store.
 *
 * @param {{ store?: object, now?: () => Date }} [options] store and clock
 * @returns {object} log with append, entries, query, verify
 */
function createAuditLog({ store = createMemoryStore(), now = () => new Date() } = {}) {
  return {
    store,

    /**
     * Appends one entry to the chain.
     *
     * @param {object} input audit event
     * @param {string} input.action e.g. "invoice.fund"
     * @param {string} input.resourceType e.g. "invoice"
     * @param {string} [input.resourceId] affected resource
     * @param {string} [input.actor] who acted ("anonymous" if unknown)
     * @param {string} [input.ip] raw client IP (stored truncated)
     * @param {string} [input.requestId] correlation id
     * @param {'success'|'rejected'} input.outcome result of the attempt
     * @param {number} input.statusCode HTTP status returned
     * @param {object} [input.before] state before the change
     * @param {object} [input.after] state after the change
     * @param {object} [input.metadata] extra context
     * @returns {object} the stored entry
     */
    append(input) {
      const { action, resourceType, outcome, statusCode } = input || {};
      if (typeof action !== 'string' || !action || typeof resourceType !== 'string' || !resourceType) {
        throw new TypeError('audit entry needs a non-empty action and resourceType');
      }
      if (!OUTCOMES.includes(outcome)) {
        throw new TypeError(`audit outcome must be one of ${OUTCOMES.join(', ')}`);
      }
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        throw new TypeError('audit statusCode must be an HTTP status code');
      }
      const last = store.last();
      const entry = {
        seq: last ? last.seq + 1 : 1,
        at: now().toISOString(),
        action,
        resourceType,
        resourceId: sanitiseId(input.resourceId),
        actor: sanitiseId(input.actor) || 'anonymous',
        ip: truncateIp(input.ip),
        requestId: sanitiseId(input.requestId),
        outcome,
        statusCode,
        before: sanitiseField(input.before),
        after: sanitiseField(input.after),
        metadata: sanitiseField(input.metadata),
        prevHash: last ? last.hash : GENESIS_HASH,
      };
      entry.hash = computeHash(entry);
      store.append(entry);
      return entry;
    },

    /** @returns {object[]} retained entries, oldest first */
    entries: () => store.entries(),

    /**
     * Filters retained entries and returns one page, oldest first.
     *
     * @param {{ resourceId?: string, action?: string, limit?: number, after?: number }} [filter] query
     * @returns {{ data: object[], nextAfter: number|null }} page and cursor for the next one
     */
    query({ resourceId, action, limit = 50, after = 0 } = {}) {
      const matches = store
        .entries()
        .filter(
          (e) =>
            e.seq > after &&
            (resourceId === undefined || e.resourceId === resourceId) &&
            (action === undefined || e.action === action),
        );
      const data = matches.slice(0, limit);
      return { data, nextAfter: data.length && matches.length > limit ? data[data.length - 1].seq : null };
    },

    /** @returns {object} verifyChain result for the retained entries */
    verify: () => verifyChain(store.entries()),

    /** Empties the log. Not reachable from the HTTP API; tests only. */
    resetForTests() {
      if (typeof store.resetForTests === 'function') {
        store.resetForTests();
      }
    },
  };
}

const auditLog = createAuditLog({ store: createMemoryStore({ maxEntries: config.auditMaxEntries }) });

module.exports = {
  GENESIS_HASH,
  canonicalJson,
  computeHash,
  verifyChain,
  redact,
  truncateIp,
  createMemoryStore,
  createAuditLog,
  auditLog,
  append: (input) => auditLog.append(input),
};
