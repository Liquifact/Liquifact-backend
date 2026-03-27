/**
 * Health check service for dependency monitoring.
 * @module services/health
 */

/**
 * Checks if the Soroban RPC endpoint is reachable.
 * 
 * @returns {Promise<{status: string, latency?: number, error?: string}>} Health status.
 */
async function checkSorobanHealth() {
  const url = process.env.SOROBAN_RPC_URL;
  
  if (!url) {
    return { status: 'unknown', error: 'SOROBAN_RPC_URL not configured' };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    const latency = Date.now() - start;
    
    if (response.ok) {
      return { status: 'healthy', latency };
    }
    return { status: 'unhealthy', latency, error: `HTTP ${response.status}` };
  } catch (error) {
    const latency = Date.now() - start;
    return { status: 'unhealthy', latency, error: error.message };
  }
}

/**
 * Checks if the database is reachable (placeholder for future implementation).
 * 
 * @returns {Promise<{status: string, latency?: number, error?: string}>} Health status.
 */
async function checkDatabaseHealth() {
  if (!process.env.DATABASE_URL) {
    return { status: 'not_configured' };
  }
  
  // Placeholder: implement actual DB ping when database is added
  return { status: 'not_implemented', error: 'Database health check pending' };
}

/**
 * Performs all dependency health checks.
 * 
 * @returns {Promise<{healthy: boolean, checks: Object}>} Aggregated health status.
 */
async function performHealthChecks() {
  const [soroban, database] = await Promise.all([
    checkSorobanHealth(),
    checkDatabaseHealth()
  ]);

  const checks = { soroban, database };
  const healthy = soroban.status === 'healthy' || soroban.status === 'unknown';

  return { healthy, checks };
}

module.exports = {
  checkSorobanHealth,
  checkDatabaseHealth,
  performHealthChecks
};
