/**
 * Retention Routes
 *
 * Legal-hold management endpoints for the retention system.
 * Note: The canonical legal-hold gating logic lives in
 * `src/middleware/legalHoldGate.js` — this route file handles
 * CRUD operations on legal hold records.
 *
 * @module routes/retention
 */

'use strict';

const express = require('express');
const router = express.Router();

// TODO: Integrate with the retention system's legal-hold persistence layer
// (see src/jobs/retentionPurge.js and src/middleware/legalHoldGate.js).

/**
 * POST /api/retention/legal-hold
 *
 * Place an invoice under legal hold.
 */
router.post('/legal-hold', async (_req, res) => {
  // Legal-hold persistence is managed through the retention job system.
  // This endpoint is reserved for future direct CRUD operations.
  res.status(501).json({
    error: 'Not Implemented',
    message: 'Legal hold management is handled through the retention system.',
  });
});

module.exports = router;
