'use strict';

const db = require('../db/knex');
const logger = require('../logger');
const {
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
} = require('../metrics');

const INVOICE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 100;

/**
 * Attempts to derive a usable invoice ID from a Horizon/Soroban contract event
 * record, in priority order:
 *
 *   1. An explicit `invoice_id` / `invoiceId` field on the record.
 *   2. The LiquifactEscrow event payload — the `value` body or a `topic`/
 *      `topics` entry explicitly labelled with an invoice field. Bare topic
 *      symbols (e.g. the event-name symbol) are not treated as invoice IDs.
 *   3. Reverse lookup of the emitting contract address through escrowMap.
 *
 * The derived value is validated against INVOICE_ID_REGEX; anything that does
 * not match (including the bare contract address) yields null so the caller can
 * skip the event rather than mis-key the projection by contract address.
 *
 * @param {object} record - Raw Horizon contract event record.
 * @param {(address: string) => (string|null)} [reverseLookup] - Address->invoiceId resolver.
 * @returns {string|null} A valid invoice ID, or null if none can be resolved.
 */
function deriveInvoiceId(record, reverseLookup = resolveInvoiceByAddress) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const isValid = (candidate) => {
    if (candidate === null || candidate === undefined) {
      return null;
    }
    const value = String(candidate).trim();
    return INVOICE_ID_REGEX.test(value) ? value : null;
  };

  // 1. Explicit field on the record.
  const explicit = isValid(record.invoice_id) || isValid(record.invoiceId);
  if (explicit) {
    return explicit;
  }

  // 2. LiquifactEscrow event payload: value body and topics.
  const body = record.value;
  if (body && typeof body === 'object') {
    const fromBody = isValid(body.invoice_id) || isValid(body.invoiceId);
    if (fromBody) {
      return fromBody;
    }
  }

  const topics = Array.isArray(record.topics)
    ? record.topics
    : Array.isArray(record.topic)
      ? record.topic
      : [];
  for (const topic of topics) {
    if (topic && typeof topic === 'object') {
      // Only trust explicitly-labelled invoice fields in a topic entry. The
      // first topic in a LiquifactEscrow event is the event-name symbol, so
      // we must not treat arbitrary symbol/string values as an invoice id.
      const fromTopic = isValid(topic.invoice_id) || isValid(topic.invoiceId);
      if (fromTopic) {
        return fromTopic;
      }
    }
  }

  // 3. Reverse lookup by contract address.
  if (record.contract_id && typeof reverseLookup === 'function') {
    const resolved = reverseLookup(String(record.contract_id));
    const fromMap = isValid(resolved);
    if (fromMap) {
      return fromMap;
    }
  }

  return null;
}
/**
 * Validates and normalizes a raw escrow event into the canonical shape used by
 * the indexer's persistence and projection logic.
 *
 * @param {object} rawEvent - Raw event payload to validate and normalize.
 * @returns {object} The normalized event with validated required fields.
 * @throws {Error} If the payload is not an object or a required field is
 *   missing or malformed.
 */
function normalizeEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    throw new Error('Event payload must be an object.');
  }

  const invoiceId = String(rawEvent.invoiceId || '').trim();
  const eventId = String(rawEvent.eventId || '').trim();
  const eventType = String(rawEvent.eventType || '').trim();
  const pagingToken = String(rawEvent.pagingToken || '').trim();
  const ledgerSequence = Number(rawEvent.ledgerSequence);

  if (!INVOICE_ID_REGEX.test(invoiceId)) {
    throw new Error('Invalid invoiceId format.');
  }
  if (!eventId) {
    throw new Error('eventId is required.');
  }
  if (!eventType) {
    throw new Error('eventType is required.');
  }
  if (!Number.isInteger(ledgerSequence) || ledgerSequence <= 0) {
    throw new Error('ledgerSequence must be a positive integer.');
  }

  return {
    eventId,
    invoiceId,
    eventType,
    ledgerSequence,
    pagingToken,
    contractId: rawEvent.contractId ? String(rawEvent.contractId) : null,
    txHash: rawEvent.txHash ? String(rawEvent.txHash) : null,
    eventBody: rawEvent.eventBody || {},
    observedAt: rawEvent.observedAt || new Date().toISOString(),
  };
}

/* istanbul ignore next -- DB-backed store is exercised in integration tests; unit tests inject in-memory store via DI. */
/**
 * Builds a Knex-backed escrow event store providing cursor, event, and
 * projection persistence operations.
 *
 * @param {import('knex').Knex} knex - Configured Knex instance.
 * @returns {object} Store with loadCursor, saveCursor, findProjection,
 *   upsertEvent, and upsertProjection methods.
 */
function createKnexEscrowEventStore(knex) {
  return {
    async loadCursor() {
      const row = await knex('escrow_indexer_state')
        .where({ key: 'horizon_cursor' })
        .first();
      return row ? row.value : null;
    },

    async saveCursor(cursor) {
      await knex('escrow_indexer_state')
        .insert({ key: 'horizon_cursor', value: cursor, updated_at: knex.fn.now() })
        .onConflict('key')
        .merge({ value: cursor, updated_at: knex.fn.now() });
    },

    async findProjection(invoiceId) {
      return knex('escrow_event_projection').where({ invoice_id: invoiceId }).first();
    },

    async upsertEvent(trx, event) {
      await trx('escrow_events')
        .insert({
          event_id: event.eventId,
          invoice_id: event.invoiceId,
          event_type: event.eventType,
          ledger_sequence: event.ledgerSequence,
          paging_token: event.pagingToken || null,
          contract_id: event.contractId,
          tx_hash: event.txHash,
          event_body: JSON.stringify(event.eventBody || {}),
          observed_at: event.observedAt,
        })
        .onConflict('event_id')
        .ignore();
    },

    async upsertProjection(trx, event) {
      await trx('escrow_event_projection')
        .insert({
          invoice_id: event.invoiceId,
          latest_event_id: event.eventId,
          latest_event_type: event.eventType,
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken || null,
          latest_event_body: JSON.stringify(event.eventBody || {}),
          latest_observed_at: event.observedAt,
          updated_at: trx.fn.now(),
        })
        .onConflict('invoice_id')
        .merge({
          latest_event_id: event.eventId,
          latest_event_type: event.eventType,
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken || null,
          latest_event_body: JSON.stringify(event.eventBody || {}),
          latest_observed_at: event.observedAt,
          updated_at: trx.fn.now(),
        });
    },
  };
}
/**
 * Decides whether an incoming event should replace the current per-invoice
 * projection, ordering by ledger sequence and breaking ties on paging token.
 *
 * @param {object|null} currentProjection - Existing projection row, or null.
 * @param {object} event - Incoming normalized event.
 * @returns {boolean} True if the incoming event is newer and should replace.
 */
function shouldReplaceProjection(currentProjection, event) {
  if (!currentProjection) {
    return true;
  }

  const currentLedger = Number(currentProjection.latest_ledger_sequence || 0);
  if (event.ledgerSequence > currentLedger) {
    return true;
  }
  if (event.ledgerSequence < currentLedger) {
    return false;
  }

  const currentToken = String(currentProjection.latest_paging_token || '');
  const nextToken = String(event.pagingToken || '');
  return nextToken > currentToken;
}
/**
 * Persists a single escrow event idempotently and updates the per-invoice
 * projection if the event is newer than the current one.
 *
 * @param {object} deps - Dependencies.
 * @param {object} deps.store - Event store implementation.
 * @param {Function} deps.transactionRunner - Runs a callback within a transaction.
 * @param {object} rawEvent - Raw event to normalize and persist.
 * @returns {Promise<void>} Resolves when the event and projection are written.
 */
async function persistEscrowEvent({ store, transactionRunner }, rawEvent) {
  const event = normalizeEvent(rawEvent);

  await transactionRunner(async (trx) => {
    await store.upsertEvent(trx, event);
    const projection = await store.findProjection(event.invoiceId);
    if (shouldReplaceProjection(projection, event)) {
      await store.upsertProjection(trx, event);
    }
  });

  return event;
}

/* istanbul ignore next -- network/Horizon integration tested separately; unit tests inject fetchEscrowEvents via DI. */
/**
 * Fetches escrow contract events from Horizon, resolving each to an invoice ID
 * and skipping records that cannot be resolved.
 *
 * @param {object} params - Fetch parameters.
 * @param {string} params.baseUrl - Horizon base URL.
 * @param {string|null} params.cursor - Paging cursor to resume from.
 * @param {number} params.limit - Maximum number of records to request.
 * @returns {Promise<{events: object[], nextCursor: string|null}>} Resolved
 *   events and the next paging cursor.
 */
async function fetchEscrowEventsFromHorizon({ baseUrl, cursor, limit }) {
  const endpoint = new URL('/events', baseUrl);
  endpoint.searchParams.set('order', 'asc');
  endpoint.searchParams.set('limit', String(limit));
  if (cursor) {
    endpoint.searchParams.set('cursor', cursor);
  }

  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Horizon events request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const records = payload && payload._embedded && Array.isArray(payload._embedded.records)
    ? payload._embedded.records
    : [];

  const events = records
    .map((record) => {
      const invoiceId = deriveInvoiceId(record);
      if (!invoiceId) {
        return null;
      }
      return {
        eventId: String(record.id || ''),
        invoiceId,
        eventType: record.type || 'contract_event',
        ledgerSequence: Number(record.ledger || 0),
        pagingToken: String(record.paging_token || ''),
        contractId: record.contract_id || null,
        txHash: record.tx_hash || null,
        eventBody: record,
        observedAt: new Date().toISOString(),
      };
    })
    .filter((event) => event !== null);

  const nextCursor = records.length > 0
    ? String(records[records.length - 1].paging_token || cursor || '')
    : cursor || null;

  return { events, nextCursor };
}
/**
 * Runs one indexing cycle: fetches events, persists valid ones, skips invalid
 * ones, and advances the cursor when it changes.
 *
 * @param {object} deps - Cycle dependencies.
 * @param {object} deps.store - Event store implementation.
 * @param {Function} deps.fetchEscrowEvents - Fetches a batch of events.
 * @param {Function} deps.transactionRunner - Runs a callback within a transaction.
 * @param {object} [deps.log] - Logger with warn/info/error.
 * @param {number} [deps.batchSize] - Max events to fetch per cycle.
 * @returns {Promise<object>} Summary with processed/skipped counts and
 *   cursorBefore/cursorAfter.
 */
async function runEscrowIndexerCycle({
  store,
  fetchEscrowEvents,
  transactionRunner,
  log = logger,
  batchSize = DEFAULT_BATCH_SIZE,
}) {
  const cursor = await store.loadCursor();
  const { events, nextCursor } = await fetchEscrowEvents({ cursor, limit: batchSize });

  let processed = 0;
  let skipped = 0;

  for (const rawEvent of events) {
    try {
      await persistEscrowEvent({ store, transactionRunner }, rawEvent);
      processed += 1;
    } catch (error) {
      skipped += 1;
      log.warn({ err: error, eventId: rawEvent && rawEvent.eventId }, 'Skipping invalid escrow event.');
    }
  }

  if (nextCursor && nextCursor !== cursor) {
    await store.saveCursor(nextCursor);
  }

  return { processed, skipped, cursorBefore: cursor, cursorAfter: nextCursor || cursor || null };
}
/**
 * Creates an escrow indexer with start/stop polling control and a re-entrancy
 * guarded runCycle.
 *
 * @param {object} [options] - Indexer options (store, fetchEscrowEvents,
 *   transactionRunner, pollIntervalMs, log).
 * @returns {{start: Function, stop: Function, runCycle: Function}} Indexer handle.
 */
function createEscrowIndexer(options = {}) {
  /* istanbul ignore next -- default DB-backed wiring exercised in integration tests; unit tests inject store via DI. */
  const store = options.store || createKnexEscrowEventStore(options.db || db);
  const horizonBaseUrl = options.horizonBaseUrl || process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const fetchEscrowEvents =
    options.fetchEscrowEvents ||
    /* istanbul ignore next -- default Horizon fetch exercised in integration tests; unit tests inject fetchEscrowEvents via DI. */
    ((params) => fetchEscrowEventsFromHorizon({
      baseUrl: horizonBaseUrl,
      cursor: params.cursor,
      limit: params.limit,
    }));
  const transactionRunner =
    options.transactionRunner ||
    /* istanbul ignore next -- default transaction runner exercised with knex; unit tests inject transactionRunner via DI. */
    ((handler) => (options.db || db).transaction(handler));
  const pollIntervalMs = Number(options.pollIntervalMs || process.env.ESCROW_INDEXER_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);

  let timer = null;
  let running = false;

  const runCycle = async () => {
    if (running) {
      return null;
    }
    running = true;
    try {
      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log: options.log || logger,
        batchSize: Number(process.env.ESCROW_INDEXER_BATCH_SIZE || DEFAULT_BATCH_SIZE),
      });
      (options.log || logger).info(summary, 'Escrow indexer cycle completed.');

      // Emit metrics
      try {
        // Validate processed count
        if (!Number.isInteger(summary.processed) || summary.processed < 0) {
          (options.log || logger).error(
            { processed: summary.processed },
            'Invalid processed count; incrementing cycle failures'
          );
          escrowIndexerCycleFailuresTotal.inc();
        } else {
          escrowIndexerEventsProcessedTotal.inc(summary.processed);
        }

        // Validate skipped count
        if (!Number.isInteger(summary.skipped) || summary.skipped < 0) {
          (options.log || logger).error(
            { skipped: summary.skipped },
            'Invalid skipped count; incrementing cycle failures'
          );
          escrowIndexerCycleFailuresTotal.inc();
        } else {
          escrowIndexerEventsSkippedTotal.inc(summary.skipped);
        }

        // Update last-advance gauge if cursor advanced
        if (summary.cursorAfter !== summary.cursorBefore) {
          escrowIndexerLastCursorAdvanceTimestampSeconds.set(Math.floor(Date.now() / 1000));
        }
      } catch (metricsError) {
        (options.log || logger).error({ err: metricsError }, 'Error emitting indexer metrics');
        escrowIndexerCycleFailuresTotal.inc();
      }

      return summary;
    } catch (error) {
      (options.log || logger).error({ err: error }, 'Escrow indexer cycle failed.');
      escrowIndexerCycleFailuresTotal.inc();
      return null;
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) {
      return;
    }
    runCycle().catch(() => {});
    timer = setInterval(() => {
      runCycle().catch(() => {});
    }, pollIntervalMs);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, runCycle };
}

module.exports = {
  createEscrowIndexer,
  createKnexEscrowEventStore,
  deriveInvoiceId,
  fetchEscrowEventsFromHorizon,
  normalizeEvent,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  shouldReplaceProjection,
};
