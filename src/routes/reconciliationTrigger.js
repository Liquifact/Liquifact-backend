'use strict';

/**
 * @fileoverview Internal reconciliation trigger route.
 *
 * POST /api/internal/reconciliation/run
 * Protected by `Authorization: Bearer <CRON_SECRET>` via the shared cron guard.
 * Runs reconcileAll(), caches the latest report in memory, and emits one
 * invoice.reconciliation_drift webhook event per invoice transitioning from
 * in_sync to drift/error. Returns 404 when CRON_SECRET is unset.
 *
 * @module routes/reconciliationTrigger
 */

const { Router } = require('express');
const logger = require('../logger');
const store = require('../data/store');
const { requireCronSecret } = require('../middleware/cron-secret');
const reconciliation = require('./reconciliation');
const emitter = require('../webhooks/emitter');

const router = Router();

const DRIFT_EVENT = 'invoice.reconciliation_drift';
const ALERT_STATUSES = new Set(['drift', 'error']);

/**
 * Builds the previous status lookup from the last cached report.
 *
 * @param {object|null} previousReport
 * @returns {Map<string, string>}
 */
function previousStatusMap(previousReport) {
  return new Map((previousReport?.results || []).map((r) => [r.invoiceId, r.status]));
}

/**
 * Selects invoices whose status changed from in_sync to drift/error.
 * The first observed status for an invoice is treated as in_sync so an initial
 * run can alert on existing drift; subsequent runs use the cached report.
 *
 * @param {object} report current reconciliation report
 * @param {object|null} previousReport previously cached report
 * @returns {object[]} drift alert payloads
 */
function collectDriftAlerts(report, previousReport) {
  const previous = previousStatusMap(previousReport);
  const alerts = [];

  for (const result of report.results || []) {
    if (!ALERT_STATUSES.has(result.status)) { continue; }

    const previousStatus = previous.get(result.invoiceId) || 'in_sync';
    if (previousStatus !== 'in_sync') { continue; }

    const invoice = store.get(result.invoiceId) || {};
    const mismatches = Array.isArray(result.mismatches) ? result.mismatches : [];
    const reconciliationDetail = {
      invoiceId: result.invoiceId,
      contractId: result.contractId,
      previousStatus,
      status: result.status,
      code: result.code,
      detail: result.detail,
      mismatches,
      checkedAt: report.checkedAt,
    };

    alerts.push({
      ...invoice,
      id: invoice.id || result.invoiceId,
      invoiceId: result.invoiceId,
      contractId: result.contractId,
      previousStatus,
      status: result.status,
      code: result.code,
      detail: result.detail,
      mismatches,
      mismatchCount: mismatches.length,
      checkedAt: report.checkedAt,
      reconciliation: reconciliationDetail,
    });
  }

  return alerts;
}

/**
 * @swagger
 * /api/internal/reconciliation/run:
 *   post:
 *     summary: Run a scheduled reconciliation pass
 *     description: >
 *       Runs the same reconciliation as GET /api/reconciliation, caches the
 *       report for GET /api/reconciliation/latest, and emits one
 *       invoice.reconciliation_drift webhook event per invoice transitioning
 *       from in_sync to drift/error. Protected by Bearer CRON_SECRET; returns
 *       404 when CRON_SECRET is unset.
 *     tags:
 *       - Internal
 *     security:
 *       - cronBearer: []
 *     responses:
 *       200:
 *         description: Reconciliation report with alert counts
 *       401:
 *         description: Missing or invalid CRON_SECRET bearer token
 *       404:
 *         description: Endpoint not available (CRON_SECRET not configured)
 *       500:
 *         description: Reconciliation run failed
 */
router.post('/run', requireCronSecret, async (_req, res) => {
  try {
    const previousReport = typeof reconciliation.getLatestReport === 'function'
      ? reconciliation.getLatestReport()
      : null;
    const report = await reconciliation.reconcileAll();
    if (typeof reconciliation.setLatestReport === 'function') {
      reconciliation.setLatestReport(report);
    }

    const alerts = collectDriftAlerts(report, previousReport);
    for (const alert of alerts) {
      emitter.emit(DRIFT_EVENT, alert);
    }

    return res.json({
      ...report,
      alerts: alerts.length,
      alertedInvoiceIds: alerts.map((a) => a.invoiceId),
    });
  } catch (err) {
    logger.error({ err }, 'Scheduled reconciliation run failed');
    return res.status(500).json({
      type: 'https://liquifact.io/problems/reconciliation-error',
      title: 'Reconciliation Error',
      status: 500,
      detail: err?.message ?? 'Unknown reconciliation error',
    });
  }
});

module.exports = router;
module.exports.collectDriftAlerts = collectDriftAlerts;
module.exports.DRIFT_EVENT = DRIFT_EVENT;
