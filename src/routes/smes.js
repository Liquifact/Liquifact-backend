'use strict';

/**
 * SME onboarding (KYB review lifecycle).
 *
 *   POST /api/smes              register an SME (status: pending)
 *   GET  /api/smes/:id          read an SME; PII (contactEmail, registrationNumber) only for admins
 *   POST /api/smes/:id/review   admin: verify | reject | suspend
 *
 * Allowed transitions: pending -> verified | rejected, verified -> suspended.
 */

const express = require('express');
const { createSme, getSme, updateSmeReview } = require('../data/smes');
const { requireAdminToken, hasValidAdminToken } = require('../middleware/require-admin-token');
const { validate } = require('../middleware/validate');
const { CreateSmeRequest, ReviewSmeRequest } = require('../schemas');

const router = express.Router();

const TRANSITIONS = {
  pending: { verify: 'verified', reject: 'rejected' },
  verified: { suspend: 'suspended' },
};

/**
 * Removes SME PII unless the caller is an admin.
 *
 * @param {object} record SME record
 * @param {boolean} includePii whether to include admin-only fields
 * @returns {object} public or admin-visible SME record
 */
function publicSme(record, includePii) {
  if (includePii) {
    return record;
  }
  const publicRecord = { ...record };
  delete publicRecord.contactEmail;
  delete publicRecord.registrationNumber;
  return publicRecord;
}

router.post('/', validate({ body: CreateSmeRequest }), (req, res) => {
  const body = req.validatedBody;
  try {
    const record = createSme({ ...body, country: body.country.toUpperCase() });
    return res.status(201).json({ data: publicSme(record, hasValidAdminToken(req)) });
  } catch (error) {
    if (error.code === 'SME_DUPLICATE') {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    throw error;
  }
});

router.get('/:id', (req, res) => {
  const record = getSme(req.params.id);
  if (!record) {
    return res.status(404).json({ error: 'SME not found', code: 'SME_NOT_FOUND' });
  }
  return res.json({ data: publicSme(record, hasValidAdminToken(req)) });
});

router.post('/:id/review', requireAdminToken, validate({ body: ReviewSmeRequest }), (req, res) => {
  const record = getSme(req.params.id);
  if (!record) {
    return res.status(404).json({ error: 'SME not found', code: 'SME_NOT_FOUND' });
  }
  const { decision, note } = req.validatedBody;
  const nextStatus = (TRANSITIONS[record.status] || {})[decision];
  if (!nextStatus) {
    return res.status(409).json({
      error: `Decision "${decision}" is not allowed for an SME that is ${record.status}`,
      code: 'INVALID_TRANSITION',
    });
  }
  const updated = updateSmeReview(req.params.id, nextStatus, {
    decision,
    note: note || '',
    reviewedAt: new Date().toISOString(),
  });
  return res.json({ data: updated });
});

module.exports = router;
