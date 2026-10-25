'use strict';

/**
 * SSRF guard for webhook URL validation.
 *
 * Rules:
 *  - https: is always required; http: is allowed only for localhost when
 *    NODE_ENV !== 'production'.
 *  - In production, the resolved IP addresses of the hostname must not fall
 *    inside any private, link-local, or loopback range (RFC 1918, 127.0.0.0/8,
 *    169.254.0.0/16, ::1, fc00::/7).
 *
 * DNS rebinding mitigation: we resolve the hostname once for validation and
 * re-resolve inside the fetch by pinning the numeric IP in the URL that is
 * actually fetched, preserving the Host header separately so TLS SNI and
 * virtual hosting work correctly.
 */

const dns = require('dns').promises;
const net = require('net');

/** @param {string} ip IPv4 dotted-decimal or IPv6 string */
function isPrivate(ip) {
  // Normalise IPv6-mapped IPv4 addresses: ::ffff:1.2.3.4
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4mapped ? v4mapped[1] : ip;

  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    const [a, b] = parts;
    // 127.0.0.0/8
    if (a === 127) { return true; }
    // 10.0.0.0/8
    if (a === 10) { return true; }
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) { return true; }
    // 192.168.0.0/16
    if (a === 192 && b === 168) { return true; }
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) { return true; }
    return false;
  }

  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    // ::1 loopback
    if (lower === '::1') { return true; }
    // Expand the first group for prefix checks
    // fc00::/7 (unique local) — covers fc00:: through fdff::
    // fe80::/10 (link-local) — covers fe80:: through febf::
    //
    // Parse the first 16-bit group as a number.
    const colonIdx = lower.indexOf(':');
    const firstGroup = colonIdx === -1 ? lower : lower.slice(0, colonIdx);
    // Handle the compressed '::' case (e.g. '::1' already handled above)
    const firstByte16 = parseInt(firstGroup || '0', 16);
    // fc00::/7: first byte masked with 0xfe === 0xfc
    const fb = (firstByte16 >> 8) & 0xff;
    if ((fb & 0xfe) === 0xfc) { return true; }
    // fe80::/10: top 10 bits of 0xfe80 = 1111111010
    if ((firstByte16 & 0xffc0) === 0xfe80) { return true; }
    return false;
  }

  // Unknown format — treat as private to be safe
  return true;
}

/**
 * Validates a webhook URL and resolves its IP for SSRF-safe delivery.
 *
 * @param {string} urlString the URL to validate
 * @returns {Promise<{ url: string, pinnedUrl: string, host: string }>}
 *   pinnedUrl has the hostname replaced with the resolved IP (for delivery).
 *   host is the original hostname (for the Host header).
 * @throws {Error} with a human-readable message on rejection
 */
async function validateWebhookUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('invalid URL');
  }

  const isProd = process.env.NODE_ENV === 'production';
  const { protocol, hostname, port } = parsed;
  const portSuffix = port ? `:${port}` : '';

  if (protocol === 'http:') {
    const isLocalhost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1';
    if (isProd || !isLocalhost) {
      throw new Error('http: URLs are only allowed for localhost in non-production environments');
    }
    // http://localhost in dev — allow without DNS check
    return { url: urlString, pinnedUrl: urlString, host: hostname };
  }

  if (protocol !== 'https:') {
    throw new Error('URL must use https: protocol');
  }

  // If the hostname is already a numeric IP, skip DNS resolution and check directly
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (isPrivate(hostname)) {
      throw new Error(`hostname resolves to a private/reserved address (${hostname}); SSRF not allowed`);
    }
    return { url: urlString, pinnedUrl: urlString, host: `${hostname}${portSuffix}` };
  }

  // Resolve hostname to IPs and check all of them
  let addresses;
  try {
    // Resolve A and AAAA records. We deliberately avoid dns.resolve(ANY) as it
    // may not be universally supported and is harder to mock in tests.
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolve6(hostname).catch(() => []),
    ]);
    addresses = [...v4, ...v6];
  } catch {
    // DNS lookup failed — reject to be safe in production
    if (isProd) {
      throw new Error('hostname could not be resolved');
    }
    return { url: urlString, pinnedUrl: urlString, host: hostname };
  }

  if (addresses.length === 0) {
    throw new Error('hostname resolved to no addresses');
  }

  for (const addr of addresses) {
    if (isPrivate(addr)) {
      throw new Error(`hostname resolves to a private/reserved address (${addr}); SSRF not allowed`);
    }
  }

  // Pin to the first resolved address to prevent DNS rebinding between
  // validation and actual fetch.
  const pinnedIp = addresses[0];
  const isV6 = net.isIPv6(pinnedIp);
  const hostInUrl = isV6 ? `[${pinnedIp}]` : pinnedIp;

  const pinnedUrl = new URL(urlString);
  pinnedUrl.hostname = isV6 ? `[${pinnedIp}]` : pinnedIp;
  // URL constructor handles brackets for IPv6 in .hostname; use .host instead
  // to avoid double-bracketing.
  const pinnedString = `${protocol}//${hostInUrl}${portSuffix}${pinnedUrl.pathname}${pinnedUrl.search}`;

  return { url: urlString, pinnedUrl: pinnedString, host: `${hostname}${portSuffix}` };
}

module.exports = { validateWebhookUrl, isPrivate };
