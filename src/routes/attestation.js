'use strict';

/**
 * Attestation routes.
 *
 * GET  /api/escrow/attestations         — paginated on-chain attestation log
 * POST /api/escrow/attestations/verify  — verify a document digest or uploaded file
 *
 * Hex handling: BytesN<32> decodes to a Buffer via scValToNative; we normalise
 * to lowercase 64-char hex strings throughout.
 *
 * Reads are cached for 10 seconds. RPC failures return 502 ESCROW_READ_FAILED.
 */

const express = require('express');
const crypto = require('crypto');
const { Writable } = require('stream');
const config = require('../config');

const router = express.Router();

/** Maximum page size enforced by the contract (MAX_ATTESTATION_READ_PAGE = 20). */
const MAX_PAGE = 20;

/** Maximum upload size: 5 MiB. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Cache TTL in milliseconds. */
const CACHE_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// Simple in-process cache
// ---------------------------------------------------------------------------

const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) { return null; }
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  _cache.set(key, { value, ts: Date.now() });
}

/** Clears the attestation cache (used in tests to reset between cases). */
function clearCache() {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Soroban RPC helpers
// ---------------------------------------------------------------------------

/**
 * Builds a simulation-only transaction for a no-arg contract call.
 *
 * @param {string} method contract function name
 * @param {import('@stellar/stellar-sdk').xdr.ScVal[]} [args] optional arguments
 * @returns {Promise<import('@stellar/stellar-sdk').xdr.ScVal>} returned ScVal
 */
async function simulateCall(method, args = []) {
  const sdk = require('@stellar/stellar-sdk');
  const { rpc, Contract, TransactionBuilder, Account, BASE_FEE } = sdk;
  const server = new rpc.Server(config.rpcUrl);
  const source = new Account('GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5', '0');
  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('RPC timeout')), 6000),
  );
  const sim = await Promise.race([server.simulateTransaction(tx), timeout]);
  if (!sim.result || !sim.result.retval) {
    throw new Error(sim.error || 'simulation returned no result');
  }
  return sim.result.retval;
}

/**
 * Decodes a ScVal (Option<BytesN<32>>) to a lowercase hex string or null.
 *
 * @param {import('@stellar/stellar-sdk').xdr.ScVal} scval
 * @returns {string|null}
 */
function decodeOptionalHash(scval) {
  const { scValToNative } = require('@stellar/stellar-sdk');
  const native = scValToNative(scval);
  if (native === null || native === undefined) { return null; }
  // scValToNative returns a Buffer for scvBytes
  const buf = Buffer.isBuffer(native) ? native : Buffer.from(native);
  return buf.toString('hex');
}

/**
 * Decodes a ScVal (Vec<AttestationDigest>) to an array of log entries.
 * Each entry has { index, digest, revoked }.
 *
 * @param {import('@stellar/stellar-sdk').xdr.ScVal} scval
 * @param {number} startIndex starting index for entries in this page
 * @returns {{ index: number, digest: string, revoked: boolean }[]}
 */
function decodeDigestVec(scval, startIndex) {
  const { scValToNative } = require('@stellar/stellar-sdk');
  const native = scValToNative(scval);
  if (!Array.isArray(native)) { return []; }
  return native.map((entry, i) => {
    // entry is { digest: Buffer, revoked: boolean } from scValToNative on the struct
    const digest = Buffer.isBuffer(entry.digest)
      ? entry.digest.toString('hex')
      : Buffer.from(entry.digest).toString('hex');
    return {
      index: startIndex + i,
      digest,
      revoked: Boolean(entry.revoked),
    };
  });
}

// ---------------------------------------------------------------------------
// Attestation data fetchers (with caching)
// ---------------------------------------------------------------------------

/**
 * Fetches the primary attestation hash from the contract.
 * Cached for CACHE_TTL_MS.
 *
 * @returns {Promise<string|null>} lowercase hex or null
 */
async function fetchPrimaryHash() {
  const key = 'primary';
  const cached = cacheGet(key);
  if (cached !== undefined && cached !== null) { return cached; }
  // Check if we cached null explicitly
  if (_cache.has(key)) { return null; }
  const scval = await simulateCall('get_primary_attestation_hash');
  const result = decodeOptionalHash(scval);
  cacheSet(key, result);
  return result;
}

/**
 * Fetches one page of attestation log entries from the contract.
 * Each page request is cached independently.
 *
 * @param {number} start zero-based start index
 * @param {number} limit page size (≤ MAX_PAGE)
 * @returns {Promise<{ index: number, digest: string, revoked: boolean }[]>}
 */
async function fetchAttestationPage(start, limit) {
  const safeLimit = Math.min(limit, MAX_PAGE);
  const key = `log:${start}:${safeLimit}`;
  const cached = cacheGet(key);
  if (cached !== null) { return cached; }
  const { nativeToScVal } = require('@stellar/stellar-sdk');
  const args = [
    nativeToScVal(start, { type: 'u32' }),
    nativeToScVal(safeLimit, { type: 'u32' }),
  ];
  const scval = await simulateCall('get_attestation_digests', args);
  const result = decodeDigestVec(scval, start);
  cacheSet(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// GET /api/escrow/attestations
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  // Parse cursor (zero-based start index) from query, default 0
  const cursor = parseInt(req.query.cursor ?? '0', 10);
  const limit = Math.min(parseInt(req.query.limit ?? String(MAX_PAGE), 10), MAX_PAGE);

  if (!Number.isFinite(cursor) || cursor < 0) {
    return res.status(400).json({ error: 'cursor must be a non-negative integer', code: 'INVALID_CURSOR' });
  }
  if (!Number.isFinite(limit) || limit < 1) {
    return res.status(400).json({ error: 'limit must be between 1 and 20', code: 'INVALID_LIMIT' });
  }

  try {
    const [primaryHash, page] = await Promise.all([
      fetchPrimaryHash(),
      fetchAttestationPage(cursor, limit),
    ]);

    // Determine nextCursor: if we got a full page there may be more entries
    const nextCursor = page.length === limit ? cursor + limit : null;

    return res.json({
      primary: primaryHash,
      log: page,
      total: null, // total log length not directly queryable without get_escrow_summary
      nextCursor,
    });
  } catch (err) {
    return res.status(502).json({ error: `Escrow read failed: ${err.message}`, code: 'ESCROW_READ_FAILED' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/escrow/attestations/verify
// ---------------------------------------------------------------------------

/**
 * Validates that a string is a 64-character lowercase hex digest.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isValidHex(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

/**
 * Fetches all attestation pages until the log is exhausted (or no more pages).
 * Used to find a digest anywhere in the log.
 *
 * @returns {Promise<{ index: number, digest: string, revoked: boolean }[]>}
 */
async function fetchFullLog() {
  const all = [];
  let cursor = 0;
  // Safety cap: never read more than 1 000 entries in a single verify call
  const MAX_ENTRIES = 1000;
  while (all.length < MAX_ENTRIES) {
    const page = await fetchAttestationPage(cursor, MAX_PAGE);
    if (page.length === 0) { break; }
    all.push(...page);
    if (page.length < MAX_PAGE) { break; }
    cursor += page.length;
  }
  return all;
}

/**
 * Hashes an HTTP request body (multipart file) using SHA-256 while streaming.
 * Returns the hex digest, or throws if the content exceeds MAX_UPLOAD_BYTES.
 *
 * @param {import('express').Request} req
 * @returns {Promise<string>} lowercase hex SHA-256
 */
function hashUploadedFile(req) {
  return new Promise((resolve, reject) => {
    const formidable = require('formidable');
    let fileDigest = null;
    let fileCount = 0;

    const form = formidable.formidable({
      maxFileSize: MAX_UPLOAD_BYTES,
      // Write uploaded bytes into a hash instead of onto disk
      fileWriteStreamHandler: (_file) => {
        fileCount++;
        const hash = crypto.createHash('sha256');
        const ws = new Writable({
          write(chunk, _enc, cb) {
            hash.update(chunk);
            cb();
          },
          final(cb) {
            fileDigest = hash.digest('hex');
            cb();
          },
        });
        return ws;
      },
    });

    form.parse(req, (err) => {
      if (err) {
        // formidable throws 1009 for size exceeded
        if (err.code === 1009 || (err.message && err.message.includes('maxFileSize'))) {
          return reject(Object.assign(new Error('File exceeds 5 MiB limit'), { status: 413, code: 'FILE_TOO_LARGE' }));
        }
        return reject(err);
      }
      if (fileCount === 0 || fileDigest === null) {
        return reject(Object.assign(new Error('No file found in multipart body'), { status: 400, code: 'NO_FILE' }));
      }
      resolve(fileDigest);
    });
  });
}

router.post('/verify', async (req, res) => {
  let sha256;

  const contentType = req.get('content-type') || '';

  if (contentType.startsWith('multipart/form-data')) {
    // File upload: hash while streaming, discard the file
    try {
      sha256 = await hashUploadedFile(req);
    } catch (err) {
      const status = err.status || 400;
      return res.status(status).json({ error: err.message, code: err.code || 'UPLOAD_ERROR' });
    }
  } else {
    // JSON body: { sha256: '<64 hex>' }
    const body = req.body || {};
    if (!body.sha256) {
      return res.status(400).json({ error: 'sha256 field is required', code: 'INVALID_DIGEST' });
    }
    if (!isValidHex(body.sha256)) {
      return res.status(400).json({
        error: 'sha256 must be a 64-character hex string',
        code: 'INVALID_DIGEST',
      });
    }
    sha256 = body.sha256.toLowerCase();
  }

  // Fetch on-chain state and search for the digest
  let primaryHash;
  let log;
  try {
    [primaryHash, log] = await Promise.all([fetchPrimaryHash(), fetchFullLog()]);
  } catch (err) {
    return res.status(502).json({ error: `Escrow read failed: ${err.message}`, code: 'ESCROW_READ_FAILED' });
  }

  const needle = sha256.toLowerCase();

  // Check primary hash first
  if (primaryHash && primaryHash.toLowerCase() === needle) {
    return res.json({
      sha256: needle,
      match: 'primary',
      index: undefined,
      revoked: false,
      verified: true,
    });
  }

  // Search append log
  const entry = log.find((e) => e.digest.toLowerCase() === needle);
  if (entry) {
    return res.json({
      sha256: needle,
      match: 'log',
      index: entry.index,
      revoked: entry.revoked,
      verified: !entry.revoked,
    });
  }

  // No match
  return res.json({
    sha256: needle,
    match: 'none',
    index: undefined,
    revoked: false,
    verified: false,
  });
});

module.exports = router;
module.exports.clearCache = clearCache;
// Export internals for unit testing
module.exports._decodeOptionalHash = decodeOptionalHash;
module.exports._decodeDigestVec = decodeDigestVec;
module.exports._isValidHex = isValidHex;
