'use strict';

const db = require('../db/knex');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { z } = require('zod');

/**
 * Schema for retention job payload validation
 */
const RetentionJobSchema = z.object({
  tenantId: z.string().uuid(),
  policyId: z.string().uuid().optional(),
  dryRun: z.boolean().default(false),
  retentionDays: z.number().positive().optional(),
  piiFields: z.array(z.string()).optional(),
  performedBy: z.string().uuid().optional(),
  batchSize: z.number().positive().max(1000).default(100),
});

/**
 * Schema for PII field validation
 */
const PiiFieldsSchema = z.array(z.enum(['customer_name', 'customer_email', 'customer_tax_id']));

/**
 * Internal mapping of job IDs to execution contexts
 * @type {Map<string, Object>}
 */
const jobExecutions = new Map();

const retentionQueue = new JobQueue();
const retentionWorker = new BackgroundWorker({ 
  jobQueue: retentionQueue,
  maxConcurrency: 1, // Only one retention job at a time for safety
  pollIntervalMs: 5000
});

/**
 * Validates and sanitizes PII field names
 * @param {string[]} fields - Array of field names
 * @returns {string[]} - Validated PII field names
 */
function validatePiiFields(fields) {
  const result = PiiFieldsSchema.safeParse(fields);
  if (!result.success) {
    throw new Error(`Invalid PII fields: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Gets active retention policies for a tenant
 * @param {string} tenantId - Tenant UUID
 * @returns {Promise<Object[]>} - Array of active policies
 */
async function getActivePolicies(tenantId) {
  return db('retention_policies')
    .where({ tenant_id: tenantId, is_active: true })
    .whereNull('deleted_at');
}

/**
 * Checks if an invoice is under legal hold
 * @param {string} tenantId - Tenant UUID
 * @param {string} invoiceId - Invoice UUID
 * @returns {Promise<boolean>} - True if under active legal hold
 */
async function isUnderLegalHold(tenantId, invoiceId) {
  const hold = await db('legal_holds')
    .where({ 
      tenant_id: tenantId, 
      invoice_id: invoiceId, 
      status: 'active' 
    })
    .where(function() {
      this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
    })
    .first();

  return Boolean(hold);
}

/**
 * Gets invoices eligible for PII purging based on retention policy
 * @param {string} tenantId - Tenant UUID
 * @param {Object} policy - Retention policy
 * @param {number} batchSize - Maximum number of invoices to process
 * @returns {Promise<Object[]>} - Array of eligible invoices
 */
async function getEligibleInvoices(tenantId, policy, batchSize) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - policy.retention_days);

  return db('invoices')
    .where({ tenant_id: tenantId })
    .where('created_at', '<', cutoffDate)
    .whereNull('deleted_at')
    .whereNotIn('id', function() {
      this.select('invoice_id')
        .from('legal_holds')
        .where({ 
          tenant_id: tenantId, 
          status: 'active' 
        })
        .where(function() {
          this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
        });
    })
    .limit(batchSize);
}

/**
 * Purges PII from an invoice (or simulates for dry run)
 * @param {string} invoiceId - Invoice UUID
 * @param {string[]} piiFields - PII fields to purge
 * @param {boolean} dryRun - If true, only simulate the operation
 * @returns {Promise<Object>} - Result of the operation
 */
async function purgeInvoicePii(invoiceId, piiFields, dryRun = false) {
  const updateData = {};
  const oldValues = {};

  // Get current values for audit
  if (!dryRun) {
    const current = await db('invoices').where('id', invoiceId).first();
    if (current) {
      piiFields.forEach(field => {
        if (current[field] !== null) {
          oldValues[field] = current[field];
        }
      });
    }
  }

  // Prepare update data (set to null for purging)
  piiFields.forEach(field => {
    updateData[field] = null;
  });

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      purgedFields: piiFields,
      oldValues
    };
  }

  const result = await db('invoices')
    .where('id', invoiceId)
    .update(updateData);

  return {
    success: result > 0,
    dryRun: false,
    purgedFields: result > 0 ? piiFields : [],
    oldValues
  };
}

/**
 * Logs retention operation to audit trail
 * @param {Object} auditData - Audit log data
 */
async function logRetentionOperation(auditData) {
  await db('retention_audit_log').insert({
    tenant_id: auditData.tenantId,
    invoice_id: auditData.invoiceId,
    operation: auditData.operation,
    pii_fields: auditData.piiFields,
    old_values: auditData.oldValues || {},
    new_values: auditData.newValues || {},
    reason: auditData.reason,
    performed_by: auditData.performedBy,
    metadata: auditData.metadata || {}
  });
}

/**
 * Creates a retention job execution record
 * @param {Object} executionData - Execution record data
 * @returns {Promise<string>} - Execution ID
 */
async function createJobExecution(executionData) {
  const [execution] = await db('retention_job_executions')
    .insert({
      tenant_id: executionData.tenantId,
      job_type: executionData.jobType || 'scheduled_purge',
      status: 'started',
      dry_run: executionData.dryRun,
      performed_by: executionData.performedBy,
      metadata: executionData.metadata || {}
    })
    .returning('*');

  return execution.id;
}

/**
 * Updates retention job execution record
 * @param {string} executionId - Execution UUID
 * @param {Object} updateData - Update data
 */
async function updateJobExecution(executionId, updateData) {
  await db('retention_job_executions')
    .where('id', executionId)
    .update({
      ...updateData,
      completed_at: updateData.status === 'completed' || updateData.status === 'failed' 
        ? new Date() 
        : undefined
    });
}

/**
 * Main retention purge job handler
 */
retentionWorker.registerHandler('retention_purge', async (job) => {
  const { payload } = job;
  let executionId = null;
  const errors = [];

  try {
    // Validate job payload
    const validatedPayload = RetentionJobSchema.parse(payload);
    const {
      tenantId,
      policyId,
      dryRun = false,
      retentionDays,
      piiFields,
      performedBy,
      batchSize = 100
    } = validatedPayload;

    // Create job execution record
    executionId = await createJobExecution({
      tenantId,
      dryRun,
      performedBy,
      jobType: policyId ? 'manual_purge' : 'scheduled_purge',
      metadata: { policyId, retentionDays, piiFields, batchSize }
    });

    // Get applicable policies
    let policies;
    if (policyId) {
      const policy = await db('retention_policies')
        .where({ id: policyId, tenant_id: tenantId, is_active: true })
        .whereNull('deleted_at')
        .first();
      
      if (!policy) {
        throw new Error(`Retention policy ${policyId} not found or inactive`);
      }
      policies = [policy];
    } else {
      policies = await getActivePolicies(tenantId);
    }

    if (policies.length === 0) {
      throw new Error('No active retention policies found');
    }

    let totalProcessed = 0;
    let totalPurged = 0;
    const allPurgedFields = new Set();

    // Process each policy
    for (const policy of policies) {
      const policyPiiFields = piiFields || policy.pii_fields;
      const validatedFields = validatePiiFields(policyPiiFields);
      const policyRetentionDays = retentionDays || policy.retention_days;

      logger.info({
        tenantId,
        policyId: policy.id,
        dryRun,
        retentionDays: policyRetentionDays,
        piiFields: validatedFields
      }, 'Processing retention policy');

      // Get eligible invoices
      const eligibleInvoices = await getEligibleInvoices(tenantId, {
        ...policy,
        retention_days: policyRetentionDays
      }, batchSize);

      totalProcessed += eligibleInvoices.length;

      // Process each invoice
      for (const invoice of eligibleInvoices) {
        try {
          // Check legal hold again (in case it was added after initial query)
          const underHold = await isUnderLegalHold(tenantId, invoice.id);
          if (underHold) {
            logger.debug({
              tenantId,
              invoiceId: invoice.id,
              reason: 'legal_hold'
            }, 'Skipping invoice due to legal hold');
            continue;
          }

          // Purge PII
          const result = await purgeInvoicePii(invoice.id, validatedFields, dryRun);

          if (result.success) {
            totalPurged++;
            result.purgedFields.forEach(field => allPurgedFields.add(field));

            // Log audit trail
            await logRetentionOperation({
              tenantId,
              invoiceId: invoice.id,
              operation: dryRun ? 'dry_run' : 'pii_purged',
              piiFields: result.purgedFields,
              oldValues: result.oldValues,
              reason: `Retention policy: ${policy.name} (${policyRetentionDays} days)`,
              performedBy,
              metadata: {
                policyId: policy.id,
                dryRun: result.dryRun,
                invoiceNumber: invoice.invoice_number
              }
            });

            logger.info({
              tenantId,
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoice_number,
              purgedFields: result.purgedFields,
              dryRun
            }, result.dryRun ? 'Dry run: Would purge PII' : 'Purged PII from invoice');
          }
        } catch (error) {
          const errorInfo = {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoice_number,
            error: error.message
          };
          errors.push(errorInfo);
          
          logger.error(errorInfo, 'Error processing invoice in retention job');
        }
      }
    }

    // Update job execution record
    await updateJobExecution(executionId, {
      status: errors.length > 0 ? 'completed_with_errors' : 'completed',
      invoices_processed: totalProcessed,
      invoices_purged: totalPurged,
      pii_fields_purged: Array.from(allPurgedFields),
      errors: errors.length > 0 ? errors : null
    });

    logger.info({
      tenantId,
      executionId,
      dryRun,
      totalProcessed,
      totalPurged,
      purgedFields: Array.from(allPurgedFields),
      errors: errors.length
    }, `Retention job ${dryRun ? 'dry run ' : ''}completed`);

  } catch (error) {
    logger.error({ 
      tenantId: payload.tenantId, 
      executionId, 
      error: error.message 
    }, 'Retention job failed');

    if (executionId) {
      await updateJobExecution(executionId, {
        status: 'failed',
        errors: [{ error: error.message, stack: error.stack }]
      });
    }

    throw error;
  } finally {
    // Clean up execution context
    if (job.id) {
      jobExecutions.delete(job.id);
    }
  }
});

/**
 * Schedule a retention purge job
 * @param {Object} options - Job options
 * @returns {string} - Job ID
 */
function scheduleRetentionPurge(options) {
  const {
    tenantId,
    policyId,
    dryRun = false,
    retentionDays,
    piiFields,
    performedBy,
    batchSize = 100,
    delayMs = 0
  } = options;

  const payload = {
    tenantId,
    policyId,
    dryRun,
    retentionDays,
    piiFields,
    performedBy,
    batchSize
  };

  const jobId = retentionQueue.enqueue('retention_purge', payload, { delayMs });
  
  jobExecutions.set(jobId, {
    tenantId,
    policyId,
    dryRun,
    startedAt: new Date(),
    payload
  });

  return jobId;
}

/**
 * Cancel a scheduled retention job
 * @param {string} jobId - Job ID to cancel
 * @returns {boolean} - True if cancelled successfully
 */
function cancelRetentionJob(jobId) {
  const cancelled = retentionQueue.cancel(jobId);
  if (cancelled) {
    jobExecutions.delete(jobId);
  }
  return cancelled;
}

/**
 * Get retention job execution status
 * @param {string} executionId - Execution UUID
 * @returns {Promise<Object>} - Execution details
 */
async function getExecutionStatus(executionId) {
  return db('retention_job_executions')
    .where('id', executionId)
    .first();
}

/**
 * Get recent retention job executions
 * @param {string} tenantId - Tenant UUID
 * @param {number} limit - Maximum number of records
 * @returns {Promise<Object[]>} - Array of execution records
 */
async function getRecentExecutions(tenantId, limit = 50) {
  return db('retention_job_executions')
    .where({ tenant_id: tenantId })
    .orderBy('started_at', 'desc')
    .limit(limit);
}

/**
 * Start the retention worker queue processing
 */
function startQueueProcessing() {
  if (!retentionWorker.isRunning) {
    retentionWorker.start();
    logger.info('Retention purge worker started');
  }
}

/**
 * Stop the retention worker queue processing gracefully
 * @param {number} [timeoutMs=10000] - Grace period for pending jobs
 * @returns {Promise<void>} - Resolves when stopped
 */
async function stopQueueProcessing(timeoutMs = 10000) {
  await retentionWorker.stop(timeoutMs);
  logger.info('Retention purge worker stopped');
}

module.exports = {
  scheduleRetentionPurge,
  cancelRetentionJob,
  getExecutionStatus,
  getRecentExecutions,
  startQueueProcessing,
  stopQueueProcessing,
  validatePiiFields,
  isUnderLegalHold,
  getActivePolicies,
  getEligibleInvoices,
  purgeInvoicePii,
  logRetentionOperation,
  jobExecutions,
  retentionQueue,
  retentionWorker
};
