/**
 * @fileoverview OpenAPI Contract Tests for Indexer Responses
 *
 * Validates that indexer endpoint responses conform to their documented
 * OpenAPI schemas, including:
 *   - Required fields presence and types
 *   - Field format compliance (date-time, etc.)
 *   - Rejection of undocumented fields (additionalProperties: false)
 *   - Proper pagination metadata
 *   - Bulk operation response structure
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { buildOpenApiSpec } = require('../../src/openapi/openapiSpec');

describe('Indexer OpenAPI Contract Tests', () => {
  let app;
  let spec;
  let ajv;

  beforeAll(() => {
    app = createApp();
    spec = buildOpenApiSpec();
    ajv = new Ajv({
      allErrors: true,
      strict: false,
    });
    addFormats(ajv);

    // Add all schemas to AJV so $ref resolution works
    Object.entries(spec.components.schemas).forEach(([name, schema]) => {
      ajv.addSchema(schema, `#/components/schemas/${name}`);
    });
  });

  describe('GET /api/admin/indexer/events', () => {
    it('should reject response with undocumented fields in data items', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            eventId: 'evt_123',
            invoiceId: 'inv_001',
            eventType: 'escrow_created',
            ledgerSequence: 100,
            pagingToken: '100-1',
            contractId: null,
            txHash: null,
            observedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:01Z',
            undocumentedField: 'bad', // Should be rejected
          },
        ],
        meta: {
          total: 1,
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
      expect(validate.errors.length).toBeGreaterThan(0);
    });

    it('should reject response with undocumented fields in meta', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: 0,
          limit: 20,
          hasMore: false,
          nextCursor: null,
          extraField: 'should not exist',
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should reject response with missing required field in data item', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            eventId: 'evt_123',
            invoiceId: 'inv_001',
            eventType: 'escrow_created',
            ledgerSequence: 100,
            // Missing required: observedAt
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        meta: {
          total: 1,
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject response with wrong type for ledgerSequence', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            eventId: 'evt_123',
            invoiceId: 'inv_001',
            eventType: 'escrow_created',
            ledgerSequence: 'should_be_number', // Wrong type
            pagingToken: null,
            contractId: null,
            txHash: null,
            observedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        meta: {
          total: 1,
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject response with invalid date-time format', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            eventId: 'evt_123',
            invoiceId: 'inv_001',
            eventType: 'escrow_created',
            ledgerSequence: 100,
            pagingToken: null,
            contractId: null,
            txHash: null,
            observedAt: 'not-a-valid-date', // Invalid format
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        meta: {
          total: 1,
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should accept valid response with minimal fields', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const validResponse = {
        data: [
          {
            eventId: 'evt_123',
            invoiceId: 'inv_001',
            eventType: 'escrow_created',
            ledgerSequence: 100,
            pagingToken: null,
            contractId: null,
            txHash: null,
            observedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        meta: {
          total: 1,
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(validResponse)).toBe(true);
    });

    it('should accept valid response with all optional fields', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const validResponse = {
        data: [
          {
            eventId: 'evt_123',
            invoiceId: 'inv_001',
            eventType: 'escrow_created',
            ledgerSequence: 100,
            pagingToken: '100-1',
            contractId: 'CBQHQ6Z27WKXGFXB7STQRHJQKYHV6OXA26JVVVFLYXQVL6K4LNYUCMWX',
            txHash: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
            observedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        meta: {
          total: 1,
          limit: 20,
          hasMore: true,
          nextCursor: 'cursor_123',
          page: 1,
          totalPages: 5,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(validResponse)).toBe(true);
    });

    it('should accept empty list response', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const validResponse = {
        data: [],
        meta: {
          total: 0,
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(validResponse)).toBe(true);
    });

    it('should reject response missing required meta fields', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: 0,
          // Missing required: limit
          hasMore: false,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject response with negative total in meta', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: -1, // Invalid: minimum is 0
          limit: 20,
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject response with limit outside valid range', () => {
      const schema = spec.components.schemas.IndexerListResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: 0,
          limit: 150, // Invalid: maximum is 100
          hasMore: false,
          nextCursor: null,
        },
        message: 'Indexer events retrieved successfully.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });
  });

  describe('POST /api/admin/indexer/events/bulk', () => {
    it('should accept valid bulk response with all items succeeded', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const validResponse = {
        data: [
          {
            index: 0,
            success: true,
            error: null,
            eventId: 'evt_123',
          },
          {
            index: 1,
            success: true,
            error: null,
            eventId: 'evt_124',
          },
        ],
        meta: {
          total: 2,
          succeeded: 2,
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(validResponse)).toBe(true);
    });

    it('should accept valid bulk response with partial failures', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const validResponse = {
        data: [
          {
            index: 0,
            success: true,
            error: null,
            eventId: 'evt_123',
          },
          {
            index: 1,
            success: false,
            error: 'invoiceId must be 1-128 alphanumeric characters',
            eventId: null,
          },
        ],
        meta: {
          total: 2,
          succeeded: 1,
          failed: 1,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(validResponse)).toBe(true);
    });

    it('should accept empty bulk response', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const validResponse = {
        data: [],
        meta: {
          total: 0,
          succeeded: 0,
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(validResponse)).toBe(true);
    });

    it('should reject bulk response with undocumented fields in result item', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            index: 0,
            success: true,
            error: null,
            eventId: 'evt_123',
            extraField: 'bad', // Should be rejected
          },
        ],
        meta: {
          total: 1,
          succeeded: 1,
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should reject bulk response missing required result item fields', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            index: 0,
            // Missing required: success
            error: null,
            eventId: 'evt_123',
          },
        ],
        meta: {
          total: 1,
          succeeded: 1,
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject bulk response with wrong type for success', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [
          {
            index: 0,
            success: 'true', // Should be boolean
            error: null,
            eventId: 'evt_123',
          },
        ],
        meta: {
          total: 1,
          succeeded: 1,
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject bulk response with undocumented fields in meta', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: 0,
          succeeded: 0,
          failed: 0,
          extraField: 'should_not_exist', // Should be rejected
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject bulk response missing required meta fields', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: 0,
          // Missing required: succeeded
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });

    it('should reject bulk response with negative counts in meta', () => {
      const schema = spec.components.schemas.IndexerBulkResponse;
      const validate = ajv.compile(schema);

      const invalidResponse = {
        data: [],
        meta: {
          total: 0,
          succeeded: -1, // Invalid: minimum is 0
          failed: 0,
        },
        message: 'Bulk indexer events processed.',
      };

      expect(validate(invalidResponse)).toBe(false);
    });
  });

  describe('Escrow Event Row Schema', () => {
    it('should accept event row with all nullable fields as null', () => {
      const schema = spec.components.schemas.EscrowEventRow;
      const validate = ajv.compile(schema);

      const validRow = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        pagingToken: null,
        contractId: null,
        txHash: null,
        observedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:01Z',
      };

      expect(validate(validRow)).toBe(true);
    });

    it('should accept event row with all optional fields populated', () => {
      const schema = spec.components.schemas.EscrowEventRow;
      const validate = ajv.compile(schema);

      const validRow = {
        eventId: 'evt_abc123def456',
        invoiceId: 'inv_xyz789',
        eventType: 'escrow_funded',
        ledgerSequence: 99999999,
        pagingToken: '99999999-1',
        contractId: 'CBQHQ6Z27WKXGFXB7STQRHJQKYHV6OXA26JVVVFLYXQVL6K4LNYUCMWX',
        txHash: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
        observedAt: '2025-12-31T23:59:59Z',
        createdAt: '2025-12-31T23:59:59Z',
      };

      expect(validate(validRow)).toBe(true);
    });

    it('should reject event row with missing required field', () => {
      const schema = spec.components.schemas.EscrowEventRow;
      const validate = ajv.compile(schema);

      const invalidRow = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        // Missing required: ledgerSequence
        pagingToken: null,
        contractId: null,
        txHash: null,
        observedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:01Z',
      };

      expect(validate(invalidRow)).toBe(false);
    });

    it('should reject event row with undocumented field', () => {
      const schema = spec.components.schemas.EscrowEventRow;
      const validate = ajv.compile(schema);

      const invalidRow = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        pagingToken: null,
        contractId: null,
        txHash: null,
        observedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:01Z',
        maliciousField: 'should_not_exist',
      };

      expect(validate(invalidRow)).toBe(false);
    });

    it('should reject event row with negative ledgerSequence', () => {
      const schema = spec.components.schemas.EscrowEventRow;
      const validate = ajv.compile(schema);

      const invalidRow = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: -1, // Invalid: minimum is 0
        pagingToken: null,
        contractId: null,
        txHash: null,
        observedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:01Z',
      };

      expect(validate(invalidRow)).toBe(false);
    });
  });

  describe('Indexer Event Request Schema', () => {
    it('should accept valid indexer event request', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const validEvent = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        pagingToken: 'paging_token_123',
        contractId: 'CBQHQ6Z27WKXGFXB7STQRHJQKYHV6OXA26JVVVFLYXQVL6K4LNYUCMWX',
        txHash: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
        eventBody: { test: 'data' },
        observedAt: '2026-01-01T00:00:00Z',
      };

      expect(validate(validEvent)).toBe(true);
    });

    it('should accept minimal valid indexer event request', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const validEvent = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 100,
      };

      expect(validate(validEvent)).toBe(true);
    });

    it('should reject indexer event with missing required field', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const invalidEvent = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        // Missing required: eventType
        ledgerSequence: 100,
      };

      expect(validate(invalidEvent)).toBe(false);
    });

    it('should reject indexer event with invalid ledgerSequence type', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const invalidEvent = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 'not_a_number', // Wrong type
      };

      expect(validate(invalidEvent)).toBe(false);
    });

    it('should reject indexer event with negative ledgerSequence', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const invalidEvent = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 0, // Invalid: minimum is 1
      };

      expect(validate(invalidEvent)).toBe(false);
    });

    it('should reject indexer event with exceeded maxLength', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const invalidEvent = {
        eventId: 'a'.repeat(257), // Exceeds maxLength: 256
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 100,
      };

      expect(validate(invalidEvent)).toBe(false);
    });

    it('should reject indexer event with undocumented field', () => {
      const schema = spec.components.schemas.IndexerEvent;
      const validate = ajv.compile(schema);

      const invalidEvent = {
        eventId: 'evt_123',
        invoiceId: 'inv_001',
        eventType: 'escrow_created',
        ledgerSequence: 100,
        undocumentedField: 'should_not_exist',
      };

      expect(validate(invalidEvent)).toBe(false);
    });
  });

  describe('Schema Consistency Tests', () => {
    it('should have consistent required fields across schemas', () => {
      const listResponse = spec.components.schemas.IndexerListResponse;
      const bulkResponse = spec.components.schemas.IndexerBulkResponse;

      // Both should require data, meta, and message
      expect(listResponse.required).toContain('data');
      expect(listResponse.required).toContain('meta');
      expect(listResponse.required).toContain('message');

      expect(bulkResponse.required).toContain('data');
      expect(bulkResponse.required).toContain('meta');
      expect(bulkResponse.required).toContain('message');
    });

    it('should define EscrowEventRow schema', () => {
      expect(spec.components.schemas.EscrowEventRow).toBeDefined();
      expect(spec.components.schemas.EscrowEventRow.type).toBe('object');
      expect(spec.components.schemas.EscrowEventRow.additionalProperties).toBe(false);
    });

    it('should define IndexerEvent schema', () => {
      expect(spec.components.schemas.IndexerEvent).toBeDefined();
      expect(spec.components.schemas.IndexerEvent.type).toBe('object');
      expect(spec.components.schemas.IndexerEvent.additionalProperties).toBe(false);
    });

    it('should define pagination metadata schema', () => {
      expect(spec.components.schemas.IndexerListMeta).toBeDefined();
      expect(spec.components.schemas.IndexerListMeta.type).toBe('object');
      expect(spec.components.schemas.IndexerListMeta.required).toContain('total');
      expect(spec.components.schemas.IndexerListMeta.required).toContain('limit');
      expect(spec.components.schemas.IndexerListMeta.required).toContain('hasMore');
    });

    it('should define bulk metadata schema', () => {
      expect(spec.components.schemas.IndexerBulkMeta).toBeDefined();
      expect(spec.components.schemas.IndexerBulkMeta.type).toBe('object');
      expect(spec.components.schemas.IndexerBulkMeta.required).toContain('total');
      expect(spec.components.schemas.IndexerBulkMeta.required).toContain('succeeded');
      expect(spec.components.schemas.IndexerBulkMeta.required).toContain('failed');
    });

    it('should define bulk result item schema', () => {
      expect(spec.components.schemas.IndexerBulkResultItem).toBeDefined();
      expect(spec.components.schemas.IndexerBulkResultItem.type).toBe('object');
      expect(spec.components.schemas.IndexerBulkResultItem.required).toContain('index');
      expect(spec.components.schemas.IndexerBulkResultItem.required).toContain('success');
    });
  });
});
