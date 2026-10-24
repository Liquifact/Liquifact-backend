'use strict';

/**
 * @fileoverview Pull-based Soroban RPC escrow event indexer.
 *
 * `runOnce` pages through `server.getEvents` for the configured contract,
 * decodes known events, appends them to the EventStore, and persists the
 * cursor. Designed to be called from a cron trigger or a polling loop.
 *
 * First run: starts at INDEXER_START_LEDGER env var, or the RPC's
 * oldestLedger if the configured start ledger is older than what the node
 * still retains.
 *
 * Subsequent runs: resume from the stored cursor.
 *
 * @module indexer/escrow-indexer
 */

const { rpc } = require('@stellar/stellar-sdk');
const { decodeEvent } = require('./decode');
const { defaultStore } = require('./EventStore');
const logger = require('../logger');

/**
 * Build a Soroban RPC Server instance from config.
 * Lazily created so unit tests can inject their own server.
 *
 * @returns {rpc.Server}
 */
function buildRpcServer() {
  const url =
    process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') });
}

/**
 * Run one indexing pass: fetch up to `maxPages` pages of 100 events, decode
 * them, persist them in the EventStore, and advance the cursor.
 *
 * If an RPC error is thrown the cursor is left unchanged so the next run
 * retries from the same position.
 *
 * @param {object} [opts]
 * @param {number}     [opts.maxPages=5]     - Maximum pages to fetch per call.
 * @param {object}     [opts.server]         - Soroban RPC server (injected in tests).
 * @param {object}     [opts.store]          - EventStore (injected in tests).
 * @param {string}     [opts.contractId]     - Override contract id (default: env).
 * @param {object}     [opts.log]            - Logger (injected in tests).
 * @returns {Promise<{ ingested: number, cursor: string | null, latestLedger: number }>}
 */
async function runOnce({
  maxPages = 5,
  server,
  store,
  contractId,
  log,
} = {}) {
  const _server = server ?? buildRpcServer();
  const _store = store ?? defaultStore;
  const _log = log ?? logger;
  const _contractId =
    contractId ??
    process.env.SOROBAN_CONTRACT_ID ??
    process.env.ESCROW_CONTRACT_ID ??
    '';

  if (!_contractId) {
    throw new Error(
      'No contract id configured. Set SOROBAN_CONTRACT_ID or ESCROW_CONTRACT_ID.',
    );
  }

  let ingested = 0;
  let latestLedger = 0;
  let currentCursor = _store.getCursor();

  for (let page = 0; page < maxPages; page++) {
    /** @type {import('@stellar/stellar-sdk').rpc.GetEventsRequest} */
    const request = {
      filters: [
        {
          type: 'contract',
          contractIds: [_contractId],
        },
      ],
      limit: 100,
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
      response = await _server.getEvents(request);
    } catch (err) {
      _log.error({ err }, 'Soroban RPC getEvents failed; leaving cursor unchanged');
      throw err; // propagate so caller knows the run failed
    }

    latestLedger = response.latestLedger ?? latestLedger;

    // Clamp startLedger to oldestLedger if RPC rejected our start
    const oldestLedger = response.oldestLedger ?? 0;
    if (!currentCursor && request.startLedger && request.startLedger < oldestLedger) {
      _log.warn(
        { startLedger: request.startLedger, oldestLedger },
        'INDEXER_START_LEDGER is older than oldest retained ledger; clamping to oldestLedger',
      );
      // Retry this page with the clamped ledger
      request.startLedger = oldestLedger;
      try {
        response = await _server.getEvents(request);
      } catch (err) {
        _log.error({ err }, 'Soroban RPC getEvents (clamped) failed');
        throw err;
      }
      latestLedger = response.latestLedger ?? latestLedger;
    }

    const rawEvents = response.events ?? [];

    // Decode and append
    for (const raw of rawEvents) {
      try {
        const decoded = decodeEvent(raw);
        ingested += _store.append([decoded]);
      } catch (err) {
        _log.warn({ err, eventId: raw?.id }, 'Failed to decode event; skipping');
      }
    }

    // Advance cursor
    const newCursor = response.cursor ?? null;
    if (newCursor && newCursor !== currentCursor) {
      _store.setCursor(newCursor);
      currentCursor = newCursor;
    }

    // Stop paging if this page was not full (no more events available)
    if (rawEvents.length < 100) {
      break;
    }
  }

  return { ingested, cursor: _store.getCursor(), latestLedger };
}

module.exports = { runOnce, buildRpcServer };
