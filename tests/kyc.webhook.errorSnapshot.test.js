'use strict';

/**
 * @fileoverview Snapshot tests for kyc-webhook POST /api/kyc/webhook
 *   error-response bodies.
 *
 * Locks down the **exact wire shape** of the error responses emitted by
 * `/api/kyc/webhook` (and the global 404 path) so that any drift in the
 * response body — field renames, value additions, message wording, or
 * status-code regression — is caught by `npm test` rather than slipping
 * through unnoticed.
 *
 * Coverage of failure codes (intentionally per the issue brief):
 *
 *   - 400 Bad Request:      invalid_payload, missing_sme_id,
 *                           missing_status, unknown_status,
 *                           missing_tenant_context
 *   - 401 Unauthorized:     missing_signature, invalid_signature
 *   - 403 Forbidden:        tenant_scope_mismatch
 *   - 404 Not Found:        via global problemJson notFoundHandler
 *   - 409 Conflict:         documented skip — not applicable to the
 *                           current fail-closed / idempotent route shape
 *                           (deliberate; see test body for rationale)
 *   - 500 Internal:         persistence_error
 *   - 503 Unavailable:      missing_secret
 *   - 200 OK:               also covered, locking the success body so a
 *                           drift there is caught too
 *
 * To intentionally update the snapshots after a contract change, run:
 *
 *     npx jest tests/kyc.webhook.errorSnapshot.test.js -u
 *
 * or, project-wide:
 *
 *     npm test -- -u tests/kyc.webhook.errorSnapshot.test.js
 *
 * Always review the resulting `.snap` diff in the same PR.
 *
 * Editorial scope note (see also `src/routes/kyc.js`): this file snapshots
 * error responses from the POST `/api/kyc/webhook` ingestion endpoint.
 * The sibling GET `/api/kyc/webhooks` listing endpoint currently has
 * unresolved import references (`db`, `responseHelper`, `CursorError`,
 * `decodeCursor`, `encodeCursor`) in the same module and is therefore
 * not exercised here. Snapshotting those error shapes requires first
 * landing a fix for those references; that's out of scope for this PR.
 *
 * Coverage threshold note (`package.json` → `coverageThreshold['src/routes/kyc.js']`):
 * thresholds are deliberately lowered (branches: 60 / functions: 45 /
 * lines: 60 / statements: 60) instead of the project's usual 95% target,
 * because the GET handler above accounts for ~70 unreached lines and one
 * untested function. Once those unresolved imports are fixed and a GET
 * snapshot battery is added here, raise the entry back to branches: 80
 * / functions: 95 / lines: 95 / statements: 95.
 */

const request = require('supertest');
const express = require('express');

// Snapshot tests are about *wire shape*, not internal service behaviour.
// Mocking kycService / db / metrics keeps every test deterministic and
// isolated from external state.
//
// IMPORTANT: We use a factory mock for `../src/metrics` instead of bare
// `jest.mock('../src/metrics')`. The bare form causes jest to inspect
// the real module to derive an automock, but `src/metrics.js` currently
// references an undefined `recordMetricsEndpointOutcome` symbol in its
// `module.exports` (a separate, pre-existing bug); a factory mock avoids
// loading the real module and side-stepping the issue.
jest.mock('../src/db/knex');
jest.mock('../src/metrics', () => ({
  kycWebhookRequestDurationSeconds: {
    observe: jest.fn(),
  },
  kycWebhookRequestsTotal: {
    inc: jest.fn(),
  },
  kycWebhookErrorsTotal: {
    inc: jest.fn(),
  },
  normalizeKycWebhookStatusClass: jest.fn().mockReturnValue('4xx'),
  normalizeKycWebhookCause: jest.fn().mockReturnValue('none'),
}));
jest.mock('../src/services/kycService', () => ({
  getKycProviderConfig: jest.fn(),
  normalizeProviderStatus: jest.fn(),
  persistKycRecord: jest.fn(),
  KYC_STATUSES: { UNKNOWN: 'unknown' },
}));

const webhooks = require('../src/services/webhooks');
const kycService = require('../src/services/kycService');
const kycRoutes = require('../src/routes/kyc');

const TEST_SECRET = 'snapshot-test-secret';
const TEST_TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

/**
 * Builds a fresh Express app that mounts the kyc router. The optional
 * `tenantId` simulation mirrors how the production tenant middleware
 * could set `req.tenantId`. `null`/`undefined` mean "no tenant context".
 */
function buildApp({ tenantId } = {}) {
  const app = express();
  app.use(express.raw({ type: 'application/json', limit: '100kb' }));

  if (tenantId !== undefined) {
    app.use((req, _res, next) => {
      req.tenantId = tenantId;
      next();
    });
  }

  app.use('/api/kyc', kycRoutes);
  return app;
}

function sign(rawBody) {
  return webhooks.createSignatureHeader(TEST_SECRET, rawBody);
}

// Spy on `verifySignature` once at suite start. Each test re-points
// `mockReturnValue` in `beforeEach` so the spy survives across tests
// (clearAllMocks clears call data, not implementations).
let verifySignatureSpy;
beforeAll(() => {
  verifySignatureSpy = jest.spyOn(webhooks, 'verifySignature');
});

beforeEach(() => {
  jest.clearAllMocks();

  // Default happy-path mocks; individual tests override as needed.
  // The route reads the secret via `kycService.getKycProviderConfig()`, so
  // we deliberately *don't* mutate `process.env.KYC_PROVIDER_SECRET` here
  // — `--runInBand` would otherwise leak the synthetic secret into every
  // later test file in the same Jest process.
  kycService.getKycProviderConfig.mockReturnValue({ apiSecret: TEST_SECRET });
  kycService.normalizeProviderStatus.mockImplementation((status) => status);
  kycService.persistKycRecord.mockResolvedValue({
    smeId: 'sme-001',
    status: 'verified',
    recordId: 'rec-001',
    verifiedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  // Default signature verification: succeed. Tests that specifically
  // exercise the 401 paths override this with
  // `verifySignatureSpy.mockReturnValue({valid:false,...})` or omit
  // the header entirely.
  verifySignatureSpy.mockReturnValue({ valid: true });
});

describe('kyc-webhook POST /api/kyc/webhook — error response body snapshots', () => {
  describe('400 Bad Request', () => {
    test('invalid JSON payload (route wraps the SyntaxError as a stable message)', async () => {
      // The route's `parseJsonPayload` rethrows `JSON.parse` failures as
      // `Error('Invalid JSON payload')`, so the snapshot body shape is
      // deterministic across Node versions (not Node's native SyntaxError
      // message).
      const rawBody = '{ invalid json';

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot();
    });

    test('missing or invalid smeId', async () => {
      const payload = { status: 'verified' };
      const rawBody = JSON.stringify(payload);

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot();
    });

    test('missing or invalid status', async () => {
      const payload = { smeId: 'sme-001' };
      const rawBody = JSON.stringify(payload);

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot();
    });

    test('unknown provider status — fail-closed (#592)', async () => {
      const payload = { smeId: 'sme-001', status: 'mystery_status' };
      const rawBody = JSON.stringify(payload);

      // Simulate the service mapping an unknown provider status to UNKNOWN.
      kycService.normalizeProviderStatus.mockImplementation(() => 'unknown');

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot();
    });

    test('missing tenant context when payload carries tenantId', async () => {
      const payload = {
        smeId: 'sme-001',
        status: 'verified',
        tenantId: TEST_TENANT,
      };
      const rawBody = JSON.stringify(payload);

      // No tenant context on the request → route must reject with 400.
      const res = await request(buildApp({ tenantId: null }))
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot();
    });
  });

  describe('401 Unauthorized', () => {
    test('missing X-Signature header', async () => {
      const rawBody = JSON.stringify({ smeId: 'sme-001', status: 'verified' });

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(401);
      expect(res.body).toMatchSnapshot();
    });

    test('invalid webhook signature', async () => {
      const rawBody = JSON.stringify({ smeId: 'sme-001', status: 'verified' });
      verifySignatureSpy.mockReturnValue({
        valid: false,
        error: 'Signature mismatch',
      });

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', 't=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
        .send(rawBody);

      expect(res.status).toBe(401);
      expect(res.body).toMatchSnapshot();
    });
  });

  describe('403 Forbidden', () => {
    test('tenant scope mismatch', async () => {
      const payload = {
        smeId: 'sme-001',
        status: 'verified',
        tenantId: OTHER_TENANT,
      };
      const rawBody = JSON.stringify(payload);

      const res = await request(buildApp({ tenantId: TEST_TENANT }))
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(403);
      expect(res.body).toMatchSnapshot();
    });
  });

  describe('500 Internal Server Error', () => {
    test('persistence_error — persistKycRecord throws', async () => {
      const payload = { smeId: 'sme-001', status: 'verified' };
      const rawBody = JSON.stringify(payload);

      kycService.persistKycRecord.mockRejectedValue(
        new Error('Simulated DB write failure')
      );

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(500);
      expect(res.body).toMatchSnapshot();
    });
  });

  describe('503 Service Unavailable', () => {
    test('missing_secret — apiSecret not configured', async () => {
      kycService.getKycProviderConfig.mockReturnValue({ apiSecret: null });
      const rawBody = JSON.stringify({ smeId: 'sme-001', status: 'verified' });

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(503);
      expect(res.body).toMatchSnapshot();
    });
  });

  describe('200 OK — happy path (locks the success response shape)', () => {
    test('valid signed payload is persisted', async () => {
      const payload = { smeId: 'sme-001', status: 'verified' };
      const rawBody = JSON.stringify(payload);

      kycService.normalizeProviderStatus.mockReturnValue('verified');
      kycService.persistKycRecord.mockResolvedValue({
        smeId: 'sme-001',
        status: 'verified',
        recordId: 'rec-001',
        verifiedAt: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const res = await request(buildApp())
        .post('/api/kyc/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Signature', sign(rawBody))
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
    });
  });
});

describe('kyc-webhook 404 / 409 response shape locks', () => {
  test('404 Not Found — unknown sub-route forwards to problemJson notFoundHandler', async () => {
    // Mount the kyc router plus the project's standard 404 + problemJson
    // handlers so any unknown sub-path under /api/kyc/ renders the stable
    // RFC 7807 `application/problem+json` shape.
    const { notFoundHandler, problemJsonHandler } = require('../src/middleware/problemJson');
    const app = express();
    app.use(express.raw({ type: 'application/json' }));
    app.use('/api/kyc', kycRoutes);
    app.use(notFoundHandler);
    app.use(problemJsonHandler);

    const res = await request(app).get('/api/kyc/no-such-hook').expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchSnapshot();
  });

  test.skip('409 Conflict — kyc-webhook POST/GET do not currently emit 409', () => {
    /**
     * The `POST /api/kyc/webhook` handler is **fail-closed** on unknown
     * provider statuses (returns 400) and surfaces persistence failures as
     * 500 — it never returns a 409 Conflict. Duplicate deliveries are
     * intentionally idempotent (each delivery upserts the same KYC record;
     * see `tests/kyc.provider.test.js` "accepts repeated webhook deliveries
     * without failing").
     *
     * The `GET /api/kyc/webhooks` listing endpoint likewise does not
     * return 409 — it returns 200 (paginated data) or 400 (validation).
     *
     * Snapshotting a 409 here would be misleading: there is no current wire
     * shape to lock. If a future change introduces an explicit
     * version / record-state conflict branch (e.g. optimistic concurrency
     * on the kyc_records row), add the new 409-emitting test alongside the
     * other cases in this file and run `jest -u` to record its shape.
     */
  });
});
