const { validateRequest, validateResponse } = require('../middleware/validate');
const { z, ZodError } = require('zod');

describe('Validation Middleware', () => {
    describe('validateRequest', () => {
        const schema = z.object({
            name: z.string().min(2),
            age: z.number().min(18)
        });

        it('should call next() successfully if request matches schema', () => {
            const middleware = validateRequest(schema, 'body');
            const req = { body: { name: 'Alice', age: 25 } };
            const res = {};
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(next).toHaveBeenCalledWith();
        });

        it('should strip unknown fields if schema dictates (default zod behavior)', () => {
            const middleware = validateRequest(schema, 'body');
            const req = { body: { name: 'Alice', age: 25, extra: 'should be stripped' } };
            const res = {};
            const next = jest.fn();

            middleware(req, res, next);

            expect(req.body).not.toHaveProperty('extra');
            expect(next).toHaveBeenCalled();
        });

        it('should return 400 with details if data is invalid', () => {
            const middleware = validateRequest(schema, 'body');
            const req = { body: { name: 'A', age: 17 } };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };
            const next = jest.fn();

            middleware(req, res, next);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                error: 'Invalid request data',
                details: expect.any(Array)
            }));
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('validateResponse', () => {
        const schema = z.object({
            msg: z.string(),
            val: z.number()
        });

        it('should proxy res.json to send a valid response', () => {
            const middleware = validateResponse(schema);
            const req = {};
            const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);

            expect(() => res.json({ msg: 'success', val: 100 })).not.toThrow();
        });

        it('should return 500 if outbound response does not match schema', () => {
            const middleware = validateResponse(schema);
            const req = {};
            const originalJson = jest.fn();
            const res = { statusCode: 200, status: jest.fn().mockReturnThis(), json: originalJson };
            const next = jest.fn();

            middleware(req, res, next);

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

            res.json({ msg: 'success', val: 'not a number' });

            expect(res.status).toHaveBeenCalledWith(500);
            expect(originalJson).toHaveBeenCalledWith({ error: 'Internal server error: Response validation failed' });

            consoleSpy.mockRestore();
        });

        it('should bypass validation for explicit error responses', () => {
            const middleware = validateResponse(schema);
            const req = {};
            const originalJson = jest.fn();
            const res = { statusCode: 404, status: jest.fn().mockReturnThis(), json: originalJson };
            const next = jest.fn();

            middleware(req, res, next);

            res.json({ error: 'Not Found' });

            // Even though { error: 'Not Found' } does not match 'schema', it was bypassed 
            // because status >= 400 and it contains 'error' field
            expect(originalJson).toHaveBeenCalledWith({ error: 'Not Found' });
        });
    });
});
