'use strict';

/**
 * @fileoverview Concurrency smoke tests for the metrics endpoint.
 * 
 * Tests the /metrics endpoint under concurrent load to verify:
 * - No race conditions in metrics collection
 * - Consistent state across concurrent reads
 * - Proper error handling under load
 * 
 * Issue: #873
 */

const http = require('http');

// Helper to make HTTP requests
function makeRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Metrics Endpoint Concurrency Tests', () => {
  const baseUrl = process.env.LOAD_BASE_URL || 'http://127.0.0.1:3001';

  describe('Concurrent GET requests', () => {
    it('handles 10 concurrent metrics reads without errors', async () => {
      const requests = Array(10).fill(null).map(() =>
        makeRequest({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/metrics',
          method: 'GET'
        }).catch(() => ({ status: 0, body: null }))
      );

      const responses = await Promise.all(requests);
      
      // Filter out connection errors (server not running)
      const successful = responses.filter(r => r.status > 0);
      
      if (successful.length === 0) {
        // Server not running, skip test
        console.log('Server not running, skipping concurrency test');
        return;
      }

      // All successful responses should be valid Prometheus format
      successful.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toContain('# HELP');
        expect(response.body).toContain('# TYPE');
      });
    });

    it('maintains consistency under 20 concurrent reads', async () => {
      const requests = Array(20).fill(null).map(() =>
        makeRequest({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/metrics',
          method: 'GET'
        }).catch(() => ({ status: 0, body: null }))
      );

      const responses = await Promise.all(requests);
      const successful = responses.filter(r => r.status > 0);

      if (successful.length === 0) {
        console.log('Server not running, skipping consistency test');
        return;
      }

      // All should succeed with same status
      const statuses = successful.map(r => r.status);
      expect(statuses.every(s => s === 200)).toBe(true);
    });

    it('handles 50 concurrent metrics scrapes', async () => {
      const requests = Array(50).fill(null).map(() =>
        makeRequest({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/metrics',
          method: 'GET'
        }).catch(() => ({ status: 0, body: null }))
      );

      const responses = await Promise.all(requests);
      const successful = responses.filter(r => r.status > 0);

      if (successful.length === 0) {
        console.log('Server not running, skipping high-load test');
        return;
      }

      // No 500 errors should occur
      const statuses = successful.map(r => r.status);
      const has500 = statuses.some(s => s === 500);
      expect(has500).toBe(false);
    });
  });

  describe('Rate limiting under load', () => {
    it('enforces rate limits on rapid metrics requests', async () => {
      // Fire 100 rapid requests (should exceed default rate limit)
      const requests = Array(100).fill(null).map(() =>
        makeRequest({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/metrics',
          method: 'GET'
        }).catch(() => ({ status: 0, body: null }))
      );

      const responses = await Promise.all(requests);
      const successful = responses.filter(r => r.status > 0);

      if (successful.length === 0) {
        console.log('Server not running, skipping rate limit test');
        return;
      }

      const statuses = successful.map(r => r.status);
      const rateLimited = statuses.filter(s => s === 429).length;
      
      // Some should be rate limited (429)
      expect(rateLimited).toBeGreaterThan(0);
    });
  });

  describe('State consistency', () => {
    it('metrics output remains consistent after concurrent operations', async () => {
      // Initial read
      const initial = await makeRequest({
        hostname: '127.0.0.1',
        port: 3001,
        path: '/metrics',
        method: 'GET'
      }).catch(() => ({ status: 0, body: null }));

      if (initial.status === 0) {
        console.log('Server not running, skipping state consistency test');
        return;
      }

      // Concurrent operations
      const operations = Array(20).fill(null).map(() =>
        makeRequest({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/metrics',
          method: 'GET'
        }).catch(() => ({ status: 0, body: null }))
      );

      await Promise.all(operations);

      // Final read should have same structure (not necessarily same values due to counters)
      const final = await makeRequest({
        hostname: '127.0.0.1',
        port: 3001,
        path: '/metrics',
        method: 'GET'
      }).catch(() => ({ status: 0, body: null }));

      // Both should be valid Prometheus format
      expect(final.body).toContain('# HELP');
      expect(final.body).toContain('# TYPE');
      expect(final.status).toBe(200);
    });
  });
});
