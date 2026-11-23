'use strict';

/**
 * @fileoverview In-memory EventStore for decoded Soroban escrow contract events.
 *
 * Design goals:
 * - Idempotent append: re-ingesting an event with the same id is a no-op.
 * - Bounded: capped at MAX_EVENTS entries; oldest entries evicted when the cap
 *   is reached (FIFO eviction). This prevents unbounded memory growth in a
 *   serverless / single-process environment.
 * - Cursor persistence: Soroban RPC pagination tokens are stored per cursor
 *   key. The default key holds the cursor for the single configured contract;
 *   multi-contract indexing stores one cursor per contract chunk (see
 *   `src/indexer/escrow-indexer.js`).
 *
 * Cap and eviction
 * ────────────────
 * MAX_EVENTS defaults to 10 000. When the store is full and a new (non-duplicate)
 * event arrives, the oldest event by insertion order is removed before the new
 * one is added. This keeps memory use predictable while always retaining the
 * most-recent events. The cap can be overridden at construction time for tests.
 *
 * @module indexer/EventStore
 */

const DEFAULT_MAX_EVENTS = 10_000;

/** Cursor key used when the caller does not scope the cursor to a chunk. */
const DEFAULT_CURSOR_KEY = '__default__';

/**
 * Create a new in-memory EventStore instance.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxEvents=10000] - Maximum number of events to retain.
 * @returns {EventStore}
 */
function createEventStore({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  /** @type {Map<string, object>} event id → decoded event */
  const events = new Map();

  /** @type {Map<string, number>} event id → insertion sequence */
  const sequenceById = new Map();

  /** @type {Map<number, string>} insertion sequence → event id */
  const idBySequence = new Map();
  let nextSequence = 0;

  /** @type {Map<string, string>} cursor key → Soroban RPC pagination token */
  const cursors = new Map();

  /**
   * Append decoded events idempotently.
   * Events whose id is already stored are silently skipped.
   * If the store would exceed maxEvents, oldest entries are evicted first.
   *
   * @param {object[]} newEvents - Decoded events from the indexer.
   * @returns {number} Number of events actually appended (0 for pure duplicates).
   */
  function append(newEvents) {
    if (!Array.isArray(newEvents)) {return 0;}
    let appended = 0;
    for (const evt of newEvents) {
      const id = String(evt.id ?? '');
      if (!id) {continue;}
      if (events.has(id)) {continue;} // idempotent: skip duplicates

      // Evict oldest entry if at cap
      if (events.size >= maxEvents) {
        const oldestKey = events.keys().next().value;
        events.delete(oldestKey);
        const oldestSequence = sequenceById.get(oldestKey);
        sequenceById.delete(oldestKey);
        idBySequence.delete(oldestSequence);
      }

      events.set(id, evt);
      sequenceById.set(id, nextSequence);
      idBySequence.set(nextSequence, id);
      nextSequence++;
      appended++;
    }
    return appended;
  }

  /**
   * Return the pagination cursor for a key.
   *
   * @param {string} [key] cursor key (defaults to the single-contract cursor)
   * @returns {string | null}
   */
  function getCursor(key = DEFAULT_CURSOR_KEY) {
    return cursors.get(key) ?? null;
  }

  /**
   * Persist a new cursor value for a key.
   *
   * @param {string} newCursor
   * @param {string} [key] cursor key (defaults to the single-contract cursor)
   * @returns {void}
   */
  function setCursor(newCursor, key = DEFAULT_CURSOR_KEY) {
    cursors.set(key, String(newCursor));
  }

  /**
   * Query stored events with optional filters and pagination.
   *
   * @param {object} [params]
   * @param {string} [params.type]       - Filter by event type.
   * @param {string} [params.investor]   - Filter by investor address in data.
   * @param {string} [params.contractId] - Filter by originating escrow contract id.
   * @param {number} [params.fromLedger] - Include only events at or after this ledger.
   * @param {number} [params.limit=50]   - Maximum results to return (1–200).
   * @param {string} [params.after]      - Return events after this event id (cursor-based pagination).
   * @returns {{ data: object[], nextCursor: string | null }}
   */
  function query({ type, investor, contractId, fromLedger, limit = 50, after } = {}) {
    const maxLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    let startSequence = idBySequence.keys().next().value ?? nextSequence;
    if (after) {
      const cursorSequence = sequenceById.get(after);
      if (cursorSequence === undefined) {
        return { error: 'INVALID_CURSOR' };
      }
      startSequence = cursorSequence + 1;
    }

    const matches = [];
    for (let sequence = startSequence; sequence < nextSequence && matches.length <= maxLimit; sequence++) {
      const id = idBySequence.get(sequence);
      if (id === undefined) {continue;}
      const evt = events.get(id);
      if (!evt) {continue;}
      if (type && evt.type !== type) {continue;}
      if (investor && evt.data?.investor !== investor) {continue;}
      if (contractId && evt.contractId !== contractId) {continue;}
      if (fromLedger != null && evt.ledger < Number(fromLedger)) {continue;}
      matches.push(evt);
    }

    const page = matches.slice(0, maxLimit);
    const nextCursor = matches.length > maxLimit ? page[page.length - 1]?.id ?? null : null;

    return { data: page, nextCursor };
  }

  /**
   * Return the total number of stored events (for diagnostics).
   *
   * @returns {number}
   */
  function size() {
    return events.size;
  }

  /**
   * Clear all stored events and reset the cursor. Useful in tests.
   *
   * @returns {void}
   */
  function clear() {
    events.clear();
    sequenceById.clear();
    idBySequence.clear();
    cursors.clear();
  }

  return { append, getCursor, setCursor, query, size, clear };
}

/** Singleton store shared across the process lifetime. */
const defaultStore = createEventStore();

module.exports = { createEventStore, defaultStore, DEFAULT_CURSOR_KEY };
