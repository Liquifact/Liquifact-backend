'use strict';

const {
  toAdminConfigRequestDto,
  fromAdminConfigRequestDto,
  toAdminConfigResponseDto,
  fromAdminConfigResponseDto,
  toConfigSectionsResponseDto,
  fromConfigSectionsResponseDto,
} = require('../../src/dto/config');
const { CONFIG_SECTIONS } = require('../../src/schemas/config');

describe('admin config DTO mapping', () => {
  it('round-trips admin config request payloads through the request DTO layer', () => {
    const payload = {
      section: 'cors',
      config: {
        origins: ['https://app.example.com'],
        maxAge: 600,
      },
    };

    const dto = toAdminConfigRequestDto(payload);
    expect(dto).toEqual(payload);
    expect(fromAdminConfigRequestDto(dto)).toEqual(payload);
  });

  it('preserves missing optional fields when mapping request DTOs', () => {
    const payload = {
      section: 'webhook',
      config: {
        url: 'https://hooks.example.com/receive',
        secret: '0123456789abcdef',
        events: ['invoice.created'],
      },
    };

    const dto = toAdminConfigRequestDto(payload);
    expect(dto.config).toEqual(payload.config);
    expect(dto.config.enabled).toBeUndefined();
    expect(dto.config.maxRetries).toBeUndefined();
    expect(fromAdminConfigRequestDto(dto)).toEqual(payload);
  });

  it('round-trips admin config response payloads through the response DTO layer', () => {
    const payload = {
      section: 'reconciliation',
      config: {
        batchSize: 25,
        enabled: true,
      },
      message: 'Configuration section \'reconciliation\' validated and accepted.',
    };

    const dto = toAdminConfigResponseDto(payload);
    expect(dto).toEqual(payload);
    expect(fromAdminConfigResponseDto(dto)).toEqual(payload);
  });

  it('round-trips config section list payloads through the section DTO layer', () => {
    const payload = { sections: ['webhook', 'cors'] };

    const dto = toConfigSectionsResponseDto(payload.sections);
    expect(dto).toEqual(payload);
    expect(fromConfigSectionsResponseDto(dto)).toEqual(payload);
  });

  it('isolates nested request config state across DTO mappings', () => {
    const payload = {
      section: 'cors',
      config: {
        origins: ['https://app.example.com'],
        nested: { labels: ['primary'] },
      },
    };

    const dto = toAdminConfigRequestDto(payload);
    expect(dto.config).not.toBe(payload.config);
    expect(dto.config.origins).not.toBe(payload.config.origins);
    expect(dto.config.nested.labels).not.toBe(payload.config.nested.labels);

    dto.config.nested.labels.push('dto-only');
    expect(payload.config.nested.labels).toEqual(['primary']);

    const routePayload = fromAdminConfigRequestDto(dto);
    expect(routePayload.config.nested.labels).not.toBe(dto.config.nested.labels);
    routePayload.config.nested.labels.push('route-only');
    expect(dto.config.nested.labels).toEqual(['primary', 'dto-only']);
  });

  it('isolates nested response config state across DTO mappings', () => {
    const payload = {
      section: 'webhook',
      config: { events: ['invoice.created'] },
      message: 'accepted',
    };

    const dto = toAdminConfigResponseDto(payload);
    expect(dto.config.events).not.toBe(payload.config.events);

    dto.config.events.push('dto-only');
    expect(payload.config.events).toEqual(['invoice.created']);

    const responsePayload = fromAdminConfigResponseDto(dto);
    expect(responsePayload.config.events).not.toBe(dto.config.events);
    responsePayload.config.events.push('response-only');
    expect(dto.config.events).toEqual(['invoice.created', 'dto-only']);
  });
});
