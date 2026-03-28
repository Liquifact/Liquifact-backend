'use strict';

/**
 * @module middleware/security
 * @description Security header middleware using Helmet for HTTP hardening.
 *
 * Applies the following protections:
 * - Content-Security-Policy (CSP): restricts resource loading to same-origin
 * - Strict-Transport-Security (HSTS): enforces HTTPS for 1 year with preload
 * - X-Frame-Options: prevents clickjacking by denying framing
 * - X-Content-Type-Options: prevents MIME type sniffing
 * - Referrer-Policy: limits referrer info sent to external sites
 * - Cross-Origin-Opener-Policy: isolates browsing context group
 * - Cross-Origin-Resource-Policy: restricts cross-origin resource loading
 * - Cross-Origin-Embedder-Policy: requires CORP for all loaded resources
 * - DNS Prefetch Control: disables DNS prefetching to prevent info leaks
 * - X-Permitted-Cross-Domain-Policies: denies Adobe cross-domain policies
 * - Origin-Agent-Cluster: enables origin-keyed agent clustering
 * - X-Download-Options: prevents IE from executing downloaded files
 */

const helmet = require('helmet');

/**
 * Creates and returns configured Helmet security middleware.
 *
 * All headers are set with strict production-ready values. Apply this
 * middleware before any other middleware or route handlers to ensure
 * headers are present on every response.
 *
 * @returns {Function} Express middleware that sets secure HTTP response headers
 *
 * @example
 * const { createSecurityMiddleware } = require('./middleware/security');
 * app.use(createSecurityMiddleware());
 */
function createSecurityMiddleware() {
  return helmet({
    /**
     * Content-Security-Policy: restrict resource loading to same-origin only.
     * Prevents XSS, data injection, and unauthorized third-party resource loading.
     */
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ['\'self\''],
        scriptSrc: ['\'self\''],
        styleSrc: ['\'self\''],
        imgSrc: ['\'self\'', 'data:'],
        connectSrc: ['\'self\''],
        fontSrc: ['\'self\''],
        objectSrc: ['\'none\''],
        mediaSrc: ['\'self\''],
        frameSrc: ['\'none\''],
        baseUri: ['\'self\''],
        formAction: ['\'self\''],
      },
    },

    /**
     * Cross-Origin-Embedder-Policy: require CORP for embedded resources.
     * Enables cross-origin isolation, a prerequisite for SharedArrayBuffer.
     */
    crossOriginEmbedderPolicy: { policy: 'require-corp' },

    /**
     * Cross-Origin-Opener-Policy: isolate the top-level browsing context.
     * Prevents cross-origin window references and Spectre-style attacks.
     */
    crossOriginOpenerPolicy: { policy: 'same-origin' },

    /**
     * Cross-Origin-Resource-Policy: restrict resources to same-origin.
     * Prevents cross-origin reads of sensitive API responses.
     */
    crossOriginResourcePolicy: { policy: 'same-origin' },

    /**
     * DNS Prefetch Control: disable speculative DNS resolution.
     * Prevents privacy leaks from DNS queries triggered by page content.
     */
    dnsPrefetchControl: { allow: false },

    /**
     * X-Frame-Options: deny all iframe embedding.
     * Prevents clickjacking by disallowing the page in any frame.
     */
    frameguard: { action: 'deny' },

    /**
     * Remove X-Powered-By header.
     * Prevents server technology fingerprinting by attackers.
     */
    hidePoweredBy: true,

    /**
     * Strict-Transport-Security: enforce HTTPS for 1 year, include subdomains,
     * and opt into HSTS preload list so browsers never connect via plain HTTP.
     */
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },

    /**
     * X-Download-Options: prevent IE from executing downloaded files in site context.
     * Mitigates drive-by download attacks in older IE versions.
     */
    ieNoOpen: true,

    /**
     * X-Content-Type-Options: disable MIME type sniffing.
     * Forces browsers to honour the declared Content-Type, blocking MIME confusion attacks.
     */
    noSniff: true,

    /**
     * Origin-Agent-Cluster: enable origin-keyed agent clustering.
     * Provides stronger process-level isolation between origins.
     */
    originAgentCluster: true,

    /**
     * X-Permitted-Cross-Domain-Policies: deny Adobe Flash/PDF cross-domain access.
     * Prevents legacy plugin-based cross-domain policy exploits.
     */
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },

    /**
     * Referrer-Policy: send full URL only for same-origin requests;
     * send only the origin for cross-origin HTTPS requests; omit for HTTP downgrades.
     */
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

module.exports = { createSecurityMiddleware };
