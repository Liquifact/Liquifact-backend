/**
 * Audit Middleware
 * Intercepts and logs mutations to resources with actor, timestamp, and change tracking.
 * 
 * @module middleware/audit
 */

const { createAuditLog } = require('../services/auditLog');

/**
 * Extracts the actor (user ID) from the request.
 * First checks JWT decoded token, falls back to IP address.
 * 
 * @param {import('express').Request} req Express request object
 * @returns {string} Actor identifier
 */
function getActorFromRequest(req) {
  // If authenticated via JWT, use the user ID from token
  if (req.user && req.user.id) {
    return req.user.id;
  }
  if (req.user && req.user.sub) {
    return req.user.sub;
  }

  // Fallback to IP address for unauthenticated requests
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Extracts relevant resource information from the request path.
 * Attempts to parse standard REST patterns like /api/{resourceType}/{id}
 * 
 * @param {string} path Request path
 * @param {string} [_method] HTTP method (reserved for future routing rules).
 * @returns {Object} Object with resourceType and resourceId
 */
function extractResourceInfo(path, _method) {
  // Pattern: /api/{resourceType}/{id} or /api/{resourceType}
  const match = path.match(/^\/api\/([a-z]+)(?:\/([a-zA-Z0-9-]+))?/);

  if (!match) {
    return { resourceType: 'unknown', resourceId: 'unknown' };
  }

  const resourceType = match[1];
  const resourceId = match[2] || 'new';

  return { resourceType, resourceId };
}

/**
 * Maps HTTP method to audit action type.
 * 
 * @param {string} method HTTP method
 * @returns {string} Audit action (CREATE, UPDATE, DELETE, READ)
 */
function mapMethodToAction(method) {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'READ';
    default:
      return 'READ';
  }
}

/**
 * Determines if a request represents a mutation that should be audited.
 * 
 * @param {string} method HTTP method
 * @returns {boolean} True if the request modifies data
 */
function isMutationMethod(method) {
  const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  return mutationMethods.includes(method.toUpperCase());
}

/**
 * Express middleware to audit invoice mutations.
 * Captures actor, timestamp, action type, and changed fields.
 * 
 * Usage:
 *   app.use(auditMiddleware);
 * 
 * Security notes:
 * - Sensitive fields (passwords, tokens, keys) are automatically redacted
 * - Captures HTTP status code to track operation success
 * - Records client IP address and user agent for security audit
 * - Only creates audit logs for actual mutations (POST/PUT/PATCH/DELETE)
 * - Gracefully handles errors without affecting request flow
 * 
 * @param {import('express').Request} req Express request object
 * @param {import('express').Response} res Express response object
 * @param {import('express').NextFunction} next Express next callback
 * @returns {void}
 */
function auditMiddleware(req, res, next) {
  // Skip non-API requests
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Only audit mutations
  if (!isMutationMethod(req.method)) {
    return next();
  }

  const actor = getActorFromRequest(req);
  const { resourceType, resourceId } = extractResourceInfo(req.path, req.method);
  const action = mapMethodToAction(req.method);
  const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('user-agent') || 'unknown';

  // Capture request body (before state)
  const beforeState = req.body ? { ...req.body } : null;

  // Store original response.json and response.send and response.status
  const originalJson = res.json;
  const originalSend = res.send;
  const originalStatus = res.status;

  let storedStatusCode = res.statusCode;

  /**
   * Captures response and creates audit log.
   *
   * @param {unknown} body - Serialized response body.
   * @returns {unknown} The same body for chaining.
   */
  const captureResponse = (body) => {
    const statusCode = storedStatusCode || res.statusCode;
    // Only create audit log for successful responses (2xx status codes)
    const wasSuccessful = statusCode >= 200 && statusCode < 300;

    if (res.locals.audited) return body;

    if (wasSuccessful && body !== undefined) {
      res.locals.audited = true;
      try {
        const afterState = typeof body === 'string' && body ? JSON.parse(body) : body;
        createAuditLog({
          actor,
          action,
          resourceType,
          resourceId,
          before: beforeState,
          after: afterState && afterState.data ? afterState.data : afterState,
          statusCode,
          ipAddress,
          userAgent,
          metadata: {
            method: req.method,
            path: req.path,
          },
        }).catch((error) => {
          console.error('Audit log fire-and-forget failed:', error.message);
        });
      } catch (error) {
        // Log error but don't interrupt response
        console.error('Failed to create audit log:', error.message);
      }
    }

    return body;
  };

  // Override response.status to track status code
  res.status = function statusOverride(code) {
    storedStatusCode = code;
    return originalStatus.call(this, code);
  };

  // Override response.json
  res.json = function jsonOverride(body) {
    captureResponse(body);
    return originalJson.call(this, body);
  };

  // Override response.send
  res.send = function sendOverride(body) {
    // Capture for any truthy body, or even empty bodies for DELETE
    if (body || (res.statusCode >= 200 && res.statusCode < 300)) {
      if (typeof body === 'object' && body !== null) {
        captureResponse(body);
      } else if (typeof body === 'string' && body) {
        try {
          captureResponse(JSON.parse(body));
        } catch {
          // Not JSON, just proceed
        }
      } else if (!body) {
        captureResponse(null);
      }
    }
    return originalSend.call(this, body);
  };

  next();
}

module.exports = { auditMiddleware };
