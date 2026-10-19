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
 *   415  { error, code: 'UNSUPPORTED_MEDIA_TYPE' }  (when body schema given but Content-Type isn't application/json)
 *
 * @param {{ body?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny }} schemas
 * @returns {import('express').RequestHandler}
 */
function validate({ body: bodySchema, params: paramsSchema, query: querySchema } = {}) {
  return function validationMiddleware(req, res, next) {
    // 415 check — only when we expect a JSON body
    if (bodySchema) {
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('application/json')) {
        return res.status(415).json({
          error: 'Unsupported Media Type: Content-Type must be application/json',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });
      }
    }

    const allErrors = [];

    // Helper: parse one Zod schema and accumulate errors
    function parseSection(schema, value, section) {
      const result = schema.safeParse(value);
      if (!result.success) {
        for (const issue of result.error.issues) {
          const pathParts = issue.path.map(String);
          // Prefix path with section name when there might be ambiguity (body/query/params)
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

    const parsedBody = bodySchema ? parseSection(bodySchema, req.body, 'body') : undefined;
    const parsedParams = paramsSchema ? parseSection(paramsSchema, req.params, 'params') : undefined;
    const parsedQuery = querySchema ? parseSection(querySchema, req.query, 'query') : undefined;

    if (allErrors.length) {
      // details: legacy flat string array for backward-compat
      const details = allErrors.map((e) => e.message);
      return res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_FAILED',
        details,
        errors: allErrors,
      });
    }

    // Attach parsed (coerced / stripped) values back to req
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
