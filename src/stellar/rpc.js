'use strict';

const config = require('../config');

let shared = null;

/**
 * Lazily constructed, shared Soroban RPC client.
 *
 * @returns {import('@stellar/stellar-sdk').rpc.Server} shared RPC server client
 */
function getServer() {
  if (!shared) {
    const { rpc } = require('@stellar/stellar-sdk');
    shared = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
  }
  return shared;
}

/**
 * Replaces the shared client (used by tests to inject a mock).
 *
 * @param {object|null} server client to use, or null to reset
 * @returns {void}
 */
function setServer(server) {
  shared = server;
}

module.exports = { getServer, setServer };
