/**
 * Request and Response Boundary Validation Middleware
 * Uses Zod to validate input payload structures and intercept outbound responses 
 * to ensure they match expected API contracts.
 */

const { ZodError } = require('zod');

/**
 * Validates request payload against a Zod schema.
 * @param {import('zod').ZodSchema} schema The schema to validate against
 * @param {'body'|'query'|'params'} source The request property to validate
 * @returns {import('express').RequestHandler}
 */
const validateRequest = (schema, source = 'body') => {
    return (req, res, next) => {
        try {
            req[source] = schema.parse(req[source]);
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                return res.status(400).json({ error: 'Invalid request data', details: error.issues });
            }
            next(error);
        }
    };
};

/**
 * Intercepts res.json to validate response payload against a Zod schema.
 * Prevents schema drift and data leaks on outbound responses.
 * @param {import('zod').ZodSchema} schema The schema to validate against
 * @returns {import('express').RequestHandler}
 */
const validateResponse = (schema) => {
    return (req, res, next) => {
        const originalJson = res.json;
        res.json = function (body) {
            // If an error occurred and we are sending an error payload, bypass validation
            // assuming error payloads have a consistent { error: string } structure everywhere anyway.
            if (this.statusCode >= 400 && body && body.error) {
                return originalJson.call(this, body);
            }

            try {
                const validatedBody = schema.parse(body);
                return originalJson.call(this, validatedBody);
            } catch (error) {
                if (error instanceof ZodError) {
                    console.error('Response validation failed:', error.issues);
                    return originalJson.call(this.status(500), { error: 'Internal server error: Response validation failed' });
                }
                // In rare cases where another error happens, just throw
                return originalJson.call(this.status(500), { error: 'Internal server error' });
            }
        };
        next();
    };
};

module.exports = { validateRequest, validateResponse };
