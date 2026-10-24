'use strict';

/**
 * @fileoverview In-memory EventStore for decoded Soroban escrow contract events.
 *
 * Design goals:
 * - Idempotent append: re-ingesting an event with the same id is a no-op.
 * - Bounded: capped at MAX_EVENTS entries; oldest entries evicted when the cap
 *   is reached (FIFO eviction). This prevents unbounded memory growth in a
 *   serverless / single-process environment.
 * - Cursor persistence: a single string cursor (Soroban RPC pagination token)
 *   is stored alongside the events.
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

  /** @type {string | null} */
  let cursor = null;

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
      }

      events.set(id, evt);
      appended++;
    }
    return appended;
  }

  /**
   * Return the current pagination cursor.
   *
   * @returns {string | null}
   */
  function getCursor() {
    return cursor;
  }

  /**
   * Persist a new cursor value.
   *
   * @param {string} newCursor
   * @returns {void}
   */
  function setCursor(newCursor) {
    cursor = String(newCursor);
  }

  /**
   * Query stored events with optional filters and pagination.
   *
   * @param {object} [params]
   * @param {string} [params.type]       - Filter by event type.
   * @param {string} [params.investor]   - Filter by investor address in data.
   * @param {number} [params.fromLedger] - Include only events at or after this ledger.
   * @param {number} [params.limit=50]   - Maximum results to return (1–200).
   * @param {string} [params.after]      - Return events after this event id (cursor-based pagination).
   * @returns {{ data: object[], nextCursor: string | null }}
   */
  function query({ type, investor, fromLedger, limit = 50, after } = {}) {
    const maxLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    const all = [...events.values()];

    // Cursor-based pagination: skip until we pass the `after` id
    let startIdx = 0;
    if (after) {
      const idx = all.findIndex((e) => e.id === after);
      if (idx !== -1) {
        startIdx = idx + 1;
      }
    }

    const slice = all.slice(startIdx);

    // Apply filters
    const filtered = slice.filter((evt) => {
      if (type && evt.type !== type) {return false;}
      if (investor && evt.data?.investor !== investor) {return false;}
      if (fromLedger != null && evt.ledger < Number(fromLedger)) {return false;}
      return true;
    });

    const page = filtered.slice(0, maxLimit);
    const nextCursor = filtered.length > maxLimit ? page[page.length - 1]?.id ?? null : null;

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
    cursor = null;
  }

  return { append, getCursor, setCursor, query, size, clear };
}

/** Singleton store shared across the process lifetime. */
const defaultStore = createEventStore();

module.exports = { createEventStore, defaultStore };
