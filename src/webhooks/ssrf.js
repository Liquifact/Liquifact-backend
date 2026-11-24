'use strict';

/**
 * SSRF guard for webhook URL validation.
 *
 * Rules:
 *  - https: is always required; http: is allowed only for localhost when
 *    NODE_ENV !== 'production'.
 *  - In production, the resolved IP addresses of the hostname must not fall
 *    inside any private, link-local, loopback, unspecified, CGNAT, multicast,
 *    or reserved range.
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
  // Canonicalise IPv6 so expanded and IPv4-mapped spellings use the same checks.
  const normalized = net.isIPv6(ip) ? new URL(`https://[${ip}]`).hostname.slice(1, -1) : ip;
  const v4mapped = normalized.match(/^::ffff:([\da-f]+):([\da-f]+)$/i);
  const addr = v4mapped
    ? v4mapped.slice(1).flatMap(group => {
      const value = parseInt(group, 16);
      return [value >> 8, value & 0xff];
    }).join('.')
    : normalized;

  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    const [a, b, c] = parts;
    // 0.0.0.0/8 (this network)
    if (a === 0) { return true; }
    // 100.64.0.0/10 (shared address space / CGNAT)
    if (a === 100 && b >= 64 && b <= 127) { return true; }
    // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 0 && c === 0) { return true; }
    // 198.18.0.0/15 (benchmarking)
    if (a === 198 && (b === 18 || b === 19)) { return true; }
    // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved / broadcast)
    if (a >= 224) { return true; }
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
    // Unspecified and loopback (IPv6 was canonicalised above).
    if (lower === '::' || lower === '::1') { return true; }
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
    // ff00::/8 (multicast)
    if (fb === 0xff) { return true; }
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
  const { protocol, port } = parsed;
  // WHATWG URL hostnames include brackets around IPv6 literals.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
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
    return { url: urlString, pinnedUrl: urlString, host: parsed.hostname };
  }

  if (protocol !== 'https:') {
    throw new Error('URL must use https: protocol');
  }

  // If the hostname is already a numeric IP, skip DNS resolution and check directly
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (isPrivate(hostname)) {
      throw new Error(`hostname resolves to a private/reserved address (${hostname}); SSRF not allowed`);
    }
    return { url: urlString, pinnedUrl: urlString, host: `${parsed.hostname}${portSuffix}` };
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

/**
 * Re-resolve hostname on every delivery, refuse private ranges, return connect IP.
 * TLS/SNI still use the original hostname from the URL.
 *
 * @param {string} urlString
 * @returns {Promise<{ address: string, family: 4|6, hostHeader: string }>}
 */
async function resolveAndValidateForDelivery(urlString) {
  const isProd = process.env.NODE_ENV === 'production';
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('invalid webhook URL');
  }

  const { protocol, hostname } = parsed;
  const portSuffix = parsed.port ? `:${parsed.port}` : '';

  if (protocol === 'http:') {
    const isLocalhost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (isProd || !isLocalhost) {
      throw new Error('http: URLs are only allowed for localhost in non-production environments');
    }
    const address = hostname === 'localhost' ? '127.0.0.1' : hostname;
    return {
      address,
      family: net.isIPv6(address) ? 6 : 4,
      hostHeader: `\( {hostname} \){portSuffix}`,
    };
  }

  if (protocol !== 'https:') {
    throw new Error('URL must use https: protocol');
  }

  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (isPrivate(hostname)) {
      throw new Error(`hostname resolves to a private/reserved address (${hostname}); SSRF not allowed`);
    }
    return {
      address: hostname,
      family: net.isIPv6(hostname) ? 6 : 4,
      hostHeader: `\( {hostname} \){portSuffix}`,
    };
  }

  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) {
    throw new Error('hostname resolved to no addresses');
  }
  for (const addr of addresses) {
    if (isPrivate(addr)) {
      throw new Error(`hostname resolves to a private/reserved address (${addr}); SSRF not allowed`);
    }
  }
  const address = addresses[0];
  return {
    address,
    family: net.isIPv6(address) ? 6 : 4,
    hostHeader: `\( {hostname} \){portSuffix}`,
  };
}

module.exports = { validateWebhookUrl, isPrivate, resolveAndValidateForDelivery };
module.exports = { validateWebhookUrl, isPrivate };
