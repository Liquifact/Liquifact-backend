'use strict';

/**
 * Validation middleware factory.
 *
 * Usage:
 *   router.post('/', validate({ body: CreateInvoiceBody }), handler)
 *   router.get('/:id', validate({ params: InvoiceIdParam }), handler)
 *
 * On failure returns:
 *   400  { error, code: 'VALIDATION_FAILED', details: string[], errors: [{path, message, code}] }
 *   415  { error, code: 'UNSUPPORTED_MEDIA_TYPE' }  (when a body schema is given but Content-Type isn't application/json)
 *
 * When `audit` names an action and the request carries `req.audit` (see
 * audit/middleware.js), every rejected request is recorded in the audit log.
 *
 * @param {{ body?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, audit?: string }} schemas
 * @returns {import('express').RequestHandler} middleware
 */
function validate({ body: bodySchema, params: paramsSchema, query: querySchema, audit } = {}) {
  return function validationMiddleware(req, res, next) {
    const reject = (statusCode, payload) => {
      if (audit && typeof req.audit === 'function') {
        req.audit({
          action: audit,
          resourceType: 'invoice',
          resourceId: req.params && typeof req.params.id === 'string' ? req.params.id.slice(0, 64) : null,
          outcome: 'rejected',
          statusCode,
          metadata: payload.details ? { errors: payload.details } : { error: payload.error, code: payload.code },
        });
      }
      return res.status(statusCode).json(payload);
    };

    // 415 check — only when we expect a JSON body
    if (bodySchema) {
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('application/json')) {
        return reject(415, {
          error: 'Unsupported Media Type: Content-Type must be application/json',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });
      }
    }

    const allErrors = [];

    /**
     * Parses one section and accumulates its issues.
     *
     * @param {import('zod').ZodTypeAny} schema schema for the section
     * @param {unknown} value raw section value
     * @param {string} section section name used when an issue has no path
     * @returns {unknown} parsed value, or null when invalid
     */
    function parseSection(schema, value, section) {
      const result = schema.safeParse(value);
      if (!result.success) {
        for (const issue of result.error.issues) {
          const pathParts = issue.path.map(String);
          allErrors.push({
            path: pathParts.length ? pathParts.join('.') : section,
            message: issue.message,
            code: issue.code,
          });
        }
        return null;
      }
      return result.data;
    }

    const parsedParams = paramsSchema ? parseSection(paramsSchema, req.params, 'params') : undefined;
    const parsedQuery = querySchema ? parseSection(querySchema, req.query, 'query') : undefined;
    const parsedBody = bodySchema ? parseSection(bodySchema, req.body, 'body') : undefined;

    if (allErrors.length) {
      // details: legacy flat string array for backward compatibility
      const details = [...new Set(allErrors.map((e) => e.message))];
      return reject(400, {
        error: 'Validation failed',
        code: 'VALIDATION_FAILED',
        details,
        errors: allErrors,
      });
    }

    if (parsedBody !== undefined) {
      req.validatedBody = parsedBody;
    }
    if (parsedParams !== undefined) {
      req.validatedParams = parsedParams;
    }
    if (parsedQuery !== undefined) {
      req.validatedQuery = parsedQuery;
    }

    return next();
  };
}

module.exports = { validate };
