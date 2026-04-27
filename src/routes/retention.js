'use strict';

const express = require('express');
const { z } = require('zod');
const db = require('../db/knex');
const retentionJob = require('../jobs/retentionPurge');
const { authenticateToken } = require('../middleware/auth');
const { apiKeyAuth } = require('../middleware/apiKey');
const { sensitiveLimiter } = require('../middleware/rateLimit');
const AppError = require('../errors/AppError');
const logger = require('../logger');

const router = express.Router();

/**
 * Combined authentication middleware: allows JWT or API key for admin/service auth
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @returns {void}
 */
function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return apiKeyAuth(req, res, next);
  } else {
    return authenticateToken(req, res, next);
  }
}

// Validation schemas
const CreatePolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  retentionDays: z.number().positive().max(36500), // Max 100 years
  piiFields: z.array(z.enum(['customer_name', 'customer_email', 'customer_tax_id'])).min(1),
  isActive: z.boolean().default(true)
});

const CreateLegalHoldSchema = z.object({
  invoiceId: z.string().uuid(),
  holdReason: z.string().min(1),
  holdType: z.enum(['litigation', 'investigation', 'audit', 'regulatory']),
  expiresAt: z.string().datetime().optional(),
  metadata: z.object({}).optional()
});

const ScheduleJobSchema = z.object({
  policyId: z.string().uuid().optional(),
  dryRun: z.boolean().default(true),
  retentionDays: z.number().positive().optional(),
  piiFields: z.array(z.enum(['customer_name', 'customer_email', 'customer_tax_id'])).optional(),
  batchSize: z.number().positive().max(1000).default(100),
  delayMs: z.number().min(0).default(0)
});

/**
 * @swagger
 * /api/retention/policies:
 *   get:
 *     summary: Get retention policies for tenant
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of retention policies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/RetentionPolicy'
 */
router.get('/policies', adminAuth, async (req, res) => {
  try {
    const { tenantId } = req;
    const { includeInactive = false } = req.query;

    let query = db('retention_policies').where({ tenant_id: tenantId });
    
    if (!includeInactive || includeInactive === 'false') {
      query = query.where({ is_active: true });
    }
    
    query = query.whereNull('deleted_at').orderBy('created_at', 'desc');

    const policies = await query;

    res.json({
      data: policies,
      message: `Found ${policies.length} retention policies`
    });
  } catch (error) {
    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error fetching retention policies');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to fetch retention policies'
    });
  }
});

/**
 * @swagger
 * /api/retention/policies:
 *   post:
 *     summary: Create a new retention policy
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateRetentionPolicy'
 *     responses:
 *       201:
 *         description: Policy created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/RetentionPolicy'
 */
router.post('/policies', adminAuth, sensitiveLimiter, async (req, res) => {
  try {
    const { tenantId } = req;
    const validatedData = CreatePolicySchema.parse(req.body);

    // Check if policy name already exists for this tenant
    const existing = await db('retention_policies')
      .where({ 
        tenant_id: tenantId, 
        name: validatedData.name,
        is_active: true 
      })
      .whereNull('deleted_at')
      .first();

    if (existing) {
      throw new AppError({
        type: 'https://liquifact.com/probs/conflict',
        title: 'Policy Already Exists',
        status: 409,
        detail: `Policy '${validatedData.name}' already exists for this tenant`
      });
    }

    const [policy] = await db('retention_policies')
      .insert({
        tenant_id: tenantId,
        name: validatedData.name,
        description: validatedData.description,
        retention_days: validatedData.retentionDays,
        pii_fields: validatedData.piiFields,
        is_active: validatedData.isActive
      })
      .returning('*');

    logger.info({
      tenantId,
      policyId: policy.id,
      policyName: policy.name
    }, 'Retention policy created');

    res.status(201).json({
      data: policy,
      message: 'Retention policy created successfully'
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: error.errors.map(e => e.message).join(', ')
      });
    }

    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error creating retention policy');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to create retention policy'
    });
  }
});

/**
 * @swagger
 * /api/retention/policies/{policyId}:
 *   put:
 *     summary: Update a retention policy
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: policyId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Policy updated successfully
 */
router.put('/policies/:policyId', adminAuth, sensitiveLimiter, async (req, res) => {
  try {
    const { tenantId } = req;
    const { policyId } = req.params;
    const validatedData = CreatePolicySchema.partial().parse(req.body);

    const existing = await db('retention_policies')
      .where({ id: policyId, tenant_id: tenantId })
      .whereNull('deleted_at')
      .first();

    if (!existing) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Policy Not Found',
        status: 404,
        detail: 'Retention policy not found'
      });
    }

    const [updatedPolicy] = await db('retention_policies')
      .where({ id: policyId, tenant_id: tenantId })
      .update({
        ...validatedData,
        updated_at: new Date()
      })
      .returning('*');

    logger.info({
      tenantId,
      policyId,
      policyName: updatedPolicy.name,
      changes: validatedData
    }, 'Retention policy updated');

    res.json({
      data: updatedPolicy,
      message: 'Retention policy updated successfully'
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: error.errors.map(e => e.message).join(', ')
      });
    }

    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error updating retention policy');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to update retention policy'
    });
  }
});

/**
 * @swagger
 * /api/retention/legal-holds:
 *   get:
 *     summary: Get legal holds for tenant
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of legal holds
 */
router.get('/legal-holds', adminAuth, async (req, res) => {
  try {
    const { tenantId } = req;
    const { status, invoiceId } = req.query;

    let query = db('legal_holds')
      .where({ tenant_id: tenantId })
      .leftJoin('invoices', 'legal_holds.invoice_id', 'invoices.id')
      .select(
        'legal_holds.*',
        'invoices.invoice_number'
      );

    if (status) {
      query = query.where('legal_holds.status', status);
    }

    if (invoiceId) {
      query = query.where('legal_holds.invoice_id', invoiceId);
    }

    const holds = await query.orderBy('legal_holds.created_at', 'desc');

    res.json({
      data: holds,
      message: `Found ${holds.length} legal holds`
    });
  } catch (error) {
    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error fetching legal holds');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to fetch legal holds'
    });
  }
});

/**
 * @swagger
 * /api/retention/legal-holds:
 *   post:
 *     summary: Create a legal hold
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateLegalHold'
 *     responses:
 *       201:
 *         description: Legal hold created successfully
 */
router.post('/legal-holds', adminAuth, sensitiveLimiter, async (req, res) => {
  try {
    const { tenantId } = req;
    const validatedData = CreateLegalHoldSchema.parse(req.body);

    // Verify invoice exists and belongs to tenant
    const invoice = await db('invoices')
      .where({ id: validatedData.invoiceId, tenant_id: tenantId })
      .whereNull('deleted_at')
      .first();

    if (!invoice) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Invoice Not Found',
        status: 404,
        detail: 'Invoice not found or does not belong to this tenant'
      });
    }

    // Check if active hold already exists
    const existingHold = await db('legal_holds')
      .where({ 
        invoice_id: validatedData.invoiceId,
        status: 'active'
      })
      .where(function() {
        this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
      })
      .first();

    if (existingHold) {
      throw new AppError({
        type: 'https://liquifact.com/probs/conflict',
        title: 'Legal Hold Already Exists',
        status: 409,
        detail: 'An active legal hold already exists for this invoice'
      });
    }

    const [hold] = await db('legal_holds')
      .insert({
        tenant_id: tenantId,
        invoice_id: validatedData.invoiceId,
        hold_reason: validatedData.holdReason,
        hold_type: validatedData.holdType,
        expires_at: validatedData.expiresAt ? new Date(validatedData.expiresAt) : null,
        placed_by: req.userId,
        metadata: validatedData.metadata || {}
      })
      .returning('*');

    logger.info({
      tenantId,
      holdId: hold.id,
      invoiceId: validatedData.invoiceId,
      invoiceNumber: invoice.invoice_number,
      holdType: validatedData.holdType
    }, 'Legal hold created');

    res.status(201).json({
      data: hold,
      message: 'Legal hold created successfully'
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: error.errors.map(e => e.message).join(', ')
      });
    }

    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error creating legal hold');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to create legal hold'
    });
  }
});

/**
 * @swagger
 * /api/retention/legal-holds/{holdId}/release:
 *   post:
 *     summary: Release a legal hold
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: holdId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               releaseReason:
 *                 type: string
 *                 description: Reason for releasing the hold
 *     responses:
 *       200:
 *         description: Legal hold released successfully
 */
router.post('/legal-holds/:holdId/release', adminAuth, sensitiveLimiter, async (req, res) => {
  try {
    const { tenantId } = req;
    const { holdId } = req.params;
    const { releaseReason } = req.body;

    const hold = await db('legal_holds')
      .where({ id: holdId, tenant_id: tenantId, status: 'active' })
      .first();

    if (!hold) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Legal Hold Not Found',
        status: 404,
        detail: 'Active legal hold not found'
      });
    }

    const [releasedHold] = await db('legal_holds')
      .where({ id: holdId })
      .update({
        status: 'released',
        released_at: new Date(),
        release_reason: releaseReason || 'Released by user'
      })
      .returning('*');

    logger.info({
      tenantId,
      holdId,
      invoiceId: hold.invoice_id,
      releaseReason
    }, 'Legal hold released');

    res.json({
      data: releasedHold,
      message: 'Legal hold released successfully'
    });
  } catch (error) {
    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error releasing legal hold');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to release legal hold'
    });
  }
});

/**
 * @swagger
 * /api/retention/jobs/schedule:
 *   post:
 *     summary: Schedule a retention job
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ScheduleRetentionJob'
 *     responses:
 *       201:
 *         description: Job scheduled successfully
 */
router.post('/jobs/schedule', adminAuth, sensitiveLimiter, async (req, res) => {
  try {
    const { tenantId } = req;
    const validatedData = ScheduleJobSchema.parse(req.body);

    // Validate policy if specified
    if (validatedData.policyId) {
      const policy = await db('retention_policies')
        .where({ 
          id: validatedData.policyId, 
          tenant_id: tenantId, 
          is_active: true 
        })
        .whereNull('deleted_at')
        .first();

      if (!policy) {
        throw new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Policy Not Found',
          status: 404,
          detail: 'Active retention policy not found'
        });
      }
    }

    // Validate PII fields if specified
    if (validatedData.piiFields) {
      retentionJob.validatePiiFields(validatedData.piiFields);
    }

    const jobId = retentionJob.scheduleRetentionPurge({
      tenantId,
      policyId: validatedData.policyId,
      dryRun: validatedData.dryRun,
      retentionDays: validatedData.retentionDays,
      piiFields: validatedData.piiFields,
      performedBy: req.userId,
      batchSize: validatedData.batchSize,
      delayMs: validatedData.delayMs
    });

    logger.info({
      tenantId,
      jobId,
      policyId: validatedData.policyId,
      dryRun: validatedData.dryRun
    }, 'Retention job scheduled');

    res.status(201).json({
      data: { jobId },
      message: `Retention job scheduled successfully (${validatedData.dryRun ? 'dry run' : 'live'})`
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: error.errors.map(e => e.message).join(', ')
      });
    }

    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error scheduling retention job');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to schedule retention job'
    });
  }
});

/**
 * @swagger
 * /api/retention/jobs/{executionId}:
 *   get:
 *     summary: Get retention job execution status
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Job execution details
 */
router.get('/jobs/:executionId', adminAuth, async (req, res) => {
  try {
    const { tenantId } = req;
    const { executionId } = req.params;

    const execution = await retentionJob.getExecutionStatus(executionId);

    if (!execution || execution.tenant_id !== tenantId) {
      throw new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Execution Not Found',
        status: 404,
        detail: 'Retention job execution not found'
      });
    }

    res.json({
      data: execution,
      message: 'Job execution details retrieved successfully'
    });
  } catch (error) {
    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error fetching job execution');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to fetch job execution details'
    });
  }
});

/**
 * @swagger
 * /api/retention/jobs:
 *   get:
 *     summary: Get recent retention job executions
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *     responses:
 *       200:
 *         description: List of recent job executions
 */
router.get('/jobs', adminAuth, async (req, res) => {
  try {
    const { tenantId } = req;
    const { limit = 50 } = req.query;

    const executions = await retentionJob.getRecentExecutions(tenantId, Math.min(parseInt(limit), 100));

    res.json({
      data: executions,
      message: `Found ${executions.length} job executions`
    });
  } catch (error) {
    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error fetching job executions');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to fetch job executions'
    });
  }
});

/**
 * @swagger
 * /api/retention/audit:
 *   get:
 *     summary: Get retention audit log
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: operation
 *         schema:
 *           type: string
 *           enum: [pii_purged, policy_applied, hold_placed, hold_released, dry_run]
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 100
 *     responses:
 *       200:
 *         description: Audit log entries
 */
router.get('/audit', adminAuth, async (req, res) => {
  try {
    const { tenantId } = req;
    const { 
      startDate, 
      endDate, 
      operation, 
      invoiceId, 
      limit = 100 
    } = req.query;

    let query = db('retention_audit_log')
      .where({ tenant_id: tenantId });

    if (startDate) {
      query = query.where('performed_at', '>=', new Date(startDate));
    }

    if (endDate) {
      query = query.where('performed_at', '<=', new Date(endDate));
    }

    if (operation) {
      query = query.where('operation', operation);
    }

    if (invoiceId) {
      query = query.where('invoice_id', invoiceId);
    }

    const auditLogs = await query
      .orderBy('performed_at', 'desc')
      .limit(Math.min(parseInt(limit), 1000));

    res.json({
      data: auditLogs,
      message: `Found ${auditLogs.length} audit log entries`
    });
  } catch (error) {
    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error fetching audit log');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to fetch audit log'
    });
  }
});

/**
 * @swagger
 * /api/retention/preview:
 *   post:
 *     summary: Preview what would be purged (dry run)
 *     tags: [Retention]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               policyId:
 *                 type: string
 *                 format: uuid
 *               retentionDays:
 *                 type: number
 *                 positive: true
 *               piiFields:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [customer_name, customer_email, customer_tax_id]
 *     responses:
 *       200:
 *         description: Preview of purging results
 */
router.post('/preview', adminAuth, async (req, res) => {
  try {
    const { tenantId } = req;
    const { policyId, retentionDays, piiFields } = req.body;

    // Get active policies or use specified policy
    let policies;
    if (policyId) {
      const policy = await db('retention_policies')
        .where({ id: policyId, tenant_id: tenantId, is_active: true })
        .whereNull('deleted_at')
        .first();
      
      if (!policy) {
        throw new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Policy Not Found',
          status: 404,
          detail: 'Active retention policy not found'
        });
      }
      policies = [policy];
    } else {
      policies = await retentionJob.getActivePolicies(tenantId);
    }

    if (policies.length === 0) {
      return res.json({
        data: {
          eligibleInvoices: [],
          totalEligible: 0,
          policies: [],
          previewGenerated: new Date().toISOString()
        },
        message: 'No active retention policies found'
      });
    }

    // Calculate preview for each policy
    let totalEligible = 0;
    const previewData = [];

    for (const policy of policies) {
      const policyPiiFields = piiFields || policy.pii_fields;
      const policyRetentionDays = retentionDays || policy.retention_days;
      
      const eligibleInvoices = await retentionJob.getEligibleInvoices(tenantId, {
        ...policy,
        retention_days: policyRetentionDays
      }, 1000); // Limit preview to 1000 invoices

      totalEligible += eligibleInvoices.length;
      
      previewData.push({
        policyId: policy.id,
        policyName: policy.name,
        retentionDays: policyRetentionDays,
        piiFields: policyPiiFields,
        eligibleCount: eligibleInvoices.length,
        sampleInvoices: eligibleInvoices.slice(0, 10).map(inv => ({
          id: inv.id,
          invoiceNumber: inv.invoice_number,
          createdAt: inv.created_at,
          customerName: inv.customer_name,
          customerEmail: inv.customer_email,
          customerTaxId: inv.customer_tax_id
        }))
      });
    }

    res.json({
      data: {
        eligibleInvoices: previewData,
        totalEligible,
        policies: policies.map(p => ({
          id: p.id,
          name: p.name,
          retentionDays: p.retention_days,
          piiFields: p.pii_fields
        })),
        previewGenerated: new Date().toISOString()
      },
      message: `Preview generated for ${totalEligible} eligible invoices`
    });
  } catch (error) {
    if (error.type) {
      throw error;
    }

    logger.error({ error: error.message, tenantId: req.tenantId }, 'Error generating preview');
    throw new AppError({
      type: 'https://liquifact.com/probs/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Failed to generate preview'
    });
  }
});

module.exports = router;
