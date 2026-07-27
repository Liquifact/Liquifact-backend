'use strict';

/**
 * @fileoverview OpenAPI Contract Tests for Invoice-State Endpoints (#1008)
 *
 * Asserts that invoice-state API responses conform to the OpenAPI document
 * generated from `@swagger` JSDoc annotations and shared component schemas.
 * Verifies response status, shape, strict type checking, and rejection of
 * undocumented fields.
 */

const request = require('supertest');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { buildOpenApiSpec, _resetCache } = require('../../src/openapi/openapiSpec');
const { createStandardizedApp } = require('../../src/app');
const invoiceStateService = require('../../src/services/invoiceStateService');
const { StateTransitionError } = require('../../src/services/invoiceStateService');

// Mock KYC gating middleware to bypass external KYC provider during contract tests
jest.mock('../../src/middleware/kycGating', () => ({
  requireKycForFunding: jest.fn((_req, _res, next) => next()),
  auditKycAccess: jest.fn((_req, _res, next) => next()),
}));

describe('Invoice State OpenAPI Contract Tests', () => {
  let app;
  let spec;
  let ajv;

  beforeAll(() => {
    _resetCache();
    spec = buildOpenApiSpec();

    ajv = new Ajv({
      allErrors: true,
      strict: false,
    });
    addFormats(ajv);

    // Register component schemas for $ref resolution
    const componentSchemas = (spec.components && spec.components.schemas) || {};
    for (const [name, schema] of Object.entries(componentSchemas)) {
      ajv.addSchema(schema, `#/components/schemas/${name}`);
    }

    app = createStandardizedApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('OpenAPI Spec Schema Registration', () => {
    it('registers all invoice-state endpoints in OpenAPI document paths', () => {
      expect(spec.paths['/api/invoices/{id}/approve']).toBeDefined();
      expect(spec.paths['/api/invoices/{id}/approve'].post).toBeDefined();

      expect(spec.paths['/api/invoices/{id}/link-escrow']).toBeDefined();
      expect(spec.paths['/api/invoices/{id}/link-escrow'].post).toBeDefined();

      expect(spec.paths['/api/invoices/{id}/reject']).toBeDefined();
      expect(spec.paths['/api/invoices/{id}/reject'].post).toBeDefined();

      expect(spec.paths['/api/invoices/{id}/history']).toBeDefined();
      expect(spec.paths['/api/invoices/{id}/history'].get).toBeDefined();
    });

    it('assigns unique operationIds to each invoice-state endpoint', () => {
      expect(spec.paths['/api/invoices/{id}/approve'].post.operationId).toBe('approveInvoiceState');
      expect(spec.paths['/api/invoices/{id}/link-escrow'].post.operationId).toBe('linkInvoiceEscrow');
      expect(spec.paths['/api/invoices/{id}/reject'].post.operationId).toBe('rejectInvoiceState');
      expect(spec.paths['/api/invoices/{id}/history'].get.operationId).toBe('getInvoiceStateHistory');
    });

    it('registers all invoice-state response schemas in components.schemas', () => {
      const { schemas } = spec.components;
      expect(schemas.InvoiceStateApproveResponse).toBeDefined();
      expect(schemas.InvoiceStateLinkEscrowResponse).toBeDefined();
      expect(schemas.InvoiceStateRejectResponse).toBeDefined();
      expect(schemas.InvoiceStateHistoryResponse).toBeDefined();
      expect(schemas.InvoiceStateErrorResponse).toBeDefined();
    });
  });

  describe('POST /api/invoices/:id/approve Contract Conformance', () => {
    it('matches InvoiceStateApproveResponse schema on 200 success', async () => {
      const mockResult = {
        invoiceId: 'inv-approve-100',
        previousState: 'pending',
        currentState: 'approved',
        transitionedAt: '2026-07-26T22:00:00.000Z',
        transitionedBy: 'user-actor-1',
        auditLogId: 'audit-log-100',
      };

      jest.spyOn(invoiceStateService, 'approve').mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/invoices/inv-approve-100/approve')
        .set('x-tenant-id', 'tenant-test')
        .send({ reason: 'Approved by management' });

      expect(res.status).toBe(200);

      const schema = spec.components.schemas.InvoiceStateApproveResponse;
      const validate = ajv.compile(schema);
      const valid = validate(res.body);

      if (!valid) {
        console.error('Ajv validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
      expect(res.body.data.invoiceId).toBe('inv-approve-100');
      expect(res.body.data.currentState).toBe('approved');
    });

    it('matches InvoiceStateErrorResponse schema on 400 state transition error', async () => {
      jest.spyOn(invoiceStateService, 'approve').mockRejectedValue(
        new StateTransitionError('Cannot approve an already approved invoice', 'INVALID_TRANSITION', 400)
      );

      const res = await request(app)
        .post('/api/invoices/inv-approve-100/approve')
        .set('x-tenant-id', 'tenant-test')
        .send({});

      expect(res.status).toBe(400);

      const schema = spec.components.schemas.InvoiceStateErrorResponse;
      const validate = ajv.compile(schema);
      const valid = validate(res.body);

      if (!valid) {
        console.error('Ajv validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('POST /api/invoices/:id/link-escrow Contract Conformance', () => {
    it('matches InvoiceStateLinkEscrowResponse schema on 200 success', async () => {
      const mockResult = {
        invoiceId: 'inv-escrow-200',
        previousState: 'approved',
        currentState: 'linked_escrow',
        escrowId: 'escrow-contract-888',
        transitionedAt: '2026-07-26T22:05:00.000Z',
        transitionedBy: 'user-actor-2',
        auditLogId: 'audit-log-200',
      };

      jest.spyOn(invoiceStateService, 'linkEscrow').mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/invoices/inv-escrow-200/link-escrow')
        .set('x-tenant-id', 'tenant-test')
        .send({ escrowId: 'escrow-contract-888', reason: 'Linked to Soroban contract' });

      expect(res.status).toBe(200);

      const schema = spec.components.schemas.InvoiceStateLinkEscrowResponse;
      const validate = ajv.compile(schema);
      const valid = validate(res.body);

      if (!valid) {
        console.error('Ajv validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
      expect(res.body.data.escrowId).toBe('escrow-contract-888');
    });

    it('supports null escrowId in InvoiceStateLinkEscrowResponse schema', async () => {
      const mockResult = {
        invoiceId: 'inv-escrow-201',
        previousState: 'approved',
        currentState: 'linked_escrow',
        escrowId: null,
        transitionedAt: '2026-07-26T22:05:00.000Z',
        transitionedBy: 'user-actor-2',
        auditLogId: 'audit-log-201',
      };

      jest.spyOn(invoiceStateService, 'linkEscrow').mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/invoices/inv-escrow-201/link-escrow')
        .set('x-tenant-id', 'tenant-test')
        .send({});

      expect(res.status).toBe(200);

      const schema = spec.components.schemas.InvoiceStateLinkEscrowResponse;
      const validate = ajv.compile(schema);
      expect(validate(res.body)).toBe(true);
    });
  });

  describe('POST /api/invoices/:id/reject Contract Conformance', () => {
    it('matches InvoiceStateRejectResponse schema on 200 success', async () => {
      const mockResult = {
        invoiceId: 'inv-reject-300',
        previousState: 'pending',
        currentState: 'rejected',
        reason: 'Fraud risk detected',
        transitionedAt: '2026-07-26T22:10:00.000Z',
        transitionedBy: 'risk-agent-1',
        auditLogId: 'audit-log-300',
      };

      jest.spyOn(invoiceStateService, 'reject').mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/invoices/inv-reject-300/reject')
        .set('x-tenant-id', 'tenant-test')
        .send({ reason: 'Fraud risk detected' });

      expect(res.status).toBe(200);

      const schema = spec.components.schemas.InvoiceStateRejectResponse;
      const validate = ajv.compile(schema);
      const valid = validate(res.body);

      if (!valid) {
        console.error('Ajv validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
      expect(res.body.data.reason).toBe('Fraud risk detected');
    });

    it('matches InvoiceStateErrorResponse schema on 400 missing reason', async () => {
      jest.spyOn(invoiceStateService, 'reject').mockRejectedValue(
        new StateTransitionError('Reason is required for rejection', 'MISSING_TRANSITION_REASON', 400)
      );

      const res = await request(app)
        .post('/api/invoices/inv-reject-300/reject')
        .set('x-tenant-id', 'tenant-test')
        .send({});

      expect(res.status).toBe(400);

      const schema = spec.components.schemas.InvoiceStateErrorResponse;
      const validate = ajv.compile(schema);
      expect(validate(res.body)).toBe(true);
      expect(res.body.error.code).toBe('MISSING_TRANSITION_REASON');
    });

    it('matches InvoiceStateErrorResponse schema on 404 invoice not found', async () => {
      jest.spyOn(invoiceStateService, 'reject').mockRejectedValue(
        new StateTransitionError('Invoice not found', 'INVOICE_NOT_FOUND', 404)
      );

      const res = await request(app)
        .post('/api/invoices/nonexistent-999/reject')
        .set('x-tenant-id', 'tenant-test')
        .send({ reason: 'Rejection test' });

      expect(res.status).toBe(404);

      const schema = spec.components.schemas.InvoiceStateErrorResponse;
      const validate = ajv.compile(schema);
      expect(validate(res.body)).toBe(true);
      expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
    });
  });

  describe('GET /api/invoices/:id/history Contract Conformance', () => {
    it('matches InvoiceStateHistoryResponse schema on 200 success', async () => {
      const mockResult = {
        invoiceId: 'inv-history-400',
        currentState: 'approved',
        transitions: [
          {
            id: 'audit-log-1',
            timestamp: '2026-07-26T21:00:00.000Z',
            actor: 'user-admin',
            fromState: 'pending',
            toState: 'approved',
            reason: 'Approved initial review',
            ipAddress: '127.0.0.1',
          },
        ],
        totalTransitions: 1,
      };

      jest.spyOn(invoiceStateService, 'getHistory').mockResolvedValue(mockResult);

      const res = await request(app)
        .get('/api/invoices/inv-history-400/history')
        .set('x-tenant-id', 'tenant-test');

      expect(res.status).toBe(200);

      const schema = spec.components.schemas.InvoiceStateHistoryResponse;
      const validate = ajv.compile(schema);
      const valid = validate(res.body);

      if (!valid) {
        console.error('Ajv validation errors:', validate.errors);
      }
      expect(valid).toBe(true);
      expect(res.body.data.totalTransitions).toBe(1);
    });
  });

  describe('Strict Edge Cases & Schema Violations', () => {
    it('rejects responses with undocumented extra fields (additionalProperties: false)', () => {
      const schema = spec.components.schemas.InvoiceStateApproveResponse;
      const validate = ajv.compile(schema);

      const payloadWithExtraField = {
        data: {
          invoiceId: 'inv-123',
          previousState: 'pending',
          currentState: 'approved',
          transitionedAt: '2026-07-26T22:00:00.000Z',
          transitionedBy: 'user-1',
          auditLogId: 'audit-1',
          undocumentedField: 'should fail validation',
        },
        meta: {
          timestamp: '2026-07-26T22:00:00.000Z',
          version: '0.1.0',
        },
        error: null,
        message: 'Invoice approved successfully',
      };

      expect(validate(payloadWithExtraField)).toBe(false);
      const extraFieldErrors = validate.errors.filter(
        (err) => err.keyword === 'additionalProperties'
      );
      expect(extraFieldErrors.length).toBeGreaterThan(0);
    });

    it('rejects responses with wrong field types', () => {
      const approveSchema = spec.components.schemas.InvoiceStateApproveResponse;
      const approveValidate = ajv.compile(approveSchema);

      const wrongTypePayload = {
        data: {
          invoiceId: 12345, // wrong type: number instead of string
          previousState: 'pending',
          currentState: 'approved',
          transitionedAt: '2026-07-26T22:00:00.000Z',
          transitionedBy: 'user-1',
          auditLogId: 'audit-1',
        },
        meta: {
          timestamp: '2026-07-26T22:00:00.000Z',
          version: '0.1.0',
        },
        error: null,
        message: 'Invoice approved successfully',
      };

      expect(approveValidate(wrongTypePayload)).toBe(false);

      const historySchema = spec.components.schemas.InvoiceStateHistoryResponse;
      const historyValidate = ajv.compile(historySchema);

      const wrongHistoryTypePayload = {
        data: {
          invoiceId: 'inv-123',
          currentState: 'approved',
          transitions: [],
          totalTransitions: 'one', // wrong type: string instead of integer
        },
        meta: {
          timestamp: '2026-07-26T22:00:00.000Z',
          version: '0.1.0',
        },
        error: null,
        message: 'Invoice transition history retrieved successfully',
      };

      expect(historyValidate(wrongHistoryTypePayload)).toBe(false);
    });

    it('rejects error responses missing required error properties', () => {
      const errorSchema = spec.components.schemas.InvoiceStateErrorResponse;
      const validate = ajv.compile(errorSchema);

      const invalidErrorPayload = {
        data: null,
        meta: {
          timestamp: '2026-07-26T22:00:00.000Z',
          version: '0.1.0',
        },
        error: {
          message: 'Error without code', // missing 'code'
        },
      };

      expect(validate(invalidErrorPayload)).toBe(false);
    });
  });
});
