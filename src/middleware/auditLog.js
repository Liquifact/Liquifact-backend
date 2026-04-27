'use strict';

const { appendAuditEvent, redactValue } = require('../services/auditLogStore');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getActor(req) {
  if (req.user && typeof req.user === 'object') {
    if (req.user.id) {
      return { actorType: 'user', actorId: String(req.user.id) };
    }
    if (req.user.sub) {
      return { actorType: 'user', actorId: String(req.user.sub) };
    }
  }

  if (req.apiClient && req.apiClient.clientId) {
    return { actorType: 'api_client', actorId: String(req.apiClient.clientId) };
  }

  return { actorType: 'system', actorId: req.ip || 'unknown' };
}

function isAdminAction(req) {
  return req.path.startsWith('/api/admin/');
}

function buildBaseEvent(req) {
  const actor = getActor(req);
  return {
    ...actor,
    requestId: req.id || req.headers['x-correlation-id'],
    route: req.originalUrl || req.path,
    method: req.method,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  };
}

function createAuditContext(req) {
  const baseEvent = buildBaseEvent(req);

  return {
    async logAdminAction(action, options = {}) {
      await appendAuditEvent({
        ...baseEvent,
        eventType: 'admin_action',
        action,
        targetType: options.targetType || null,
        targetId: options.targetId || null,
        statusCode: options.statusCode,
        metadata: {
          before: redactValue(options.before || null),
          after: redactValue(options.after || null),
          ...options.metadata,
        },
      });
    },
    async logWebhookDelivery(options = {}) {
      await appendAuditEvent({
        ...baseEvent,
        eventType: 'webhook_delivery',
        action: options.action || 'webhook.dispatch',
        targetType: 'webhook_endpoint',
        targetId: options.endpointId || options.endpoint || null,
        statusCode: options.statusCode,
        metadata: redactValue({
          endpoint: options.endpoint,
          deliveryId: options.deliveryId,
          outcome: options.outcome,
          requestPayload: options.requestPayload,
          responseBody: options.responseBody,
          errorCode: options.errorCode,
          errorMessage: options.errorMessage,
          ...options.metadata,
        }),
      });
    },
  };
}

function auditLogMiddleware(req, res, next) {
  req.audit = createAuditContext(req);

  if (!MUTATION_METHODS.has(req.method.toUpperCase()) || !isAdminAction(req)) {
    return next();
  }

  const action = req.headers['x-admin-action'] || `${req.method.toLowerCase()}.admin`;
  const targetType = req.headers['x-audit-target-type'] || 'admin_resource';
  const targetId = req.headers['x-audit-target-id'] || req.params.id || null;
  const beforeSnapshot = req.body ? redactValue(req.body) : null;

  res.on('finish', () => {
    const statusCode = res.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      return;
    }

    req.audit
      .logAdminAction(action, {
        targetType,
        targetId,
        statusCode,
        before: beforeSnapshot,
        metadata: {
          source: 'http',
          autoLogged: true,
        },
      })
      .catch((error) => {
        req.log?.warn?.({ err: error }, 'failed to persist admin audit event');
      });
  });

  return next();
}

module.exports = {
  auditLogMiddleware,
};
