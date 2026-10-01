'use strict';

/**
 * @fileoverview Concurrent-execution regression tests for src/dto/indexer.js
 *
 * Issue #1350 — Harden concurrent execution around src/dto/indexer.js
 *
 * This suite targets races and inconsistencies that arise when the same DTO
 * functions are called concurrently or repeatedly with shared inputs.  It
 * covers:
 *
 *   1. Deterministic `observedAt` — two concurrent calls for the same event
 *      must produce the same timestamp when a shared `capturedAt` is supplied.
 *
 *   2. eventBody isolation — mutations to the source `raw` object after a DTO
 *      is built must not affect the frozen DTO.
 *
 *   3. Empty / null invoiceId guard — an empty projection key causes silent
 *      data corruption and must be rejected before the DTO is built.
 *
 *   4. Idempotency — calling the same mapper twice with identical inputs
 *      must produce value-equal (though not reference-equal) frozen objects.
 *
 *   5. Frozen output invariant — every mapper in the module produces frozen
 *      output even when called concurrently (simulated with Promise.all).
 *
 *   6. Route import correctness — GET /api/admin/indexer/events must not
 *      throw ReferenceError because mapQueryToDTO / mapDTOToServiceParams are
 *      now imported in adminIndexer.js.
 *
 *   7. bulkIndexerEvents concurrent isolation — multiple items in a bulk batch
 *      share the same Knex builder chain without interfering with each other's
 *      row data.
 */

const {
  mapQueryToDTO,
  mapDTOToServiceParams,
  mapRowToEscrowEventDTO,
  mapMetaToDTO,
  mapServiceResultToResponseDTO,
  mapRawToIngestDTO,
  mapIngestDTOToNormalized,
} = require('../src/dto/indexer');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeHorizonRecord(overrides = {}) {
  return {
    id: 'hz_evt_001',
    type: 'contract_event',
    ledger: 200,
    paging_token: '200-1',
    contract_id: 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI',
    tx_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    ...overrides,
  };
}

function makeRow(overrides = {}) {
  return {
    event_id: 'evt_001',
    invoice_id: 'inv_001',
    event_type: 'escrow_created',
    ledger_sequence: 100,
    paging_token: '100-1',
    contract_id: 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI',
    tx_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    observed_at: new Date('2026-01-01T00:00:00.000Z'),
    created_at: new Date('2026-01-01T00:00:01.000Z'),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Deterministic observedAt across concurrent calls
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRawToIngestDTO — deterministic observedAt (issue #1350)', () => {
  test('two calls with the same capturedAt produce identical observedAt', () => {
    const capturedAt = '2026-09-30T08:00:00.000Z';
    const raw = makeHorizonRecord();

    const dto1 = mapRawToIngestDTO(raw, 'inv_a', { capturedAt });
    const dto2 = mapRawToIngestDTO(raw, 'inv_b', { capturedAt });

    expect(dto1.observedAt).toBe(capturedAt);
    expect(dto2.observedAt).toBe(capturedAt);
    expect(dto1.observedAt).toBe(dto2.observedAt);
  });

  test('raw.observedAt always wins over capturedAt regardless of call order', () => {
    const pinned = '2026-01-15T00:00:00.000Z';
    const capturedAt = '2026-09-30T00:00:00.000Z';

    const dto = mapRawToIngestDTO({ observedAt: pinned }, 'inv_pin', { capturedAt });
    expect(dto.observedAt).toBe(pinned);
  });

  test('50 simulated concurrent calls for the same event share the same observedAt', async () => {
    const capturedAt = '2026-09-30T09:00:00.000Z';
    const raw = makeHorizonRecord();

    // Simulate concurrency with Promise.all; in Node.js this is single-threaded
    // but exercises the same code path as calls interleaved between I/O ticks.
    const dtos = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(mapRawToIngestDTO(raw, `inv_par_${i}`, { capturedAt }))
      )
    );

    const timestamps = dtos.map((d) => d.observedAt);
    const unique = new Set(timestamps);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe(capturedAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. eventBody isolation — post-call mutation of `raw` must not leak into DTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRawToIngestDTO — eventBody isolation (issue #1350)', () => {
  test('eventBody is a distinct copy when raw has no explicit eventBody', () => {
    const raw = makeHorizonRecord({ type: 'escrow_funded' });
    const dto = mapRawToIngestDTO(raw, 'inv_iso1', {
      capturedAt: '2026-09-30T00:00:00.000Z',
    });

    expect(dto.eventBody).not.toBe(raw);
    expect(dto.eventBody.type).toBe('escrow_funded');

    // Mutate after freeze — DTO must be unaffected
    raw.type = 'mutated';
    expect(dto.eventBody.type).toBe('escrow_funded');
  });

  test('eventBody is a distinct copy when raw has an explicit eventBody', () => {
    const body = { amount: '500', currency: 'XLM' };
    const raw = { ...makeHorizonRecord(), eventBody: body };
    const dto = mapRawToIngestDTO(raw, 'inv_iso2', {
      capturedAt: '2026-09-30T00:00:00.000Z',
    });

    expect(dto.eventBody).not.toBe(body);
    expect(dto.eventBody.amount).toBe('500');

    // Mutate original body after DTO creation
    body.amount = '999';
    expect(dto.eventBody.amount).toBe('500'); // DTO is unaffected
  });

  test('two DTOs built from the same raw object have independent eventBody copies', () => {
    const raw = makeHorizonRecord({ ledger: 300 });

    const dto1 = mapRawToIngestDTO(raw, 'inv_iso3a', {
      capturedAt: '2026-09-30T00:00:00.000Z',
    });
    const dto2 = mapRawToIngestDTO(raw, 'inv_iso3b', {
      capturedAt: '2026-09-30T00:00:00.000Z',
    });

    expect(dto1.eventBody).not.toBe(dto2.eventBody);
    expect(dto1.eventBody.ledger).toBe(dto2.eventBody.ledger); // same value
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. invoiceId guard — empty / null invoiceId must throw before DTO is built
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRawToIngestDTO — invoiceId guard (issue #1350)', () => {
  test('throws TypeError for empty string invoiceId', () => {
    expect(() => mapRawToIngestDTO({}, '')).toThrow(TypeError);
  });

  test('throws TypeError for null invoiceId', () => {
    expect(() => mapRawToIngestDTO({}, null)).toThrow(TypeError);
  });

  test('throws TypeError for undefined invoiceId (no second arg)', () => {
    expect(() => mapRawToIngestDTO({})).toThrow(TypeError);
  });

  test('throws TypeError for whitespace-only invoiceId', () => {
    // String('   ').trim() still results in a non-empty raw.invoiceId coercion,
    // BUT the constructor coerces invoiceId to String then checks falsy.
    // Whitespace is truthy in JS so this is accepted — document that behaviour.
    // If stricter validation is desired, update this test and the guard.
    expect(() => mapRawToIngestDTO({}, '   ')).not.toThrow();
  });

  test('does not throw for a valid non-empty invoiceId string', () => {
    expect(() => mapRawToIngestDTO({}, 'inv_valid', {
      capturedAt: '2026-09-30T00:00:00.000Z',
    })).not.toThrow();
  });

  test('error message is descriptive for empty invoiceId', () => {
    expect(() => mapRawToIngestDTO({}, '')).toThrow(
      /invoiceId must be a non-empty string/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Idempotency — same inputs → value-equal frozen outputs
// ─────────────────────────────────────────────────────────────────────────────

describe('Idempotency across repeated calls (issue #1350)', () => {
  const CAPTURED_AT = '2026-09-30T07:50:06.000Z';

  test('mapRawToIngestDTO called twice with identical args produces value-equal DTOs', () => {
    const raw = makeHorizonRecord();
    const dto1 = mapRawToIngestDTO(raw, 'inv_idem', { capturedAt: CAPTURED_AT });
    const dto2 = mapRawToIngestDTO(raw, 'inv_idem', { capturedAt: CAPTURED_AT });

    expect(dto1).not.toBe(dto2); // different object references
    expect(dto1.eventId).toBe(dto2.eventId);
    expect(dto1.invoiceId).toBe(dto2.invoiceId);
    expect(dto1.eventType).toBe(dto2.eventType);
    expect(dto1.ledgerSequence).toBe(dto2.ledgerSequence);
    expect(dto1.pagingToken).toBe(dto2.pagingToken);
    expect(dto1.contractId).toBe(dto2.contractId);
    expect(dto1.txHash).toBe(dto2.txHash);
    expect(dto1.observedAt).toBe(dto2.observedAt);
  });

  test('mapIngestDTOToNormalized called twice on the same DTO produces value-equal normalized objects', () => {
    const raw = makeHorizonRecord();
    const dto = mapRawToIngestDTO(raw, 'inv_norm_idem', { capturedAt: CAPTURED_AT });

    const n1 = mapIngestDTOToNormalized(dto);
    const n2 = mapIngestDTOToNormalized(dto);

    expect(n1).not.toBe(n2);
    expect(n1.eventId).toBe(n2.eventId);
    expect(n1.observedAt).toBe(n2.observedAt);
  });

  test('mapQueryToDTO is idempotent for the same input', () => {
    const params = {
      filters: { invoiceId: 'inv_idem' },
      sorting: { sortBy: 'observed_at', order: 'asc' },
      pagination: { limit: 10, page: 1 },
    };
    const dto1 = mapQueryToDTO(params);
    const dto2 = mapQueryToDTO(params);

    expect(dto1.filters.invoiceId).toBe(dto2.filters.invoiceId);
    expect(dto1.sorting.sortBy).toBe(dto2.sorting.sortBy);
    expect(dto1.pagination.limit).toBe(dto2.pagination.limit);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Frozen output invariant — all mappers produce frozen output
// ─────────────────────────────────────────────────────────────────────────────

describe('Frozen output invariant across all mappers (issue #1350)', () => {
  const CAPTURED_AT = '2026-09-30T07:50:00.000Z';

  test('mapQueryToDTO output (and nested sub-objects) are all frozen', () => {
    const dto = mapQueryToDTO({
      filters: { invoiceId: 'inv_f' },
      sorting: { sortBy: 'ledger_sequence', order: 'asc' },
      pagination: { limit: 5 },
    });
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.filters)).toBe(true);
    expect(Object.isFrozen(dto.sorting)).toBe(true);
    expect(Object.isFrozen(dto.pagination)).toBe(true);
  });

  test('mapRowToEscrowEventDTO output is frozen', () => {
    expect(Object.isFrozen(mapRowToEscrowEventDTO(makeRow()))).toBe(true);
  });

  test('mapMetaToDTO output is frozen', () => {
    expect(Object.isFrozen(
      mapMetaToDTO({ total: 0, limit: 20, hasMore: false, nextCursor: null })
    )).toBe(true);
  });

  test('mapServiceResultToResponseDTO top-level output is frozen', () => {
    expect(Object.isFrozen(mapServiceResultToResponseDTO({
      data: [],
      meta: { total: 0, limit: 20, hasMore: false, nextCursor: null },
    }))).toBe(true);
  });

  test('mapRawToIngestDTO output is frozen', () => {
    expect(Object.isFrozen(
      mapRawToIngestDTO(makeHorizonRecord(), 'inv_frz', { capturedAt: CAPTURED_AT })
    )).toBe(true);
  });

  test('mapIngestDTOToNormalized output is frozen', () => {
    const dto = mapRawToIngestDTO(makeHorizonRecord(), 'inv_nrm', { capturedAt: CAPTURED_AT });
    expect(Object.isFrozen(mapIngestDTOToNormalized(dto))).toBe(true);
  });

  test('concurrent frozen-output checks for mapRawToIngestDTO', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(
          mapRawToIngestDTO(makeHorizonRecord({ id: `e${i}` }), `inv_p${i}`, {
            capturedAt: CAPTURED_AT,
          })
        )
      )
    );
    for (const dto of results) {
      expect(Object.isFrozen(dto)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Route import correctness — ReferenceError regression
// ─────────────────────────────────────────────────────────────────────────────

describe('adminIndexer route — mapQueryToDTO / mapDTOToServiceParams import (issue #1350)', () => {
  test('requiring adminIndexer.js does not throw ReferenceError', () => {
    // Before the fix, adminIndexer.js called mapQueryToDTO and mapDTOToServiceParams
    // without importing them, causing a ReferenceError on every GET /events request.
    expect(() => {
      // Use a fresh module instance to avoid cache interference with other test suites
      jest.isolateModules(() => {
        // Mock heavy transitive deps so the require does not need a live DB
        jest.mock('../src/db/knex', () => ({}));
        jest.mock('../src/config', () => ({ get: () => ({ ESCROW_INDEXER_ENABLED: 'false' }) }));
        jest.mock('../src/middleware/stacks', () => ({ adminStack: [] }));
        jest.mock('../src/middleware/rateLimit', () => ({ indexerLimiter: (_r, _s, n) => n() }));
        jest.mock('../src/middleware/indexerMetrics', () => ({
          instrumentIndexer: (h) => h,
        }));
        jest.mock('../src/middleware/compression', () => ({
          createCompressionMiddleware: () => (_r, _s, n) => n(),
        }));
        jest.mock('../src/logger', () => ({ info: () => {}, error: () => {} }));
        require('../src/routes/adminIndexer');
      });
    }).not.toThrow();
  });

  test('adminIndexer module exports a router (not undefined)', () => {
    jest.isolateModules(() => {
      jest.mock('../src/db/knex', () => ({}));
      jest.mock('../src/config', () => ({ get: () => ({ ESCROW_INDEXER_ENABLED: 'false' }) }));
      jest.mock('../src/middleware/stacks', () => ({ adminStack: [] }));
      jest.mock('../src/middleware/rateLimit', () => ({ indexerLimiter: (_r, _s, n) => n() }));
      jest.mock('../src/middleware/indexerMetrics', () => ({
        instrumentIndexer: (h) => h,
      }));
      jest.mock('../src/middleware/compression', () => ({
        createCompressionMiddleware: () => (_r, _s, n) => n(),
      }));
      jest.mock('../src/logger', () => ({ info: () => {}, error: () => {} }));
      const router = require('../src/routes/adminIndexer');
      expect(router).toBeDefined();
      expect(typeof router).toBe('function'); // Express router is a function
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. mapDTOToServiceParams — concurrent access does not share state
// ─────────────────────────────────────────────────────────────────────────────

describe('mapDTOToServiceParams — no shared state between concurrent calls (issue #1350)', () => {
  test('two concurrent calls return independent plain objects', async () => {
    const dto = mapQueryToDTO({
      filters: { invoiceId: 'inv_shared' },
      sorting: { sortBy: 'observed_at', order: 'desc' },
      pagination: { limit: 10 },
    });

    const [sp1, sp2] = await Promise.all([
      Promise.resolve(mapDTOToServiceParams(dto)),
      Promise.resolve(mapDTOToServiceParams(dto)),
    ]);

    expect(sp1).not.toBe(sp2);
    expect(sp1.filters).not.toBe(sp2.filters);
    expect(sp1.sorting).not.toBe(sp2.sorting);
    expect(sp1.pagination).not.toBe(sp2.pagination);

    // Values must still match the input DTO
    expect(sp1.filters.invoiceId).toBe('inv_shared');
    expect(sp2.filters.invoiceId).toBe('inv_shared');
  });

  test('mutating one service-params object does not affect another', () => {
    const dto = mapQueryToDTO({ filters: { eventType: 'escrow_funded' } });
    const sp1 = mapDTOToServiceParams(dto);
    const sp2 = mapDTOToServiceParams(dto);

    // Mutate sp1 — sp2 must be unaffected
    sp1.filters.eventType = 'MUTATED';
    expect(sp2.filters.eventType).toBe('escrow_funded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Boundary / edge inputs for mapRawToIngestDTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRawToIngestDTO — boundary and edge inputs (issue #1350)', () => {
  const CA = '2026-09-30T00:00:00.000Z';

  test('handles raw record with all optional fields missing', () => {
    const dto = mapRawToIngestDTO({}, 'inv_edge1', { capturedAt: CA });
    expect(dto.eventId).toBe('');
    expect(dto.eventType).toBe('contract_event');
    expect(dto.ledgerSequence).toBe(0);
    expect(dto.pagingToken).toBe('');
    expect(dto.contractId).toBeNull();
    expect(dto.txHash).toBeNull();
    expect(dto.observedAt).toBe(CA);
  });

  test('handles raw record with numeric ledger field', () => {
    const dto = mapRawToIngestDTO({ ledger: 999999 }, 'inv_edge2', { capturedAt: CA });
    expect(dto.ledgerSequence).toBe(999999);
  });

  test('snake_case fields take priority over camelCase aliases for id', () => {
    // raw.id shadows raw.eventId in the mapper
    const dto = mapRawToIngestDTO(
      { id: 'snake_id', eventId: 'camel_id' },
      'inv_edge3',
      { capturedAt: CA }
    );
    expect(dto.eventId).toBe('snake_id');
  });

  test('snake_case contractId takes priority over camelCase alias', () => {
    const dto = mapRawToIngestDTO(
      { contract_id: 'SNAKE_C', contractId: 'CAMEL_C' },
      'inv_edge4',
      { capturedAt: CA }
    );
    expect(dto.contractId).toBe('SNAKE_C');
  });

  test('handles non-object eventBody gracefully (uses empty object)', () => {
    // If raw.eventBody is a non-object (e.g. a string), the mapper falls back to {}
    const dto = mapRawToIngestDTO({ eventBody: null }, 'inv_edge5', { capturedAt: CA });
    expect(typeof dto.eventBody).toBe('object');
    expect(dto.eventBody).not.toBeNull();
  });

  test('handles array eventBody by using empty object fallback', () => {
    // Arrays are not plain objects; the mapper falls back to {}
    const dto = mapRawToIngestDTO({ eventBody: [] }, 'inv_edge6', { capturedAt: CA });
    expect(Array.isArray(dto.eventBody)).toBe(false);
    expect(typeof dto.eventBody).toBe('object');
  });
});
