'use strict';

/**
 * Tests for src/webhooks/ssrf.js
 */

const dns = require('dns').promises;
const { validateWebhookUrl, isPrivate } = require('../src/webhooks/ssrf');

const reservedCases = [
  ['0.0.0.0', true], ['0.255.255.255', true], ['1.0.0.0', false],
  ['100.63.255.255', false], ['100.64.0.0', true],
  ['100.127.255.255', true], ['100.128.0.0', false],
  ['191.255.255.255', false], ['192.0.0.0', true],
  ['192.0.0.255', true], ['192.0.1.0', false],
  ['198.17.255.255', false], ['198.18.0.0', true],
  ['198.19.255.255', true], ['198.20.0.0', false],
  ['223.255.255.255', false], ['224.0.0.0', true],
  ['239.255.255.255', true], ['240.0.0.0', true], ['255.255.255.255', true],
  ['::', true], ['0:0:0:0:0:0:0:0', true], ['::2', false],
  ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
  ['ff00::', true], ['ff02::1', true], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
];

const mappedCases = reservedCases.filter(([ip]) => !ip.includes(':'))
  .map(([ip, blocked]) => [`::ffff:${ip}`, blocked]);

// ---------------------------------------------------------------------------
// isPrivate unit tests
// ---------------------------------------------------------------------------

describe('isPrivate', () => {
  test.each([...reservedCases, ...mappedCases])('%s reserved=%s', (ip, blocked) => {
    expect(isPrivate(ip)).toBe(blocked);
  });

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

  test.each([...reservedCases, ...mappedCases])('literal %s reserved=%s', async (ip, blocked) => {
    process.env.NODE_ENV = 'production';
    const host = ip.includes(':') ? `[${ip}]` : ip;
    const url = `https://${host}:8443/hook`;
    if (blocked) {
      await expect(validateWebhookUrl(url)).rejects.toThrow(/private.*SSRF/);
    } else {
      await expect(validateWebhookUrl(url)).resolves.toEqual({
        url, pinnedUrl: url, host: new URL(url).host,
      });
    }
  });

  test.each([...reservedCases, ...mappedCases])('DNS %s reserved=%s', async (ip, blocked) => {
    process.env.NODE_ENV = 'production';
    // Include a public result first to ensure every answer is checked.
    jest.spyOn(dns, 'resolve4').mockResolvedValue(ip.includes(':') ? ['8.8.8.8'] : ['8.8.8.8', ip]);
    jest.spyOn(dns, 'resolve6').mockResolvedValue(ip.includes(':') ? [ip] : []);
    const result = validateWebhookUrl('https://example.com/hook');
    if (blocked) {
      await expect(result).rejects.toThrow(/private.*SSRF/);
    } else {
      await expect(result).resolves.toMatchObject({ pinnedUrl: 'https://8.8.8.8/hook' });
    }
  });

  test.each(['0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', 'ff02::1'])(
    'rejects %s outside production too', async ip => {
      process.env.NODE_ENV = 'development';
      const host = ip.includes(':') ? `[${ip}]` : ip;
      await expect(validateWebhookUrl(`https://${host}/hook`)).rejects.toThrow(/private.*SSRF/);
    },
  );

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
