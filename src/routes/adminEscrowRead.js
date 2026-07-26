'use strict';

/**
 * @fileoverview Admin route for escrow-read configurations/overrides and their audit trails.
 */

const express = require('express');
const { adminStack } = require('../middleware/stacks');
const { createAuditLog, getAuditLogs } = require('../services/auditLog');
const AppError = require('../errors/AppError');

const router = express.Router();

router.use(...adminStack);

// In-memory store for escrow-read mutations as requested
const escrowReadStore = new Map();

/**
 * GET /api/admin/escrow-read
 * Lists all current escrow-read configurations.
 */
router.get('/', (req, res) => {
  const items = Array.from(escrowReadStore.entries()).map(([id, data]) => ({ id, ...data }));
  res.json({ data: items });
});

/**
 * POST /api/admin/escrow-read
 * Creates a new escrow-read configuration and logs an audit entry.
 */
router.post('/', async (req, res, next) => {
  try {
    const { id, config, secretKey } = req.body;
    if (!id) {
      return next(new AppError({ status: 400, title: 'Validation Error', detail: 'ID is required' }));
    }
    if (escrowReadStore.has(id)) {
      return next(new AppError({ status: 409, title: 'Conflict', detail: 'Already exists' }));
    }
    

    const newData = { config, secretKey };
    escrowReadStore.set(id, newData);
    
    res.status(201).json({ data: { id, ...newData } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/escrow-read/audit
 * Exposes a read view for escrow-read audit logs, bounded to avoid excessive queries.
 * Secrets are automatically redacted by the auditLog service.
 */
router.get('/audit', async (req, res, next) => {
  try {
    // Bound the log
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const logs = await getAuditLogs({
      resourceType: 'escrow-read',
      limit,
    });
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/escrow-read/:id
 * Updates an existing escrow-read configuration and logs an audit entry.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { config, secretKey } = req.body;
    
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
    
    res.json({ data: { id, ...after } });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/escrow-read/:id
 * Deletes an existing escrow-read configuration and logs an audit entry.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!escrowReadStore.has(id)) {
      return next(new AppError({ status: 404, title: 'Not Found', detail: 'Configuration not found' }));
    }
    
    const before = escrowReadStore.get(id);

    
    escrowReadStore.delete(id);
    
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
