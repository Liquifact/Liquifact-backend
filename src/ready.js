'use strict';

const config = require('./config');
const rpcClient = require('./stellar/rpc');

/** Error carrying a short, safe error code (never a raw upstream message). */
class CheckError extends Error {
  /**
   * @param {string} code short error code
   * @param {object} [extra] additional fields to expose on the check
   */
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Rejects with TIMEOUT if the promise does not settle in time.
 *
 * @param {Promise<any>} promise work to bound
 * @param {number} ms timeout in milliseconds
 * @returns {Promise<any>} the work's result
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CheckError('TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Creates the readiness handler.
 *
 * @param {object} [opts] overrides (for tests)
 * @param {() => object} [opts.getServer] RPC client factory
 * @param {object} [opts.settings] timeout/age/cache settings and network identity
 * @returns {{ check: Function, handler: Function, reset: Function }} readiness API
 */
function createReadiness(opts = {}) {
  const getServer = opts.getServer || rpcClient.getServer;
  const s = { ...config.ready, ...(opts.settings || {}) };
  const expectedPassphrase = opts.settings?.networkPassphrase || config.networkPassphrase;
  const contractId = opts.settings?.contractId || config.contractId;

  let cached = null;
  let inflight = null;

  const timed = (fn) => withTimeout(Promise.resolve().then(fn), s.checkTimeoutMs);

  async function rpcCheck(server) {
    const started = Date.now();
    const health = await timed(() => server.getHealth());
    const latencyMs = Date.now() - started;
    if (!health || health.status !== 'healthy') throw new CheckError('RPC_ERROR', { latencyMs });
    return { ok: true, latencyMs };
  }

  async function networkCheck(server) {
    const net = await timed(() => server.getNetwork());
    const actual = net && net.passphrase;
    if (actual !== expectedPassphrase) {
      throw new CheckError('PASSPHRASE_MISMATCH', { expected: expectedPassphrase, actual: actual || null });
    }
    return { ok: true, expected: expectedPassphrase, actual };
  }

  async function ledgerCheck(server) {
    const latest = await timed(() => server.getLatestLedger());
    let closeTime = latest && latest.closeTime;
    if (closeTime === undefined && typeof server.getLedgers === 'function') {
      const page = await timed(() => server.getLedgers({ startLedger: latest.sequence, limit: 1 }));
      closeTime = page && page.ledgers && page.ledgers[0] && page.ledgers[0].ledgerCloseTime;
    }
    const closed = Number(closeTime);
    if (!latest || !Number.isFinite(closed)) throw new CheckError('RPC_ERROR');
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - closed));
    const info = { sequence: latest.sequence, ageSeconds };
    if (ageSeconds > s.maxLedgerAgeSeconds) throw new CheckError('STALE_LEDGER', info);
    return { ok: true, ...info };
  }

  async function contractCheck(server) {
    const { xdr, rpc } = require('@stellar/stellar-sdk');
    try {
      await timed(() =>
        server.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent),
      );
    } catch (err) {
      if (err instanceof CheckError) throw err;
      const notFound = err && (err.code === 404 || /not found/i.test(String(err.message)));
      throw new CheckError(notFound ? 'CONTRACT_NOT_FOUND' : 'RPC_ERROR');
    }
    return { ok: true };
  }

  async function run(name, fn, server) {
    try {
      return await fn(server);
    } catch (err) {
      const code = err instanceof CheckError ? err.code : 'RPC_ERROR';
      return { ok: false, ...(err instanceof CheckError ? err.extra : {}), error: code, _name: name };
    }
  }

  async function compute() {
    let server;
    try {
      server = getServer();
    } catch (err) {
      server = null;
    }
    const defs = { rpc: rpcCheck, network: networkCheck, ledger: ledgerCheck, contract: contractCheck };
    const names = Object.keys(defs);
    const results = await Promise.all(
      names.map((n) => (server ? run(n, defs[n], server) : { ok: false, error: 'RPC_ERROR' })),
    );
    const checks = {};
    names.forEach((n, i) => {
      const { _name, ...rest } = results[i];
      checks[n] = rest;
    });
    const ready = names.every((n) => checks[n].ok);
    return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', checks } };
  }

  async function check() {
    if (cached && Date.now() - cached.at < s.cacheSeconds * 1000) return cached.result;
    if (!inflight) {
      inflight = compute()
        .then((result) => {
          cached = { at: Date.now(), result };
          return result;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function handler(req, res, next) {
    try {
      const { statusCode, body } = await check();
      res.status(statusCode).json(body);
    } catch (err) {
      next(err);
    }
  }

  function reset() {
    cached = null;
    inflight = null;
  }

  return { check, handler, reset };
}

module.exports = { createReadiness, CheckError };
