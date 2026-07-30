'use strict';

const nodemailer = require('nodemailer');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const db = require('../db/knex');
const logger = require('../logger');
const { sendMailWithRetry } = require('../utils/retry');
const {
  maturityReminderDeliveryAttemptsTotal,
  maturityReminderDeliverySuccessTotal,
  maturityReminderDeadLetterTotal,
  normalizeReminderReason,
  normalizeJobType,
} = require('../metrics');

const DEAD_LETTER_TABLE = 'maturity_reminder_dead_letters';
const MAX_LIST_LIMIT = 200;

/**
 * The internal mapping of invoice IDs to job IDs.
 * Allows cancelling a reminder before it fires.
 * @type {Map<string, string>}
 */
const invoiceJobs = new Map();

const emailQueue = new JobQueue();
const emailWorker = new BackgroundWorker({ jobQueue: emailQueue });

/**
 * Creates the configured Nodemailer transport, or a dry-run transport when SMTP is disabled.
 *
 * @returns {Object} A simulated or real Nodemailer transport object.
 */
function getTransport() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  return {
    sendMail: async (mailOptions) => {
      console.log(`[DRY RUN] Sending email to: ${mailOptions.to}`);
      console.log(`[DRY RUN] Subject: ${mailOptions.subject}`);
      console.log(`[DRY RUN] Text: ${mailOptions.text}`);
      return { messageId: 'mock-id-12345', response: '250 OK Mock' };
    },
  };
}

const templates = {
  maturityReminder: (customer, amount, targetDate) => `
Dear ${customer},

This is a reminder that your invoice for the amount of $${amount} is maturing on ${targetDate}.
Please ensure funds are prepared for settlement.

Thank you,
LiquiFact Settlement Team
`.trim(),
};

/**
 * Returns a bounded SMTP attempt count from configuration.
 *
 * @returns {number} Attempt count between one and ten.
 */
function getMaxAttempts() {
  const configured = Number(process.env.SMTP_MAX_RETRIES);
  if (!Number.isFinite(configured)) {
    return 3;
  }
  return Math.max(1, Math.min(Math.trunc(configured), 10));
}

/**
 * Persists a sanitized maturity-reminder dead letter.
 *
 * Only operational metadata is copied into `payload_metadata`; recipient email,
 * customer name, amount, generated subject/body, and raw SMTP errors are never stored.
 *
 * @param {Object} deadLetter - Sanitized failure metadata.
 * @param {string} deadLetter.jobId - Background job identifier.
 * @param {string} deadLetter.invoiceId - Invoice identifier.
 * @param {string} deadLetter.jobType - Bounded reminder job type.
 * @param {string} deadLetter.reason - Bounded failure reason.
 * @param {number} deadLetter.attempts - Number of SMTP attempts made.
 * @param {string} deadLetter.targetDate - Scheduled maturity timestamp.
 * @param {import('knex').Knex} [dbClient=db] - Injectable Knex client.
 * @returns {Promise<void>} Resolves after the row is inserted.
 */
async function persistReminderDeadLetter(deadLetter, dbClient = db) {
  const payloadMetadata = {
    jobType: deadLetter.jobType,
    targetDate: deadLetter.targetDate,
  };

  await dbClient(DEAD_LETTER_TABLE).insert({
    job_id: deadLetter.jobId,
    invoice_id: deadLetter.invoiceId,
    reason: deadLetter.reason,
    attempts: deadLetter.attempts,
    payload_metadata: JSON.stringify(payloadMetadata),
    created_at: new Date(),
  });
}

/**
 * Starts dead-letter persistence without making the reminder handler wait for the database.
 *
 * @param {Object} deadLetter - Sanitized dead-letter record.
 * @param {Function} persist - Persistence function.
 * @returns {void}
 */
function persistReminderDeadLetterInBackground(deadLetter, persist) {
  Promise.resolve()
    .then(() => persist(deadLetter))
    .catch((err) => {
      logger.warn(
        { err: err && err.message ? err.message : String(err), jobId: deadLetter.jobId },
        'Failed to persist maturity-reminder dead letter'
      );
    });
}

/**
 * Lists persisted maturity-reminder dead letters for operator inspection.
 *
 * @param {Object} [options={}] - Query options.
 * @param {number} [options.limit=50] - Maximum rows to return, capped at 200.
 * @param {string} [options.reason] - Optional bounded reason filter.
 * @param {import('knex').Knex} [dbClient=db] - Injectable Knex client.
 * @returns {Promise<Array<Object>>} Newest dead-letter rows first.
 */
async function listReminderDeadLetters(options = {}, dbClient = db) {
  const requestedLimit = Number(options.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), MAX_LIST_LIMIT))
    : 50;

  const query = dbClient(DEAD_LETTER_TABLE)
    .select(
      'id',
      'job_id',
      'invoice_id',
      'reason',
      'attempts',
      'payload_metadata',
      'created_at'
    )
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (options.reason) {
    query.where('reason', options.reason);
  }

  return query;
}

/**
 * Creates the maturity-reminder job handler with injectable delivery dependencies.
 *
 * @param {Object} [dependencies={}] - Handler dependencies.
 * @param {Function} [dependencies.transportFactory=getTransport] - SMTP transport factory.
 * @param {Function} [dependencies.persistDeadLetter=persistReminderDeadLetter] - Dead-letter writer.
 * @returns {Function} Async background-job handler.
 */
function createMaturityReminderHandler(dependencies = {}) {
  const transportFactory = dependencies.transportFactory || getTransport;
  const persistDeadLetter = dependencies.persistDeadLetter || persistReminderDeadLetter;

  return async function maturityReminderHandler(job) {
    const { invoiceId, customer, amount, email, targetDate } = job.payload;
    const jobType = normalizeJobType(job.type);
    let attempts = 0;

    try {
      const transport = transportFactory();
      const countedTransport = {
        sendMail: (mailOptions) => {
          attempts += 1;
          maturityReminderDeliveryAttemptsTotal.inc({ reason: 'unknown', job_type: jobType });
          return transport.sendMail(mailOptions);
        },
      };

      await sendMailWithRetry(
        countedTransport,
        {
          from: process.env.SMTP_FROM || 'noreply@liquifact.com',
          to: email,
          subject: `Settlement Reminder: Invoice ${invoiceId}`,
          text: templates.maturityReminder(customer, amount, targetDate),
        },
        { maxAttempts: getMaxAttempts() }
      );

      // Increment success counter only after a confirmed successful delivery.
      maturityReminderDeliverySuccessTotal.inc({ job_type: jobType });
    } catch (err) {
      const reason = normalizeReminderReason(err);
      maturityReminderDeadLetterTotal.inc({ reason, job_type: jobType });
      persistReminderDeadLetterInBackground(
        {
          jobId: job.id,
          invoiceId,
          jobType,
          reason,
          attempts,
          targetDate,
        },
        persistDeadLetter
      );
    } finally {
      invoiceJobs.delete(invoiceId);
    }
  };
}

emailWorker.registerHandler('maturity_reminder', createMaturityReminderHandler());

/**
 * Schedules a pre-maturity reminder for an invoice.
 *
 * @param {Object} invoice - Invoice metadata.
 * @param {Date} targetDate - When the reminder should run.
 * @param {string} email - Destination email.
 * @returns {string} Scheduled job ID.
 */
function scheduleReminder(invoice, targetDate, email) {
  const delayMs = Math.max(targetDate.getTime() - Date.now(), 0);
  const payload = {
    invoiceId: invoice.id,
    customer: invoice.customer,
    amount: invoice.amount,
    email,
    targetDate: targetDate.toISOString(),
  };

  const jobId = emailQueue.enqueue('maturity_reminder', payload, { delayMs });

  if (invoiceJobs.has(invoice.id)) {
    cancelReminder(invoice.id);
  }

  invoiceJobs.set(invoice.id, jobId);
  return jobId;
}

/**
 * Cancels a previously scheduled reminder for an invoice.
 *
 * @param {string} invoiceId - Invoice ID.
 * @returns {boolean} True when a pending reminder was cancelled.
 */
function cancelReminder(invoiceId) {
  const jobId = invoiceJobs.get(invoiceId);
  if (!jobId) {
    return false;
  }

  const cancelled = emailQueue.cancel(jobId);
  invoiceJobs.delete(invoiceId);
  return cancelled;
}

/**
 * Starts internal email queue processing.
 *
 * @returns {void}
 */
function startQueueProcessing() {
  if (!emailWorker.isRunning) {
    void emailWorker.start();
  }
}

/**
 * Stops internal email queue processing gracefully.
 *
 * @param {number} [timeoutMs=5000] - Grace period for pending jobs.
 * @returns {Promise<void>} Resolves when stopped.
 */
async function stopQueueProcessing(timeoutMs = 5000) {
  await emailWorker.stop(timeoutMs);
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  startQueueProcessing,
  stopQueueProcessing,
  invoiceJobs,
  emailQueue,
  emailWorker,
  templates,
  getTransport,
  getMaxAttempts,
  createMaturityReminderHandler,
  persistReminderDeadLetter,
  listReminderDeadLetters,
};
