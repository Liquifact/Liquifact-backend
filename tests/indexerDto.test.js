'use strict';

/**
 * @fileoverview Comprehensive tests for src/dto/indexer.js
 *
 * Covers:
 *  - mapQueryToDTO: required defaults, optional fields, type coercion
 *  - mapDTOToServiceParams: omits undefined optionals, round-trips
 *  - mapRowToEscrowEventDTO: snake_case→camelCase, null handling, Date coercion
 *  - mapEscrowEventDTOToRow: reverse mapping round-trip
 *  - mapMetaToDTO: cursor mode, offset mode, null nextCursor
 *  - mapServiceResultToResponseDTO: full result envelope
 *  - mapRawToIngestDTO: Horizon record fields, camelCase aliases, defaults
 *  - mapIngestDTOToNormalized: field pass-through
 *  - Immutability: all returned objects are frozen
 *  - Edge cases: missing optional fields, Date instances, numeric coercion
 */

const {
  mapQueryToDTO,
  mapDTOToServiceParams,
  mapRowToEscrowEventDTO,
  mapEscrowEventDTOToRow,
  mapMetaToDTO,
  mapServiceResultToResponseDTO,
  mapRawToIngestDTO,
  mapIngestDTOToNormalized,
} = require('../src/dto/indexer');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid DB row with all columns populated */
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

/** Minimal valid raw Horizon record */
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. mapQueryToDTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapQueryToDTO()', () => {
  test('applies default sortBy=observed_at and order=desc when not supplied', () => {
    const dto = mapQueryToDTO({});
    expect(dto.sorting.sortBy).toBe('observed_at');
    expect(dto.sorting.order).toBe('desc');
  });

  test('passes through all filter fields', () => {
    const dto = mapQueryToDTO({
      filters: { invoiceId: 'inv_A', eventType: 'escrow_funded', contractId: 'CADDR123' },
      sorting: {},
      pagination: {},
    });
    expect(dto.filters.invoiceId).toBe('inv_A');
    expect(dto.filters.eventType).toBe('escrow_funded');
    expect(dto.filters.contractId).toBe('CADDR123');
  });

  test('coerces all filter values to strings', () => {
    const dto = mapQueryToDTO({ filters: { invoiceId: 42, eventType: true } });
    expect(dto.filters.invoiceId).toBe('42');
    expect(dto.filters.eventType).toBe('true');
  });

  test('omits filter fields that are undefined', () => {
    const dto = mapQueryToDTO({ filters: {} });
    expect(dto.filters.invoiceId).toBeUndefined();
    expect(dto.filters.eventType).toBeUndefined();
    expect(dto.filters.contractId).toBeUndefined();
  });

  test('preserves asc order', () => {
    const dto = mapQueryToDTO({ sorting: { sortBy: 'ledger_sequence', order: 'asc' } });
    expect(dto.sorting.sortBy).toBe('ledger_sequence');
    expect(dto.sorting.order).toBe('asc');
  });

  test('defaults unknown order value to desc', () => {
    const dto = mapQueryToDTO({ sorting: { order: 'sideways' } });
    expect(dto.sorting.order).toBe('desc');
  });

  test('passes through cursor, page, and limit', () => {
    const dto = mapQueryToDTO({
      pagination: { cursor: 'tok123', page: 2, limit: 50 },
    });
    expect(dto.pagination.cursor).toBe('tok123');
    expect(dto.pagination.page).toBe(2);
    expect(dto.pagination.limit).toBe(50);
  });

  test('omits pagination fields that are undefined', () => {
    const dto = mapQueryToDTO({ pagination: {} });
    expect(dto.pagination.cursor).toBeUndefined();
    expect(dto.pagination.page).toBeUndefined();
    expect(dto.pagination.limit).toBeUndefined();
  });

  test('returned DTO and nested objects are frozen', () => {
    const dto = mapQueryToDTO({});
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.filters)).toBe(true);
    expect(Object.isFrozen(dto.sorting)).toBe(true);
    expect(Object.isFrozen(dto.pagination)).toBe(true);
  });

  test('handles completely empty input without throwing', () => {
    expect(() => mapQueryToDTO({})).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. mapDTOToServiceParams  (+ round-trip with mapQueryToDTO)
// ─────────────────────────────────────────────────────────────────────────────

describe('mapDTOToServiceParams()', () => {
  test('round-trip: query params survive mapQueryToDTO → mapDTOToServiceParams', () => {
    const params = {
      filters: { invoiceId: 'inv_X', eventType: 'escrow_released' },
      sorting: { sortBy: 'ledger_sequence', order: 'asc' },
      pagination: { page: 3, limit: 10 },
    };
    const dto = mapQueryToDTO(params);
    const serviceParams = mapDTOToServiceParams(dto);

    expect(serviceParams.filters.invoiceId).toBe('inv_X');
    expect(serviceParams.filters.eventType).toBe('escrow_released');
    expect(serviceParams.sorting.sortBy).toBe('ledger_sequence');
    expect(serviceParams.sorting.order).toBe('asc');
    expect(serviceParams.pagination.page).toBe(3);
    expect(serviceParams.pagination.limit).toBe(10);
  });

  test('undefined optional filter fields are absent from service params', () => {
    const dto = mapQueryToDTO({ filters: { invoiceId: 'inv_Y' } });
    const serviceParams = mapDTOToServiceParams(dto);

    expect(serviceParams.filters.invoiceId).toBe('inv_Y');
    expect('eventType' in serviceParams.filters).toBe(false);
    expect('contractId' in serviceParams.filters).toBe(false);
  });

  test('undefined cursor and page are absent from service params', () => {
    const dto = mapQueryToDTO({ pagination: { limit: 5 } });
    const serviceParams = mapDTOToServiceParams(dto);

    expect('cursor' in serviceParams.pagination).toBe(false);
    expect('page' in serviceParams.pagination).toBe(false);
    expect(serviceParams.pagination.limit).toBe(5);
  });

  test('cursor is passed through when present', () => {
    const dto = mapQueryToDTO({ pagination: { cursor: 'opaque-tok' } });
    const serviceParams = mapDTOToServiceParams(dto);
    expect(serviceParams.pagination.cursor).toBe('opaque-tok');
  });

  test('sorting defaults are included in service params', () => {
    const dto = mapQueryToDTO({});
    const serviceParams = mapDTOToServiceParams(dto);
    expect(serviceParams.sorting.sortBy).toBe('observed_at');
    expect(serviceParams.sorting.order).toBe('desc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. mapRowToEscrowEventDTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRowToEscrowEventDTO()', () => {
  test('maps all snake_case columns to camelCase DTO fields', () => {
    const dto = mapRowToEscrowEventDTO(makeRow());
    expect(dto.eventId).toBe('evt_001');
    expect(dto.invoiceId).toBe('inv_001');
    expect(dto.eventType).toBe('escrow_created');
    expect(dto.ledgerSequence).toBe(100);
    expect(dto.pagingToken).toBe('100-1');
    expect(dto.contractId).toBe('CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI');
    expect(dto.txHash).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  test('converts Date instances to ISO-8601 strings', () => {
    const dto = mapRowToEscrowEventDTO(makeRow());
    expect(dto.observedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(dto.createdAt).toBe('2026-01-01T00:00:01.000Z');
  });

  test('passes through ISO string timestamps without modification', () => {
    const dto = mapRowToEscrowEventDTO(makeRow({
      observed_at: '2026-06-01T12:00:00.000Z',
      created_at: '2026-06-01T12:00:01.000Z',
    }));
    expect(dto.observedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(dto.createdAt).toBe('2026-06-01T12:00:01.000Z');
  });

  test('maps null nullable fields to null', () => {
    const dto = mapRowToEscrowEventDTO(makeRow({
      paging_token: null,
      contract_id: null,
      tx_hash: null,
    }));
    expect(dto.pagingToken).toBeNull();
    expect(dto.contractId).toBeNull();
    expect(dto.txHash).toBeNull();
  });

  test('maps undefined nullable fields to null', () => {
    const dto = mapRowToEscrowEventDTO(makeRow({
      paging_token: undefined,
      contract_id: undefined,
      tx_hash: undefined,
      observed_at: undefined,
      created_at: undefined,
    }));
    expect(dto.pagingToken).toBeNull();
    expect(dto.contractId).toBeNull();
    expect(dto.txHash).toBeNull();
    expect(dto.observedAt).toBeNull();
    expect(dto.createdAt).toBeNull();
  });

  test('coerces numeric ledger_sequence to number', () => {
    const dto = mapRowToEscrowEventDTO(makeRow({ ledger_sequence: '42' }));
    expect(dto.ledgerSequence).toBe(42);
  });

  test('coerces numeric event_id / invoice_id to string', () => {
    const dto = mapRowToEscrowEventDTO(makeRow({ event_id: 99, invoice_id: 7 }));
    expect(typeof dto.eventId).toBe('string');
    expect(typeof dto.invoiceId).toBe('string');
  });

  test('returned DTO is frozen', () => {
    const dto = mapRowToEscrowEventDTO(makeRow());
    expect(Object.isFrozen(dto)).toBe(true);
  });

  test('does not include any snake_case keys', () => {
    const dto = mapRowToEscrowEventDTO(makeRow());
    const keys = Object.keys(dto);
    const snakeKeys = keys.filter((k) => k.includes('_'));
    expect(snakeKeys).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. mapEscrowEventDTOToRow  (reverse mapper + round-trip)
// ─────────────────────────────────────────────────────────────────────────────

describe('mapEscrowEventDTOToRow()', () => {
  test('maps camelCase DTO back to snake_case row keys', () => {
    const dto = mapRowToEscrowEventDTO(makeRow());
    const row = mapEscrowEventDTOToRow(dto);

    expect(row.event_id).toBe('evt_001');
    expect(row.invoice_id).toBe('inv_001');
    expect(row.event_type).toBe('escrow_created');
    expect(row.ledger_sequence).toBe(100);
    expect(row.paging_token).toBe('100-1');
    expect(row.contract_id).toBe('CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI');
    expect(row.tx_hash).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  test('round-trip: row → DTO → row preserves all values', () => {
    const original = makeRow();
    const dto = mapRowToEscrowEventDTO(original);
    const restored = mapEscrowEventDTOToRow(dto);

    expect(restored.event_id).toBe(String(original.event_id));
    expect(restored.invoice_id).toBe(String(original.invoice_id));
    expect(restored.event_type).toBe(String(original.event_type));
    expect(restored.ledger_sequence).toBe(Number(original.ledger_sequence));
  });

  test('round-trip preserves null nullable fields', () => {
    const original = makeRow({ paging_token: null, contract_id: null, tx_hash: null });
    const dto = mapRowToEscrowEventDTO(original);
    const restored = mapEscrowEventDTOToRow(dto);

    expect(restored.paging_token).toBeNull();
    expect(restored.contract_id).toBeNull();
    expect(restored.tx_hash).toBeNull();
  });

  test('contains all expected snake_case keys', () => {
    const dto = mapRowToEscrowEventDTO(makeRow());
    const row = mapEscrowEventDTOToRow(dto);
    const expectedKeys = [
      'event_id', 'invoice_id', 'event_type', 'ledger_sequence',
      'paging_token', 'contract_id', 'tx_hash', 'observed_at', 'created_at',
    ];
    for (const key of expectedKeys) {
      expect(row).toHaveProperty(key);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. mapMetaToDTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapMetaToDTO()', () => {
  test('maps cursor-mode meta (no page/totalPages)', () => {
    const meta = mapMetaToDTO({ total: 42, limit: 20, hasMore: true, nextCursor: 'tok' });
    expect(meta.total).toBe(42);
    expect(meta.limit).toBe(20);
    expect(meta.hasMore).toBe(true);
    expect(meta.nextCursor).toBe('tok');
    expect(meta.page).toBeUndefined();
    expect(meta.totalPages).toBeUndefined();
  });

  test('maps offset-mode meta (includes page and totalPages)', () => {
    const meta = mapMetaToDTO({
      total: 100, limit: 10, hasMore: true, nextCursor: null, page: 2, totalPages: 10,
    });
    expect(meta.page).toBe(2);
    expect(meta.totalPages).toBe(10);
  });

  test('coerces null nextCursor to null', () => {
    const meta = mapMetaToDTO({ total: 0, limit: 20, hasMore: false, nextCursor: null });
    expect(meta.nextCursor).toBeNull();
  });

  test('coerces undefined nextCursor to null', () => {
    const meta = mapMetaToDTO({ total: 0, limit: 20, hasMore: false });
    expect(meta.nextCursor).toBeNull();
  });

  test('coerces string total/limit to numbers', () => {
    const meta = mapMetaToDTO({ total: '55', limit: '10', hasMore: '0', nextCursor: null });
    expect(typeof meta.total).toBe('number');
    expect(typeof meta.limit).toBe('number');
    expect(typeof meta.hasMore).toBe('boolean');
  });

  test('hasMore coercion: truthy string → true', () => {
    const meta = mapMetaToDTO({ total: 0, limit: 10, hasMore: 'yes', nextCursor: null });
    expect(meta.hasMore).toBe(true);
  });

  test('returned DTO is frozen', () => {
    const meta = mapMetaToDTO({ total: 0, limit: 20, hasMore: false, nextCursor: null });
    expect(Object.isFrozen(meta)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. mapServiceResultToResponseDTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapServiceResultToResponseDTO()', () => {
  test('maps data array through mapRowToEscrowEventDTO', () => {
    const serviceResult = {
      data: [makeRow({ event_id: 'r1' }), makeRow({ event_id: 'r2' })],
      meta: { total: 2, limit: 20, hasMore: false, nextCursor: null },
    };
    const dto = mapServiceResultToResponseDTO(serviceResult);

    expect(dto.data).toHaveLength(2);
    expect(dto.data[0].eventId).toBe('r1');
    expect(dto.data[1].eventId).toBe('r2');
  });

  test('meta is mapped through mapMetaToDTO', () => {
    const serviceResult = {
      data: [],
      meta: { total: 0, limit: 20, hasMore: false, nextCursor: null },
    };
    const dto = mapServiceResultToResponseDTO(serviceResult);
    expect(dto.meta.total).toBe(0);
    expect(dto.meta.hasMore).toBe(false);
    expect(dto.meta.nextCursor).toBeNull();
  });

  test('empty data array produces empty DTO data array', () => {
    const dto = mapServiceResultToResponseDTO({
      data: [],
      meta: { total: 0, limit: 20, hasMore: false, nextCursor: null },
    });
    expect(dto.data).toEqual([]);
  });

  test('each data item in result is frozen', () => {
    const dto = mapServiceResultToResponseDTO({
      data: [makeRow()],
      meta: { total: 1, limit: 20, hasMore: false, nextCursor: null },
    });
    expect(Object.isFrozen(dto.data[0])).toBe(true);
  });

  test('full response DTO is frozen', () => {
    const dto = mapServiceResultToResponseDTO({
      data: [],
      meta: { total: 0, limit: 20, hasMore: false, nextCursor: null },
    });
    expect(Object.isFrozen(dto)).toBe(true);
  });

  test('preserves nextCursor from service result', () => {
    const dto = mapServiceResultToResponseDTO({
      data: [],
      meta: { total: 5, limit: 2, hasMore: true, nextCursor: 'cursor-abc' },
    });
    expect(dto.meta.nextCursor).toBe('cursor-abc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. mapRawToIngestDTO
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRawToIngestDTO()', () => {
  test('maps all Horizon snake_case fields correctly', () => {
    const raw = makeHorizonRecord();
    const dto = mapRawToIngestDTO(raw, 'inv_001');

    expect(dto.eventId).toBe('hz_evt_001');
    expect(dto.invoiceId).toBe('inv_001');
    expect(dto.eventType).toBe('contract_event');
    expect(dto.ledgerSequence).toBe(200);
    expect(dto.pagingToken).toBe('200-1');
    expect(dto.contractId).toBe('CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI');
    expect(dto.txHash).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  });

  test('also accepts camelCase aliases (eventId, eventType, etc.)', () => {
    const raw = {
      eventId: 'camel_001',
      eventType: 'escrow_funded',
      ledgerSequence: 300,
      pagingToken: '300-1',
      contractId: null,
      txHash: null,
    };
    const dto = mapRawToIngestDTO(raw, 'inv_002');

    expect(dto.eventId).toBe('camel_001');
    expect(dto.eventType).toBe('escrow_funded');
    expect(dto.ledgerSequence).toBe(300);
    expect(dto.pagingToken).toBe('300-1');
  });

  test('defaults missing id to empty string', () => {
    const dto = mapRawToIngestDTO({}, 'inv_003');
    expect(dto.eventId).toBe('');
  });

  test('defaults missing type to "contract_event"', () => {
    const dto = mapRawToIngestDTO({}, 'inv_004');
    expect(dto.eventType).toBe('contract_event');
  });

  test('defaults missing ledger to 0', () => {
    const dto = mapRawToIngestDTO({}, 'inv_005');
    expect(dto.ledgerSequence).toBe(0);
  });

  test('defaults missing paging_token to empty string', () => {
    const dto = mapRawToIngestDTO({}, 'inv_006');
    expect(dto.pagingToken).toBe('');
  });

  test('maps null contract_id to null', () => {
    const dto = mapRawToIngestDTO(makeHorizonRecord({ contract_id: null }), 'inv_007');
    expect(dto.contractId).toBeNull();
  });

  test('maps null tx_hash to null', () => {
    const dto = mapRawToIngestDTO(makeHorizonRecord({ tx_hash: null }), 'inv_008');
    expect(dto.txHash).toBeNull();
  });

  test('eventBody defaults to the full raw record when not specified', () => {
    const raw = makeHorizonRecord();
    const dto = mapRawToIngestDTO(raw, 'inv_009');
    expect(dto.eventBody).toBe(raw);
  });

  test('uses explicit eventBody field when provided', () => {
    const body = { foo: 'bar' };
    const dto = mapRawToIngestDTO({ ...makeHorizonRecord(), eventBody: body }, 'inv_010');
    expect(dto.eventBody).toBe(body);
  });

  test('observedAt is a valid ISO-8601 string', () => {
    const dto = mapRawToIngestDTO({}, 'inv_011');
    expect(() => new Date(dto.observedAt)).not.toThrow();
    expect(new Date(dto.observedAt).toISOString()).toBe(dto.observedAt);
  });

  test('uses provided observedAt when present', () => {
    const ts = '2026-05-01T08:00:00.000Z';
    const dto = mapRawToIngestDTO({ observedAt: ts }, 'inv_012');
    expect(dto.observedAt).toBe(ts);
  });

  test('returned DTO is frozen', () => {
    const dto = mapRawToIngestDTO(makeHorizonRecord(), 'inv_013');
    expect(Object.isFrozen(dto)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. mapIngestDTOToNormalized
// ─────────────────────────────────────────────────────────────────────────────

describe('mapIngestDTOToNormalized()', () => {
  function makeIngestDTO(overrides = {}) {
    return {
      eventId: 'evt_n001',
      invoiceId: 'inv_n001',
      eventType: 'escrow_created',
      ledgerSequence: 500,
      pagingToken: '500-1',
      contractId: 'CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI',
      txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      eventBody: { amount: '100' },
      observedAt: '2026-03-01T00:00:00.000Z',
      ...overrides,
    };
  }

  test('passes all fields through to normalized shape', () => {
    const normalized = mapIngestDTOToNormalized(makeIngestDTO());
    expect(normalized.eventId).toBe('evt_n001');
    expect(normalized.invoiceId).toBe('inv_n001');
    expect(normalized.eventType).toBe('escrow_created');
    expect(normalized.ledgerSequence).toBe(500);
    expect(normalized.pagingToken).toBe('500-1');
    expect(normalized.contractId).toBe('CDLZFC3SYJ27SBCC6BAKCY73WFXHBTE357R67CW567QX65ECUGN45RXI');
    expect(normalized.txHash).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(normalized.eventBody).toEqual({ amount: '100' });
    expect(normalized.observedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  test('passes null contractId and txHash through unchanged', () => {
    const normalized = mapIngestDTOToNormalized(makeIngestDTO({ contractId: null, txHash: null }));
    expect(normalized.contractId).toBeNull();
    expect(normalized.txHash).toBeNull();
  });

  test('round-trip: raw → ingestDTO → normalized → same field values', () => {
    const raw = makeHorizonRecord();
    const ingestDTO = mapRawToIngestDTO(raw, 'inv_rt');
    const normalized = mapIngestDTOToNormalized(ingestDTO);

    expect(normalized.eventId).toBe(ingestDTO.eventId);
    expect(normalized.invoiceId).toBe(ingestDTO.invoiceId);
    expect(normalized.ledgerSequence).toBe(ingestDTO.ledgerSequence);
    expect(normalized.pagingToken).toBe(ingestDTO.pagingToken);
    expect(normalized.contractId).toBe(ingestDTO.contractId);
    expect(normalized.txHash).toBe(ingestDTO.txHash);
    expect(normalized.observedAt).toBe(ingestDTO.observedAt);
  });

  test('normalized shape contains exactly the expected keys', () => {
    const normalized = mapIngestDTOToNormalized(makeIngestDTO());
    const keys = Object.keys(normalized).sort();
    expect(keys).toEqual([
      'contractId', 'eventBody', 'eventId', 'eventType',
      'invoiceId', 'ledgerSequence', 'observedAt', 'pagingToken', 'txHash',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Integration: service already maps rows — mapServiceResultToResponseDTO
//    must not double-map when given already-mapped DTO rows
// ─────────────────────────────────────────────────────────────────────────────

describe('double-mapping guard', () => {
  test('mapServiceResultToResponseDTO correctly maps raw DB rows (service internal use)', () => {
    // The service passes raw snake_case DB rows to mapServiceResultToResponseDTO.
    // This test verifies the correct path: raw rows → DTO.
    const rawRow = makeRow({ event_id: 'dm_01' });
    const dto = mapServiceResultToResponseDTO({
      data: [rawRow],
      meta: { total: 1, limit: 20, hasMore: false, nextCursor: null },
    });

    expect(dto.data[0].eventId).toBe('dm_01');
    expect(dto.data[0].invoiceId).toBe('inv_001');
    expect(typeof dto.data[0].ledgerSequence).toBe('number');
  });

  test('service boundary: mapRowToEscrowEventDTO reads snake_case source columns', () => {
    // Regression guard: confirm the mapper reads event_id (not eventId) from the raw row.
    const raw = makeRow({ event_id: 'snake_check' });
    const dto = mapRowToEscrowEventDTO(raw);
    expect(dto.eventId).toBe('snake_check');
    // If a camelCase-only object were passed, event_id would be undefined → 'undefined' string
    const broken = { eventId: 'camel_only', invoice_id: 'i', event_type: 'et', ledger_sequence: 1,
      observed_at: null, created_at: null };
    const brokenDTO = mapRowToEscrowEventDTO(broken);
    expect(brokenDTO.eventId).toBe('undefined'); // documents the expected behaviour
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Exports contract — all expected names are exported
// ─────────────────────────────────────────────────────────────────────────────

describe('module exports', () => {
  const dtoModule = require('../src/dto/indexer');

  const expectedExports = [
    'mapQueryToDTO',
    'mapDTOToServiceParams',
    'mapRowToEscrowEventDTO',
    'mapEscrowEventDTOToRow',
    'mapMetaToDTO',
    'mapServiceResultToResponseDTO',
    'mapRawToIngestDTO',
    'mapIngestDTOToNormalized',
  ];

  test.each(expectedExports)('exports %s as a function', (name) => {
    expect(typeof dtoModule[name]).toBe('function');
  });

  test('does not export unexpected symbols', () => {
    const exported = Object.keys(dtoModule);
    const unexpected = exported.filter((k) => !expectedExports.includes(k));
    expect(unexpected).toHaveLength(0);
  });
});
