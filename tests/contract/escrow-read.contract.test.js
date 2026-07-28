const request = require('supertest');
const { z } = require('zod');
const app = require('../../src/app');

const escrowReadResponseSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional()
}).strict();

const escrowListResponseSchema = z.object({
  data: z.array(escrowReadResponseSchema),
  nextCursor: z.string().nullable().optional(),
  hasNextPage: z.boolean().optional()
}).strict();

const errorResponseSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  fieldErrors: z.record(z.string()).optional()
}).strict();

describe('Contract Tests: Escrow Read Responses', () => {
  
  describe('Success Shapes', () => {
    it('should strictly match the documented schema for a single escrow read', async () => {
      // Ensure this endpoint returns a valid 200 response in the test DB
      const response = await request(app)
        .get('/v1/escrow/test-valid-id') 
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);

      const result = escrowReadResponseSchema.safeParse(response.body);
      
      if (!result.success) {
        console.error('Contract Violation (Single Read):', result.error.format());
      }
      expect(result.success).toBe(true);
    });

    it('should strictly match the documented schema for cursor pagination', async () => {
      const response = await request(app)
        .get('/v1/escrow?cursor=next-page')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);

      const result = escrowListResponseSchema.safeParse(response.body);
      
      if (!result.success) {
        console.error('Contract Violation (List/Pagination):', result.error.format());
      }
      expect(result.success).toBe(true);
    });
  });

  describe('Error Shapes', () => {
    it('should strictly match the documented error schema for a 404 Not Found', async () => {
      const response = await request(app)
        .get('/v1/escrow/non-existent-id')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);

      const result = errorResponseSchema.safeParse(response.body);
      
      if (!result.success) {
        console.error('Contract Violation (Error Shape):', result.error.format());
      }
      expect(result.success).toBe(true);
    });
  });
});