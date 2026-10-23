'use strict';

/**
 * Tests that the OpenAPI spec documents all webhook routes and schemas.
 */

const request = require('supertest');
const app = require('../src/app');

describe('OpenAPI spec includes webhook routes', () => {
  let spec;

  beforeAll(async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    spec = res.body;
  });

  test('spec version is 3.0.3', () => {
    expect(spec.openapi).toBe('3.0.3');
  });

  test('/api/webhooks path exists with POST and GET', () => {
    expect(spec.paths['/api/webhooks']).toBeDefined();
    expect(spec.paths['/api/webhooks'].post).toBeDefined();
    expect(spec.paths['/api/webhooks'].get).toBeDefined();
  });

  test('/api/webhooks/{id} path exists with DELETE', () => {
    expect(spec.paths['/api/webhooks/{id}']).toBeDefined();
    expect(spec.paths['/api/webhooks/{id}'].delete).toBeDefined();
  });

  test('/api/webhooks/{id}/deliveries path exists with GET', () => {
    expect(spec.paths['/api/webhooks/{id}/deliveries']).toBeDefined();
    expect(spec.paths['/api/webhooks/{id}/deliveries'].get).toBeDefined();
  });

  test('Webhooks tag is present', () => {
    const tagNames = spec.tags.map((t) => t.name);
    expect(tagNames).toContain('Webhooks');
  });

  test('BearerAuth security scheme is defined', () => {
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
  });

  test('POST /api/webhooks documents 201, 400, 401, 503', () => {
    const responses = spec.paths['/api/webhooks'].post.responses;
    expect(responses['201']).toBeDefined();
    expect(responses['400']).toBeDefined();
    expect(responses['401']).toBeDefined();
    expect(responses['503']).toBeDefined();
  });

  test('webhook routes are security-gated in spec', () => {
    const post = spec.paths['/api/webhooks'].post;
    expect(post.security).toBeDefined();
    expect(post.security.length).toBeGreaterThan(0);
  });
});
