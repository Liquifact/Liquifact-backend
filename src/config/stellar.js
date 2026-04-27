const config = require('./index');

const VALID_NETWORKS = ['TESTNET', 'MAINNET', 'FUTURENET'];

const NETWORK_RPC_MAP = {
  TESTNET: 'https://soroban-testnet.stellar.org',
  MAINNET: 'https://soroban.stellar.org',
  FUTURENET: 'https://rpc-futurenet.stellar.org',
};

const NETWORK_PASSPHRASE_MAP = {
  TESTNET: 'Test SDF Network ; September 2015',
  MAINNET: 'Public Global Stellar Network ; September 2014',
  FUTURENET: 'Test SDF Future Network ; October 2022',
};

/**
 * Get Stellar-specific configuration.
 * Ensures fail-fast behavior if config wasn't validated on boot.
 * 
 * @returns {Object} Stellar config object
 */
function getStellarConfig() {
  const { SOROBAN_RPC_URL, NETWORK_PASSPHRASE } = config.get();
  return {
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
  };
}

/**
 * Validates the Stellar configuration against the specified network.
 * 
 * @returns {Object} Validated Stellar config
 */
function validateStellarConfig() {
  const network = process.env.STELLAR_NETWORK || 'TESTNET';
  const rpcUrl = process.env.SOROBAN_RPC_URL || NETWORK_RPC_MAP[network];

  if (!VALID_NETWORKS.includes(network)) {
    throw new Error('Invalid STELLAR_NETWORK');
  }

  const expectedRpc = NETWORK_RPC_MAP[network];
  if (rpcUrl !== expectedRpc && network !== 'FUTURENET') {
    // Allow custom RPC for FUTURENET but enforce for others in this strict mock
    throw new Error(`STELLAR_NETWORK=${network} requires SOROBAN_RPC_URL="${expectedRpc}"`);
  }

  return {
    network,
    rpcUrl,
    passphrase: NETWORK_PASSPHRASE_MAP[network],
  };
}

/**
 * Get passphrase for a network.
 * 
 * @param {string} network - Network name
 * @returns {string} Passphrase
 */
function getNetworkPassphrase(network) {
  if (!network || !NETWORK_PASSPHRASE_MAP[network]) {
    throw new Error('Unknown network');
  }
  return NETWORK_PASSPHRASE_MAP[network];
}

/**
 * Get expected RPC URL for a network.
 * 
 * @param {string} network - Network name
 * @returns {string} RPC URL
 */
function getExpectedRpc(network) {
  if (!network || !NETWORK_RPC_MAP[network]) {
    throw new Error('Unknown network');
  }
  return NETWORK_RPC_MAP[network];
}

module.exports = {
  getStellarConfig,
  validateStellarConfig,
  getNetworkPassphrase,
  getExpectedRpc,
  VALID_NETWORKS,
  NETWORK_RPC_MAP,
  NETWORK_PASSPHRASE_MAP,
};