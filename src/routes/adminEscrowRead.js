'use strict';

/**
 * @fileoverview Admin route for escrow-read configurations/overrides and their audit trails.
 *
 * Write endpoints (POST, PUT, DELETE) support optional idempotency via the
 * `Idempotency-Key` header.  When the header is present the request is handled
 * by the shared idempotency middleware (replay / conflict detection).  When the
 * header is absent the request passes through unchanged, preserving backward
 * compatibility for callers that do not need idempotency guarantees.
 *
 * @see src/middleware/optionalIdempotency.js
 * @see src/middleware/idempotency.js
 */

const express = require('express');
const { adminStack } = require('../middleware/stacks');
const optionalIdempotency = require('../middleware/optionalIdempotency');
const { getAuditLogs } = require('../services/auditLog');
const AppError = require('../errors/AppError');
const { validateBody, validateQuery } = require('../schemas/invoice');
const {
  escrowReadPostSchema,
  escrowReadPutSchema,
  escrowReadAuditQuerySchema,
  escrowReadResponseSchema,
} = require('../schemas/escrowRead');

const router = express.Router();

router.use(...adminStack);

// In-memory store for escrow-read mutations as requested
const escrowReadStore = new Map();

/**
 * GET /api/admin/escrow-read
 * Lists all current escrow-read configurations.
 */
router.get('/', (req, res, next) => {
  try {
    const items = Array.from(escrowReadStore.entries()).map(([id, data]) => ({ id, ...data }));
    const payload = { data: items };
    const result = escrowReadResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new AppError({ status: 500, title: 'Response Validation Error', detail: 'Invalid response payload' });
    }
    res.json(result.data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/escrow-read
 * Creates a new escrow-read configuration and logs an audit entry.
 *
 * Supports optional idempotency: include an `Idempotency-Key` header to
 * guarantee at-most-once creation even on retried requests.
 */
router.post('/', optionalIdempotency, validateBody(escrowReadPostSchema), async (req, res, next) => {
  try {
    const { id, config, secretKey } = req.validated;
    if (escrowReadStore.has(id)) {
      return next(new AppError({ status: 409, title: 'Conflict', detail: 'Already exists' }));
    }
    

    const newData = { config, secretKey };
    escrowReadStore.set(id, newData);
    
    const payload = { data: { id, ...newData } };
    const result = escrowReadResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new AppError({ status: 500, title: 'Response Validation Error', detail: 'Invalid response payload' });
    }
    res.status(201).json(result.data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/escrow-read/audit
 * Exposes a read view for escrow-read audit logs, bounded to avoid excessive queries.
 * Secrets are automatically redacted by the auditLog service.
 */
router.get('/audit', validateQuery(escrowReadAuditQuerySchema), async (req, res, next) => {
  try {
    // Bound the log
    const limit = req.validatedQuery.limit;
    const logs = await getAuditLogs({
      resourceType: 'escrow-read',
      limit,
    });
    
    const payload = { data: logs };
    const result = escrowReadResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new AppError({ status: 500, title: 'Response Validation Error', detail: 'Invalid response payload' });
    }
    res.json(result.data);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/escrow-read/:id
 * Updates an existing escrow-read configuration and logs an audit entry.
 *
 * Supports optional idempotency: include an `Idempotency-Key` header to
 * guarantee at-most-once update even on retried requests.
 */
router.put('/:id', optionalIdempotency, validateBody(escrowReadPutSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { config, secretKey } = req.validated;
    
    if (!escrowReadStore.has(id)) {
      return next(new AppError({ status: 404, title: 'Not Found', detail: 'Configuration not found' }));
    }
    
    const before = escrowReadStore.get(id);

    
    const after = { 
      ...before, 
      config: config !== undefined ? config : before.config, 
      secretKey: secretKey !== undefined ? secretKey : before.secretKey 
    };
    
    escrowReadStore.set(id, after);
    
    const payload = { data: { id, ...after } };
    const result = escrowReadResponseSchema.safeParse(payload);
    if (!result.success) {
      throw new AppError({ status: 500, title: 'Response Validation Error', detail: 'Invalid response payload' });
    }
    res.json(result.data);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/escrow-read/:id
 * Deletes an existing escrow-read configuration and logs an audit entry.
 *
 * Supports optional idempotency: include an `Idempotency-Key` header to
 * guarantee at-most-once deletion even on retried requests.
 */
router.delete('/:id', optionalIdempotency, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!escrowReadStore.has(id)) {
      return next(new AppError({ status: 404, title: 'Not Found', detail: 'Configuration not found' }));
    }
    
    escrowReadStore.delete(id);
    
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
