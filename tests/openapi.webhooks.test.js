'use strict';

/**
 * Tests that the OpenAPI spec documents all webhook routes and schemas.
 */

const { buildSpec } = require('../src/openapi');

describe('OpenAPI spec includes webhook routes', () => {
  let spec;

  beforeAll(() => {
    spec = buildSpec('http://localhost');
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

  test('/api/webhooks/{id}/enable path exists with POST', () => {
    expect(spec.paths['/api/webhooks/{id}/enable'].post).toBeDefined();
    expect(spec.paths['/api/webhooks/{id}/enable'].post.responses['200']).toBeDefined();
  });

  test('/api/webhooks/{id}/deliveries path exists with GET', () => {
    expect(spec.paths['/api/webhooks/{id}/deliveries']).toBeDefined();
    expect(spec.paths['/api/webhooks/{id}/deliveries'].get).toBeDefined();
  });

  test('Webhooks tag is present', () => {
    const tagNames = spec.tags.map((t) => t.name);
    expect(tagNames).toContain('Webhooks');
  });

  test('admin bearer security scheme is defined and used by webhook routes', () => {
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.adminBearer).toBeDefined();
    expect(spec.paths['/api/webhooks'].post.security).toEqual([{ adminBearer: [] }]);
  });

  test('POST /api/webhooks documents 201, 400, 401, 503', () => {
    const responses = spec.paths['/api/webhooks'].post.responses;
    expect(responses['201']).toBeDefined();
    expect(responses['400']).toBeDefined();
    expect(responses['401']).toBeDefined();
    expect(responses['503']).toBeDefined();
  });

  test('webhook event enum includes settled and cancelled invoice events', () => {
    const requestEventTypes = spec.paths['/api/webhooks'].post.requestBody.content['application/json']
      .schema.properties.events.items.enum;
    const responseEventTypes = spec.paths['/api/webhooks'].get.responses['200'].content['application/json']
      .schema.properties.data.items.properties.events.items.enum;
    for (const eventTypes of [requestEventTypes, responseEventTypes]) {
      expect(eventTypes).toContain('invoice.settled');
      expect(eventTypes).toContain('invoice.cancelled');
    }
  });

  test('webhook list documents breaker state', () => {
    const properties = spec.paths['/api/webhooks'].get.responses['200'].content['application/json']
      .schema.properties.data.items.properties;
    expect(properties.status.enum).toEqual(['enabled', 'disabled', 'half-open']);
    expect(properties.consecutiveFailures).toBeDefined();
  });

  test('webhook routes are security-gated in spec', () => {
    const post = spec.paths['/api/webhooks'].post;
    expect(post.security).toBeDefined();
    expect(post.security.length).toBeGreaterThan(0);
  });
});
