'use strict';

/**
 * @fileoverview Pull-based Soroban RPC escrow event indexer.
 *
 * `runOnce` indexes events for every escrow contract the backend knows about:
 * the configured default contract (`SOROBAN_CONTRACT_ID` / `config.contractId`)
 * plus every distinct `escrowContractId` linked to an invoice in the data
 * store. Contract ids are sorted and grouped into chunks of at most five,
 * because Soroban RPC accepts at most five `contractIds` per filter. Each chunk
 * is paged through `server.getEvents`, decoded, appended to the EventStore, and
 * its cursor is persisted independently.
 *
 * Cursor / watermark strategy
 * ───────────────────────────
 * Every chunk owns a cursor keyed by its sorted contract-id list. A chunk
 * resumes from its own cursor on the next run, so adding a new linked contract
 * only re-scans the chunk(s) whose membership changed rather than every
 * contract. Re-scanned events cannot duplicate stored data because the
 * EventStore append is idempotent by event id, and no window is skipped because
 * a re-planned chunk starts from `INDEXER_START_LEDGER` (or `oldestLedger`).
 * When only one contract is configured the indexer keeps using the EventStore's
 * default cursor, preserving the original single-contract behaviour.
 *
 * First run of a chunk: starts at `INDEXER_START_LEDGER`, or the RPC's
 * `oldestLedger` when the configured start ledger is older than what the node
 * still retains.
 *
 * @module indexer/escrow-indexer
 */

const { decodeEvent } = require('./decode');
const { defaultStore } = require('./EventStore');
const { getRpcServer } = require('../stellar/rpc');
const dataStore = require('../data/store');
const logger = require('../logger');
const config = require('../config');

/** Soroban RPC allows at most this many contract ids per event filter. */
const MAX_CONTRACT_IDS_PER_FILTER = 5;

/** Maximum events the RPC returns per page. */
const PAGE_LIMIT = 100;

/**
 * Return the shared Soroban RPC Server instance.
 *
 * @returns {import('@stellar/stellar-sdk').rpc.Server}
 */
function buildRpcServer() {
  return getRpcServer();
}

/**
 * Collect the distinct escrow contract ids to index.
 *
 * An explicit `contractId` option is authoritative (used by operator tooling
 * and tests) and is not merged with the data store. Otherwise the default
 * contract is combined with every distinct `escrowContractId` linked to an
 * invoice.
 *
 * @param {object} [opts]
 * @param {string} [opts.contractId] - Explicit contract id override.
 * @param {object} [opts.data] - Invoice data store (injected in tests).
 * @returns {string[]} distinct, sorted contract ids.
 */
function collectContractIds({ contractId, data } = {}) {
  if (contractId !== undefined) {
    const trimmed = String(contractId).trim();
    return trimmed ? [trimmed] : [];
  }

  const ids = new Set();
  const configured = String(
    process.env.SOROBAN_CONTRACT_ID ?? config.contractId ?? '',
  ).trim();
  if (configured) {
    ids.add(configured);
  }

  const invoices = data && typeof data.list === 'function' ? data.list() : [];
  for (const invoice of invoices) {
    const linked = String(invoice?.escrowContractId ?? '').trim();
    if (linked) {
      ids.add(linked);
    }
  }

  return [...ids].sort();
}

/**
 * Split contract ids into chunks of at most `size`.
 *
 * @param {string[]} contractIds
 * @param {number} [size=MAX_CONTRACT_IDS_PER_FILTER]
 * @returns {string[][]}
 */
function chunkContractIds(contractIds, size = MAX_CONTRACT_IDS_PER_FILTER) {
  const chunks = [];
  for (let i = 0; i < contractIds.length; i += size) {
    chunks.push(contractIds.slice(i, i + size));
  }
  return chunks;
}

/**
 * Cursor key for a chunk. A single-contract run keeps using the EventStore's
 * default cursor so existing single-contract behaviour (and cursors) is
 * unchanged.
 *
 * @param {string[]} chunk - contract ids in the chunk
 * @param {number} totalContracts - total number of contracts being indexed
 * @returns {string | undefined} cursor key, or undefined for the default cursor
 */
function cursorKeyForChunk(chunk, totalContracts) {
  if (totalContracts <= 1) {
    return undefined;
  }
  return `chunk:${chunk.join(',')}`;
}

/**
 * Index one chunk of contract ids, advancing only that chunk's cursor.
 *
 * If an RPC error is thrown the chunk's cursor is left unchanged so the next
 * run retries from the same position; chunks already processed keep their
 * advanced cursors.
 *
 * @param {object} opts
 * @param {object} opts.server - Soroban RPC server.
 * @param {object} opts.store - EventStore.
 * @param {object} opts.log - Logger.
 * @param {string[]} opts.contractIds - Contract ids for this chunk.
 * @param {string|undefined} opts.cursorKey - Cursor key for this chunk.
 * @param {number} opts.maxPages - Maximum pages to fetch for this chunk.
 * @returns {Promise<{ ingested: number, cursor: string | null, latestLedger: number }>}
 */
async function indexChunk({ server, store, log, contractIds, cursorKey, maxPages }) {
  let ingested = 0;
  let skipped = 0;
  let decodeFailures = 0;
  let latestLedger = 0;
  let currentCursor = store.getCursor(cursorKey);

  for (let page = 0; page < maxPages; page++) {
    /** @type {import('@stellar/stellar-sdk').rpc.GetEventsRequest} */
    const request = {
      filters: [
        {
          type: 'contract',
          contractIds,
        },
      ],
      limit: PAGE_LIMIT,
    };

    if (currentCursor) {
      request.cursor = currentCursor;
    } else {
      // First run: use INDEXER_START_LEDGER or oldestLedger (resolved below)
      const startLedger = parseInt(process.env.INDEXER_START_LEDGER || '0', 10);
      request.startLedger = startLedger > 0 ? startLedger : undefined;
    }

    let response;
    try {
      response = await server.getEvents(request);
    } catch (err) {
      log.error({ err, contractIds }, 'Soroban RPC getEvents failed; leaving cursor unchanged');
      throw err; // propagate so caller knows the run failed
    }

    latestLedger = response.latestLedger ?? latestLedger;

    // Clamp startLedger to oldestLedger if RPC rejected our start
    const oldestLedger = response.oldestLedger ?? 0;
    if (!currentCursor && request.startLedger && request.startLedger < oldestLedger) {
      log.warn(
        { startLedger: request.startLedger, oldestLedger },
        'INDEXER_START_LEDGER is older than oldest retained ledger; clamping to oldestLedger',
      );
      // Retry this page with the clamped ledger
      request.startLedger = oldestLedger;
      try {
        response = await server.getEvents(request);
      } catch (err) {
        log.error({ err }, 'Soroban RPC getEvents (clamped) failed');
        throw err;
      }
      latestLedger = response.latestLedger ?? latestLedger;
    }

    const rawEvents = response.events ?? [];
    // Only a single-contract chunk has an unambiguous fallback contract id;
    // multi-contract responses carry their own `contractId`.
    const fallbackContractId = contractIds.length === 1 ? contractIds[0] : undefined;

    // Decode and append
    for (const raw of rawEvents) {
      try {
        const decoded = decodeEvent(raw, fallbackContractId);
        ingested += store.append([decoded]);
      } catch (err) {
        log.warn({ err, eventId: raw?.id }, 'Failed to decode event; skipping');
      }
    }

    // Advance this chunk's cursor
    const newCursor = response.cursor ?? null;
    if (newCursor && newCursor !== currentCursor) {
      store.setCursor(newCursor, cursorKey);
      currentCursor = newCursor;
    }

    // Stop paging if this page was not full (no more events available)
    if (rawEvents.length < PAGE_LIMIT) {
      break;
    }
  }

  return { ingested, cursor: store.getCursor(cursorKey), latestLedger };
}

/**
 * Run one indexing pass over every linked escrow contract. Contract ids are
 * chunked into groups of five per RPC filter; each chunk is paged up to
 * `maxPages` pages of 100 events, decoded, persisted, and its cursor advanced.
 *
 * @param {object} [opts]
 * @param {number}     [opts.maxPages=5]     - Maximum pages per chunk per call.
 * @param {object}     [opts.server]         - Soroban RPC server (injected in tests).
 * @param {object}     [opts.store]          - EventStore (injected in tests).
 * @param {string}     [opts.contractId]     - Override contract id (default: configured + linked).
 * @param {object}     [opts.data]           - Invoice data store (injected in tests).
 * @param {object}     [opts.log]            - Logger (injected in tests).
 * @returns {Promise<{
 *   ingested: number,
 *   cursor: string | null,
 *   cursors: Record<string, string | null>,
 *   contracts: string[],
 *   latestLedger: number,
 * }>}
 */
async function runOnce({
  maxPages = 5,
  server,
  store,
  contractId,
  data,
  log,
} = {}) {
  const _server = server ?? buildRpcServer();
  const _store = store ?? defaultStore;
  const _log = log ?? logger;
  const _data = data ?? dataStore;

  const contracts = collectContractIds({ contractId, data: _data });

  if (contracts.length === 0) {
    throw new Error(
      'No contract id configured. Set SOROBAN_CONTRACT_ID or ESCROW_CONTRACT_ID.',
    );
  }

  const chunks = chunkContractIds(contracts);

  let ingested = 0;
  let latestLedger = 0;
  /** @type {Record<string, string | null>} */
  const cursors = {};
  let lastCursor = null;

  for (const chunk of chunks) {
    const cursorKey = cursorKeyForChunk(chunk, contracts.length);
    const result = await indexChunk({
      server: _server,
      store: _store,
      log: _log,
      contractIds: chunk,
      cursorKey,
      maxPages,
    });
    ingested += result.ingested;
    latestLedger = result.latestLedger || latestLedger;
    lastCursor = result.cursor;
    cursors[cursorKey ?? 'default'] = result.cursor;
  }

  return {
    ingested,
    cursor: contracts.length <= 1 ? _store.getCursor() : lastCursor,
    cursors,
    contracts,
    latestLedger,
  };
}

module.exports = {
  runOnce,
  buildRpcServer,
  collectContractIds,
  chunkContractIds,
  MAX_CONTRACT_IDS_PER_FILTER,
};
