'use strict';

/**
 * Tests for attestation endpoints:
 *   GET  /api/escrow/attestations
 *   POST /api/escrow/attestations/verify
 *
 * All Soroban RPC calls are intercepted so no real network access is required.
 * Fixtures use xdr.ScVal.scvBytes(Buffer) as directed by the issue spec.
 */

const request = require('supertest');
const { xdr, scValToNative } = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk rpc.Server
//
// Strategy: mock only the Server constructor so that every instance gets a
// simulateTransaction spy we can reprogram per-test via setMockResponder().
// We keep the real codec functions (scValToNative, xdr, etc.) so fixture
// encoding/decoding works correctly.
//
// The factory cannot reference outer-scope variables, so we use a global
// slot (global.__simResponder) as the shared mutable channel — globals ARE
// accessible inside jest.mock factories.
// ---------------------------------------------------------------------------

global.__simResponder = null;

jest.mock('@stellar/stellar-sdk', () => {
  const real = jest.requireActual('@stellar/stellar-sdk');

  // Build a fake Server class whose simulateTransaction delegates to the
  // current global.__simResponder so tests can swap it at will.
  function MockServer(_url) {}
  MockServer.prototype.simulateTransaction = async function (tx) {
    if (!global.__simResponder) {
      throw new Error('no mock sim responder configured');
    }
    return global.__simResponder(tx);
  };

  return {
    ...real,
    rpc: {
      ...real.rpc,
      Server: MockServer,
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds an ScVal (Option<BytesN<32>>) from a 64-char hex string or null.
 *
 * @param {string|null} hex
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
function makeOptionalHashScVal(hex) {
  if (hex === null) {
    return xdr.ScVal.scvVoid();
  }
  return xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
}

/**
 * Builds an ScVal (Vec<AttestationDigest>) from an array of { digest, revoked }.
 *
 * Each struct is encoded as an scvMap with keys 'digest' (scvBytes) and
 * 'revoked' (scvBool), which is what scValToNative will decode to a plain
 * object with .digest (Buffer) and .revoked (boolean).
 *
 * @param {{ digest: string, revoked: boolean }[]} entries
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
function makeDigestVecScVal(entries) {
  const items = entries.map((e) =>
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('digest'),
        val: xdr.ScVal.scvBytes(Buffer.from(e.digest, 'hex')),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('revoked'),
        val: xdr.ScVal.scvBool(e.revoked),
      }),
    ]),
  );
  return xdr.ScVal.scvVec(items);
}

/**
 * Wires up global.__simResponder so that:
 *   get_primary_attestation_hash → primaryHex (or null via scvVoid)
 *   get_attestation_digests      → paginated slice of logEntries
 *
 * @param {string|null} primaryHex
 * @param {{ digest: string, revoked: boolean }[]} logEntries full log
 */
function setMockResponder(primaryHex, logEntries) {
  global.__simResponder = (tx) => {
    const op = tx.operations[0];
    // Access the InvokeContractArgs via the HostFunction XDR union
    const ic = op.func.invokeContract();
    const methodName = ic.functionName().toString('utf8');

    if (methodName === 'get_primary_attestation_hash') {
      return { result: { retval: makeOptionalHashScVal(primaryHex) } };
    }

    if (methodName === 'get_attestation_digests') {
      const args = ic.args();
      const start = Number(scValToNative(args[0]));
      const limit = Number(scValToNative(args[1]));
      const page = logEntries.slice(start, start + limit);
      return { result: { retval: makeDigestVecScVal(page) } };
    }

    throw new Error(`unexpected contract call: ${methodName}`);
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PRIMARY_DIGEST       = 'a'.repeat(64);
const LOG_DIGEST_0         = 'b'.repeat(64);
const LOG_DIGEST_1         = 'c'.repeat(64);
const LOG_DIGEST_2_REVOKED = 'd'.repeat(64);
const UNKNOWN_DIGEST       = 'e'.repeat(64);

/** Standard 3-entry log: two normal entries, one revoked. */
const THREE_ENTRY_LOG = [
  { digest: LOG_DIGEST_0,         revoked: false },
  { digest: LOG_DIGEST_1,         revoked: false },
  { digest: LOG_DIGEST_2_REVOKED, revoked: true  },
];

/** 25-entry log for pagination tests (two pages: 20 + 5). */
const TWENTY_FIVE_ENTRY_LOG = Array.from({ length: 25 }, (_, i) => ({
  digest: Buffer.alloc(32, i + 1).toString('hex'),
  revoked: false,
}));

// ---------------------------------------------------------------------------
// Load app AFTER mocks are configured so require() picks up the mock SDK
// ---------------------------------------------------------------------------

const app = require('../src/app');
const { clearCache } = require('../src/routes/attestation');

beforeEach(() => {
  clearCache();
  global.__simResponder = null;
});

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

async function verifyDigest(sha256) {
  return request(app)
    .post('/api/escrow/attestations/verify')
    .set('content-type', 'application/json')
    .send({ sha256 });
}

// ===========================================================================
// GET /api/escrow/attestations
// ===========================================================================

describe('GET /api/escrow/attestations', () => {
  test('returns primary hash and 3-entry log', async () => {
    setMockResponder(PRIMARY_DIGEST, THREE_ENTRY_LOG);
    const res = await request(app).get('/api/escrow/attestations');
    expect(res.status).toBe(200);
    expect(res.body.primary).toBe(PRIMARY_DIGEST);
    expect(res.body.log).toHaveLength(3);
    expect(res.body.log[0]).toMatchObject({ index: 0, digest: LOG_DIGEST_0,         revoked: false });
    expect(res.body.log[1]).toMatchObject({ index: 1, digest: LOG_DIGEST_1,         revoked: false });
    expect(res.body.log[2]).toMatchObject({ index: 2, digest: LOG_DIGEST_2_REVOKED, revoked: true  });
    // 3 entries < 20 → no next page
    expect(res.body.nextCursor).toBeNull();
  });

  test('handles null primary hash', async () => {
    setMockResponder(null, THREE_ENTRY_LOG);
    const res = await request(app).get('/api/escrow/attestations');
    expect(res.status).toBe(200);
    expect(res.body.primary).toBeNull();
  });

  test('pagination: first page of 25-entry log (limit=20)', async () => {
    setMockResponder(null, TWENTY_FIVE_ENTRY_LOG);
    const res = await request(app).get('/api/escrow/attestations?cursor=0&limit=20');
    expect(res.status).toBe(200);
    expect(res.body.log).toHaveLength(20);
    expect(res.body.log[0].index).toBe(0);
    expect(res.body.log[19].index).toBe(19);
    expect(res.body.nextCursor).toBe(20);
  });

  test('pagination: second page of 25-entry log (cursor=20)', async () => {
    setMockResponder(null, TWENTY_FIVE_ENTRY_LOG);
    const res = await request(app).get('/api/escrow/attestations?cursor=20&limit=20');
    expect(res.status).toBe(200);
    expect(res.body.log).toHaveLength(5);
    expect(res.body.log[0].index).toBe(20);
    expect(res.body.log[4].index).toBe(24);
    expect(res.body.nextCursor).toBeNull();
  });

  test('returns 400 for invalid cursor', async () => {
    const res = await request(app).get('/api/escrow/attestations?cursor=-1');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  test('returns 502 on RPC failure', async () => {
    global.__simResponder = () => { throw new Error('network error'); };
    const res = await request(app).get('/api/escrow/attestations');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ESCROW_READ_FAILED');
  });
});

// ===========================================================================
// POST /api/escrow/attestations/verify — JSON digest
// ===========================================================================

describe('POST /api/escrow/attestations/verify (JSON)', () => {
  beforeEach(() => setMockResponder(PRIMARY_DIGEST, THREE_ENTRY_LOG));

  test('primary match: verified=true', async () => {
    const res = await verifyDigest(PRIMARY_DIGEST);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sha256: PRIMARY_DIGEST,
      match: 'primary',
      revoked: false,
      verified: true,
    });
    expect(res.body.index).toBeUndefined();
  });

  test('log match (non-revoked): verified=true', async () => {
    const res = await verifyDigest(LOG_DIGEST_1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sha256: LOG_DIGEST_1,
      match: 'log',
      index: 1,
      revoked: false,
      verified: true,
    });
  });

  test('log match (revoked): verified=false', async () => {
    const res = await verifyDigest(LOG_DIGEST_2_REVOKED);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sha256: LOG_DIGEST_2_REVOKED,
      match: 'log',
      index: 2,
      revoked: true,
      verified: false,
    });
  });

  test('no match: verified=false', async () => {
    const res = await verifyDigest(UNKNOWN_DIGEST);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sha256: UNKNOWN_DIGEST,
      match: 'none',
      revoked: false,
      verified: false,
    });
  });

  test('null primary is not matched against', async () => {
    clearCache();
    setMockResponder(null, []);
    const res = await verifyDigest('a'.repeat(64));
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('none');
  });
});

// ===========================================================================
// POST /api/escrow/attestations/verify — input validation
// ===========================================================================

describe('POST /api/escrow/attestations/verify — validation', () => {
  test('400 when sha256 field is missing', async () => {
    const res = await request(app)
      .post('/api/escrow/attestations/verify')
      .set('content-type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST');
  });

  test('400 when sha256 is too short', async () => {
    const res = await verifyDigest('abc123');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST');
  });

  test('400 when sha256 contains non-hex characters', async () => {
    const res = await verifyDigest('z'.repeat(64));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST');
  });

  test('400 when sha256 is 65 chars (wrong length)', async () => {
    const res = await verifyDigest('a'.repeat(65));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST');
  });

  test('digest is normalised to lowercase before matching', async () => {
    setMockResponder(PRIMARY_DIGEST, THREE_ENTRY_LOG);
    // Send uppercase letters — should still match the lowercase primary
    const res = await verifyDigest(PRIMARY_DIGEST.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.sha256).toBe(PRIMARY_DIGEST.toLowerCase());
    expect(res.body.match).toBe('primary');
  });
});

// ===========================================================================
// POST /api/escrow/attestations/verify — file upload
// ===========================================================================

describe('POST /api/escrow/attestations/verify (multipart file upload)', () => {
  const crypto = require('crypto');
  const KNOWN_CONTENT = 'hello attestation world';
  const KNOWN_SHA256 = crypto.createHash('sha256').update(KNOWN_CONTENT).digest('hex');

  test('file upload: primary match when hash equals primary digest', async () => {
    setMockResponder(KNOWN_SHA256, []);
    const res = await request(app)
      .post('/api/escrow/attestations/verify')
      .attach('file', Buffer.from(KNOWN_CONTENT), 'invoice.pdf');
    expect(res.status).toBe(200);
    expect(res.body.sha256).toBe(KNOWN_SHA256);
    expect(res.body.match).toBe('primary');
    expect(res.body.verified).toBe(true);
  });

  test('file upload: log match', async () => {
    setMockResponder(null, [{ digest: KNOWN_SHA256, revoked: false }]);
    const res = await request(app)
      .post('/api/escrow/attestations/verify')
      .attach('file', Buffer.from(KNOWN_CONTENT), 'invoice.pdf');
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('log');
    expect(res.body.revoked).toBe(false);
    expect(res.body.verified).toBe(true);
  });

  test('file upload: no match', async () => {
    setMockResponder(PRIMARY_DIGEST, THREE_ENTRY_LOG);
    const res = await request(app)
      .post('/api/escrow/attestations/verify')
      .attach('file', Buffer.from('completely different content'), 'other.pdf');
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('none');
  });

  test('413 when file exceeds 5 MiB', async () => {
    // 5 MiB + 1 byte
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    const res = await request(app)
      .post('/api/escrow/attestations/verify')
      .attach('file', oversized, 'big.pdf');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });
});

// ===========================================================================
// RPC failure during verify
// ===========================================================================

describe('POST /api/escrow/attestations/verify — RPC failure', () => {
  test('502 on RPC failure during verify', async () => {
    global.__simResponder = () => { throw new Error('rpc down'); };
    const res = await verifyDigest('a'.repeat(64));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ESCROW_READ_FAILED');
  });
});

// ===========================================================================
// OpenAPI document includes new routes
// ===========================================================================

describe('OpenAPI document', () => {
  test('GET /openapi.json includes /api/escrow/attestations paths and schemas', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);

    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/api/escrow/attestations');
    expect(paths).toContain('/api/escrow/attestations/verify');

    // GET /api/escrow/attestations — response and error codes
    const getOp = res.body.paths['/api/escrow/attestations'].get;
    expect(getOp).toBeDefined();
    expect(getOp.responses['200']).toBeDefined();
    expect(getOp.responses['400']).toBeDefined();
    expect(getOp.responses['502']).toBeDefined();

    // POST /api/escrow/attestations/verify — request body content types
    const postOp = res.body.paths['/api/escrow/attestations/verify'].post;
    expect(postOp).toBeDefined();
    expect(postOp.requestBody.content['application/json']).toBeDefined();
    expect(postOp.requestBody.content['multipart/form-data']).toBeDefined();
    // Response codes
    expect(postOp.responses['200']).toBeDefined();
    expect(postOp.responses['400']).toBeDefined();
    expect(postOp.responses['413']).toBeDefined();
    expect(postOp.responses['502']).toBeDefined();
  });
});
