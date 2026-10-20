'use strict';

const express = require('express');
const { z } = require('zod');
const { isValidStellarAccountAddress } = require('../utils/stellarAddress');
const { createSme, getSme, updateSmeReview } = require('../data/smes');
const { authenticateToken } = require('../middleware/auth');
const { requireAdminToken, isAdminPrincipal, isValidAdminToken } = require('../middleware/requireAdminToken');

const router = express.Router();

const ISO_COUNTRIES = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN ' +
  'MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS ' +
  'PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ ' +
  'TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(/\s+/));

const createSmeSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  registrationNumber: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9/ -]+$/),
  country: z.string().length(2).transform((value) => value.toUpperCase())
    .refine((value) => ISO_COUNTRIES.has(value), 'country must be an ISO 3166-1 alpha-2 code'),
  stellarAddress: z.string().refine(isValidStellarAccountAddress, 'stellarAddress must be a valid Stellar G... account'),
  contactEmail: z.string().trim().email(),
}).strict();

const reviewSchema = z.object({
  decision: z.enum(['verify', 'reject', 'suspend']),
  note: z.string().max(500).optional(),
}).strict();

/**
 * Checks whether this request is authenticated as an admin.
 *
 * @param {import('express').Request} req Request.
 * @returns {boolean} Whether the request is an admin request.
 */
function isAdminRequest(req) {
  return isAdminPrincipal(req) || isValidAdminToken(req);
}

/**
 * Optionally resolves a JWT principal so the existing admin role can be used
 * alongside the dedicated admin API token.
 *
 * @param {import('express').Request} req Request.
 * @param {import('express').Response} res Response.
 * @param {import('express').NextFunction} next Next callback.
 * @returns {void}
 */
function resolveAdminPrincipal(req, res, next) {
  if (isAdminPrincipal(req) || isValidAdminToken(req) || !req.get('authorization')) {
    return next();
  }

  return authenticateToken(req, res, (error) => {
    if (error && !process.env.ADMIN_API_TOKEN) {
      return next();
    }
    return next(error);
  });
}

/**
 * Removes SME PII unless the request has admin access.
 *
 * @param {object} record SME record.
 * @param {boolean} includePii Whether to include admin-only fields.
 * @returns {object} Public or admin-visible SME record.
 */
function publicSme(record, includePii) {
  if (includePii) {
    return record;
  }
  const { contactEmail: _contactEmail, registrationNumber: _registrationNumber, ...publicRecord } = record;
  return publicRecord;
}

/**
 * @swagger
 * /openapi.json:
 *   get:
 *     operationId: getOpenApiDocument
 *     summary: Retrieve the API OpenAPI document
 *     tags: [Documentation]
 *     responses:
 *       '200':
 *         description: OpenAPI 3.0 document
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [openapi, info, paths]
 *               properties:
 *                 openapi:
 *                   type: string
 *                 info:
 *                   type: object
 *                 paths:
 *                   type: object
 */

/**
 * @swagger
 * /api/smes:
 *   post:
 *     operationId: createSme
 *     summary: Register an SME for review
 *     tags: [SMEs]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSmeRequest'
 *     responses:
 *       '201':
 *         description: SME created with pending review status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmeResponse'
 *       '400':
 *         description: Invalid SME fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '409':
 *         description: Duplicate registration or Stellar address
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/', (req, res) => {
  const parsed = createSmeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'SME fields are invalid.',
        fieldErrors: parsed.error.issues.reduce((errors, issue) => {
          const field = issue.path.join('.') || '_root';
          if (!errors[field]) {
            errors[field] = issue.message;
          }
          return errors;
        }, {}),
      },
    });
  }
  try {
    const record = createSme(parsed.data);
    return res.status(201).json({ data: publicSme(record, isAdminRequest(req)) });
  } catch (error) {
    if (error.code === 'SME_DUPLICATE') {
      return res.status(409).json({ error: { code: error.code, message: error.message } });
    }
    throw error;
  }
});

/**
 * @swagger
 * /api/smes/{id}:
 *   get:
 *     operationId: getSme
 *     summary: Retrieve an SME record
 *     description: Contact email and registration number are omitted unless the caller is an admin.
 *     tags: [SMEs]
 *     security:
 *       - adminBearerAuth: []
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: SME record (PII omitted for anonymous callers)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmeResponse'
 *       '404':
 *         description: SME not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/:id', resolveAdminPrincipal, (req, res) => {
  const record = getSme(req.params.id);
  if (!record) {
    return res.status(404).json({ error: { code: 'SME_NOT_FOUND', message: 'SME not found.' } });
  }
  return res.json({ data: publicSme(record, isAdminRequest(req)) });
});

/**
 * @swagger
 * /api/smes/{id}/review:
 *   post:
 *     operationId: reviewSme
 *     summary: Review an SME registration
 *     tags: [SMEs]
 *     security:
 *       - adminBearerAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ReviewSmeRequest'
 *     responses:
 *       '200':
 *         description: SME review recorded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmeResponse'
 *       '400':
 *         description: Invalid review request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '401':
 *         description: Missing or invalid admin token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '404':
 *         description: SME not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '409':
 *         description: Invalid status transition
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '503':
 *         description: Admin authentication is not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/:id/review', resolveAdminPrincipal, requireAdminToken, (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Review request is invalid.' } });
  }
  const record = getSme(req.params.id);
  if (!record) {
    return res.status(404).json({ error: { code: 'SME_NOT_FOUND', message: 'SME not found.' } });
  }

  const nextStatus = {
    pending: { verify: 'verified', reject: 'rejected' },
    verified: { suspend: 'suspended' },
  }[record.status]?.[parsed.data.decision];
  if (!nextStatus) {
    return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: 'Review decision is not allowed for the current SME status.' } });
  }

  const updated = updateSmeReview(req.params.id, nextStatus, {
    decision: parsed.data.decision,
    note: parsed.data.note || '',
    reviewedAt: new Date().toISOString(),
  });
  return res.json({ data: updated });
});

module.exports = router;
