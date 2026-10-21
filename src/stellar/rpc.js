'use strict';

const config = require('../config');

/**
 * Shared Soroban RPC client.
 *
 * The client is created lazily so that importing this module never opens a
 * connection, and it is reused for every request: building a `rpc.Server` per
 * call (as the escrow routes used to do) throws away the underlying HTTP
 * agent's connection pool and adds latency to every read.
 *
 * `setRpcServer` exists as an injection seam: tests (and future callers that
 * need a differently configured client) can swap the shared instance without
 * touching the modules that consume it.
 *
 * @type {import('@stellar/stellar-sdk').rpc.Server | null}
 */
let server = null;

/**
 * Returns the shared Soroban RPC client, creating it on first use.
 *
 * @returns {import('@stellar/stellar-sdk').rpc.Server} the shared RPC client
 */
function getRpcServer() {
  if (!server) {
    const { rpc } = require('@stellar/stellar-sdk');
    server = new rpc.Server(config.rpcUrl);
  }
  return server;
}

/**
 * Replaces the shared Soroban RPC client.
 *
 * @param {import('@stellar/stellar-sdk').rpc.Server | null} instance client to use, or null to reset
 * @returns {void}
 */
function setRpcServer(instance) {
  server = instance || null;
}

/**
 * Drops the shared Soroban RPC client so the next call rebuilds it from the
 * current configuration.
 *
 * @returns {void}
 */
function resetRpcServer() {
  server = null;
}

module.exports = { getRpcServer, setRpcServer, resetRpcServer };
