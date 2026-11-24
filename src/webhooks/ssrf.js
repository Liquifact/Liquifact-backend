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

/**
 * Validates whether an IPv4 address falls within private, link-local,
 * loopback, unspecified, CGNAT, multicast, or reserved ranges.
 *
 * @param {string} addr IPv4 dotted-decimal
 * @returns {boolean}
 */
function isPrivateIPv4(addr) {
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

/**
 * Expands an IPv6 address into an array of 8 16-bit integers (0 - 65535).
 * Strips brackets before parsing, handles '::' compression, and converts
 * trailing dotted-decimal IPv4 groups.
 *
 * @param {string} ipStr IPv6 string (optionally bracketed)
 * @returns {number[]|null} array of 8 integers or null if invalid
 */
function expandIPv6(ipStr) {
  if (typeof ipStr !== 'string') return null;
  let s = ipStr.replace(/^\[|\]$/g, '').trim();

  // If ending with dotted-decimal IPv4 (e.g. ::ffff:127.0.0.1 or 64:ff9b::10.0.0.1)
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4parts = tail.split('.').map(Number);
      if (v4parts.length === 4 && v4parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
        const g1 = ((v4parts[0] << 8) | v4parts[1]).toString(16);
        const g2 = ((v4parts[2] << 8) | v4parts[3]).toString(16);
        s = s.slice(0, lastColon) + ':' + g1 + ':' + g2;
      } else {
        return null;
      }
    }
  }

  const doubleColon = s.indexOf('::');
  let groups = [];
  if (doubleColon !== -1) {
    if (s.indexOf('::', doubleColon + 2) !== -1) return null;
    const left = s.slice(0, doubleColon);
    const right = s.slice(doubleColon + 2);
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 1) return null;
    groups = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    groups = s.split(':');
  }

  if (groups.length !== 8) return null;
  const numGroups = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    numGroups.push(parseInt(g, 16));
  }
  return numGroups;
}

/** @param {string} ip IPv4 dotted-decimal or IPv6 string (optionally bracketed) */
function isPrivate(ip) {
  if (typeof ip !== 'string') return true;
  // Strip brackets before net.isIP
  const cleanIp = ip.replace(/^\[|\]$/g, '').trim();

  if (net.isIPv4(cleanIp)) {
    return isPrivateIPv4(cleanIp);
  }

  // Expand any IPv6 to 8 groups
  const groups = expandIPv6(cleanIp);
  if (!groups) {
    // Unknown format — treat as private to be safe
    return true;
  }

  // Map embedded addresses back to IPv4 for the private check:

  // 1. ::ffff:0:0/96 (IPv4-mapped hex or dotted form)
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const byte0 = (groups[6] >> 8) & 0xff;
    const byte1 = groups[6] & 0xff;
    const byte2 = (groups[7] >> 8) & 0xff;
    const byte3 = groups[7] & 0xff;
    return isPrivateIPv4(`${byte0}.${byte1}.${byte2}.${byte3}`);
  }

  // 2. 64:ff9b::/96 (NAT64 well-known prefix)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const byte0 = (groups[6] >> 8) & 0xff;
    const byte1 = groups[6] & 0xff;
    const byte2 = (groups[7] >> 8) & 0xff;
    const byte3 = groups[7] & 0xff;
    return isPrivateIPv4(`${byte0}.${byte1}.${byte2}.${byte3}`);
  }

  // 3. 2002::/16 (6to4 embedded IPv4 addresses)
  if (groups[0] === 0x2002) {
    const byte0 = (groups[1] >> 8) & 0xff;
    const byte1 = groups[1] & 0xff;
    const byte2 = (groups[2] >> 8) & 0xff;
    const byte3 = groups[2] & 0xff;
    return isPrivateIPv4(`${byte0}.${byte1}.${byte2}.${byte3}`);
  }

  // Standard IPv6 private / reserved ranges:

  // Unspecified (::)
  if (groups.every(g => g === 0)) { return true; }

  // Loopback (::1)
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) { return true; }

  // Unique local: fc00::/7 (covers fc00:: through fdff::)
  if ((groups[0] & 0xfe00) === 0xfc00) { return true; }

  // Link-local: fe80::/10 (covers fe80:: through febf::)
  if ((groups[0] & 0xffc0) === 0xfe80) { return true; }

  // Multicast: ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) { return true; }

  return false;
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
