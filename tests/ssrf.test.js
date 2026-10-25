'use strict';

/**
 * Tests for src/webhooks/ssrf.js
 */

const dns = require('dns').promises;
const { validateWebhookUrl, isPrivate } = require('../src/webhooks/ssrf');

// ---------------------------------------------------------------------------
// isPrivate unit tests
// ---------------------------------------------------------------------------

describe('isPrivate', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.0.1', true],
    ['::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    // public addresses
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false], // just outside 172.16/12
    ['192.169.0.1', false],
  ])('%s → isPrivate=%s', (ip, expected) => {
    expect(isPrivate(ip)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// validateWebhookUrl tests
// ---------------------------------------------------------------------------

describe('validateWebhookUrl', () => {
  const origEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    jest.restoreAllMocks();
  });

  test('rejects plain http:// in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(validateWebhookUrl('http://example.com/hook')).rejects.toThrow(
      /http:.*only allowed for localhost/,
    );
  });

  test('rejects https://127.0.0.1 (loopback) in production', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['127.0.0.1']);
    jest.spyOn(dns, 'resolve6').mockResolvedValue([]);
    await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(/private.*SSRF/);
  });

  test('rejects hostname resolving to 10.0.0.5 in production', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.5']);
    jest.spyOn(dns, 'resolve6').mockResolvedValue([]);
    await expect(validateWebhookUrl('https://internal.example.com/hook')).rejects.toThrow(
      /private.*SSRF/,
    );
  });

  test('rejects non-https, non-http scheme', async () => {
    await expect(validateWebhookUrl('ftp://example.com/hook')).rejects.toThrow(/https:/);
  });

  test('allows http://localhost in development', async () => {
    process.env.NODE_ENV = 'development';
    const result = await validateWebhookUrl('http://localhost:9000/hook');
    expect(result.url).toContain('localhost');
  });

  test('allows https:// with public IP and pins resolved IP', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    jest.spyOn(dns, 'resolve6').mockResolvedValue([]);
    const result = await validateWebhookUrl('https://example.com/hook');
    expect(result.url).toBe('https://example.com/hook');
    // pinnedUrl should use the resolved IP
    expect(result.pinnedUrl).toContain('93.184.216.34');
  });

  test('rejects invalid URL string', async () => {
    await expect(validateWebhookUrl('not-a-url')).rejects.toThrow(/invalid URL/);
  });
});
