'use strict';

/**
 * @fileoverview In-memory DocumentStore for invoice PDF uploads.
 *
 * Stores raw PDF bytes alongside metadata. Bounded at MAX_DOCS (default 50)
 * entries with LRU eviction: when the cap is reached and a new document
 * arrives, the least-recently-used entry is removed first.
 *
 * @module data/documentStore
 */

const DEFAULT_MAX_DOCS = 50;

/**
 * Create a new DocumentStore instance.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxDocs=50] - Maximum number of documents to retain.
 * @returns {DocumentStore}
 */
function createDocumentStore({ maxDocs = DEFAULT_MAX_DOCS } = {}) {
  /**
   * Map from invoiceId → { meta, buffer }.
   * Map insertion-order tracks LRU: most-recently used moves to the end.
   *
   * @type {Map<string, { meta: object, buffer: Buffer }>}
   */
  const store = new Map();

  /**
   * Promote an entry to most-recently-used position.
   *
   * @param {string} invoiceId
   */
  function _touch(invoiceId) {
    const entry = store.get(invoiceId);
    if (entry) {
      store.delete(invoiceId);
      store.set(invoiceId, entry);
    }
  }

  /**
   * Evict the least-recently-used entry when over capacity.
   */
  function _evictIfNeeded() {
    if (store.size >= maxDocs) {
      const lruKey = store.keys().next().value;
      store.delete(lruKey);
    }
  }

  /**
   * Store a document. If the store is full, the LRU entry is evicted first.
   * Calling save() for an existing invoiceId replaces it (idempotent).
   *
   * @param {string} invoiceId
   * @param {{ sha256Hex: string, sizeBytes: number, uploadedAt: string, originalName: string }} meta
   * @param {Buffer} buffer - Raw PDF bytes.
   * @returns {void}
   */
  function save(invoiceId, meta, buffer) {
    if (store.has(invoiceId)) {
      store.delete(invoiceId);
    } else {
      _evictIfNeeded();
    }
    store.set(invoiceId, { meta, buffer });
  }

  /**
   * Retrieve document metadata without the bytes.
   *
   * @param {string} invoiceId
   * @returns {{ sha256Hex: string, sizeBytes: number, uploadedAt: string, originalName: string } | null}
   */
  function getMeta(invoiceId) {
    const entry = store.get(invoiceId);
    if (!entry) { return null; }
    _touch(invoiceId);
    return entry.meta;
  }

  /**
   * Retrieve the raw PDF buffer.
   *
   * @param {string} invoiceId
   * @returns {Buffer | null}
   */
  function getBuffer(invoiceId) {
    const entry = store.get(invoiceId);
    if (!entry) { return null; }
    _touch(invoiceId);
    return entry.buffer;
  }

  /**
   * Check whether a document exists for the invoice.
   *
   * @param {string} invoiceId
   * @returns {boolean}
   */
  function has(invoiceId) {
    return store.has(invoiceId);
  }

  /**
   * Remove a document (useful in tests).
   *
   * @param {string} invoiceId
   * @returns {void}
   */
  function remove(invoiceId) {
    store.delete(invoiceId);
  }

  /**
   * Clear all documents (used by tests).
   *
   * @returns {void}
   */
  function clear() {
    store.clear();
  }

  /**
   * Number of stored documents.
   *
   * @returns {number}
   */
  function size() {
    return store.size;
  }

  return { save, getMeta, getBuffer, has, remove, clear, size };
}

/** Singleton store shared across the process lifetime. */
const defaultDocumentStore = createDocumentStore();

module.exports = { createDocumentStore, defaultDocumentStore };
