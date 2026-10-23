'use strict';

const path = require('path');
const express = require('express');

const DEFAULT_FRONTEND_URL = 'https://liquifact-frontend.vercel.app';
const ASSET_CACHE = 'public, max-age=31536000, immutable';
const SWAGGER_FILES = ['swagger-ui.css', 'swagger-ui-bundle.js'];

/**
 * @param {unknown} value raw value
 * @returns {string} HTML-escaped string
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Accept only well-formed http(s) URLs.
 * @param {string} value candidate URL
 * @param {string} fallback returned when value is not http(s)
 * @returns {string} safe URL
 */
function safeHttpUrl(value, fallback) {
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href;
    }
  } catch {
    // fall through
  }
  return fallback;
}

/**
 * @param {{frontendUrl: string, explorerUrl: string}} cfg links shown in the docs bar
 * @returns {string} docs page HTML (local assets only, no inline style/script)
 */
function renderDocsHtml(cfg) {
  const website = escapeHtml(safeHttpUrl(cfg.frontendUrl, DEFAULT_FRONTEND_URL));
  const explorer = escapeHtml(safeHttpUrl(cfg.explorerUrl, '#'));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LiquiFact API Docs</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"><link rel="stylesheet" href="/docs/assets/docs.css"></head>
<body><div class="lf-bar">LiquiFact API<a href="/">Index</a><a href="/openapi.json">openapi.json</a>
<a href="${website}">Website</a><a href="${explorer}">Escrow contract</a></div>
<div id="swagger-ui"></div><script src="/docs/assets/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>`;
}

const DOCS_CSS =
  'body{margin:0;background:#fafafa}.lf-bar{background:#0b1020;color:#fff;padding:14px 20px;font:600 16px system-ui}' +
  '.lf-bar a{color:#7dd3fc;margin-left:16px;font-weight:400;text-decoration:none}';

/**
 * @param {import('express').Express} app express app
 * @param {{frontendUrl: string, explorerUrl: string}} cfg links shown in the docs bar
 * @returns {void}
 */
function mountDocs(app, cfg) {
  const dir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
  const assets = express.Router();
  assets.get('/docs.css', (req, res) => {
    res.set('Cache-Control', ASSET_CACHE).type('text/css').send(DOCS_CSS);
  });
  assets.get('/:file', (req, res, next) => {
    if (!SWAGGER_FILES.includes(req.params.file)) {
      return next();
    }
    return res.sendFile(
      req.params.file,
      { root: dir, headers: { 'Cache-Control': ASSET_CACHE }, cacheControl: false, dotfiles: 'deny' },
      (err) => err && next(),
    );
  });
  app.use('/docs/assets', assets);

  app.get('/docs', (req, res) => {
    res.type('html').send(renderDocsHtml(cfg));
  });
  app.get('/docs/init.js', (req, res) => {
    res.type('application/javascript').send("window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'});");
  });
}

module.exports = { escapeHtml, safeHttpUrl, renderDocsHtml, mountDocs };
