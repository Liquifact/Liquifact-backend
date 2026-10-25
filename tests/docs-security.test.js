'use strict';

const request = require('supertest');
const app = require('../src/app');
const { escapeHtml, renderDocsHtml } = require('../src/docs');

describe('docs hardening', () => {
  test('/docs has no unpkg and a self-only CSP without unsafe-inline', async () => {
    const res = await request(app).get('/docs');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('unpkg.com');
    const csp = res.headers['content-security-policy'];
    expect(csp).not.toMatch(/https?:|unpkg/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test.each([
    ['/docs/assets/swagger-ui.css', /text\/css/],
    ['/docs/assets/swagger-ui-bundle.js', /javascript/],
    ['/docs/assets/docs.css', /text\/css/],
  ])('asset %s is served with immutable caching', async (url, type) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(type);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test.each(['/docs/assets/package.json', '/docs/assets/swagger-ui.js', '/docs/assets/..%2Fpackage.json'])(
    'non-whitelisted %s is 404',
    async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
    },
  );

  test('JSON routes carry no-store and strict CSP', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toBe('interest-cohort=()');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  test('interpolated URLs are escaped or rejected', () => {
    const html = renderDocsHtml({ frontendUrl: 'https://x.test/"><script>', explorerUrl: 'javascript:alert(1)' });
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain('javascript:');
    expect(escapeHtml('<a href="x">&\'')).toBe('&#60;a href=&#34;x&#34;&#62;&#38;&#39;');
  });
});
