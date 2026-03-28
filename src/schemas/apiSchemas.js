const { z } = require('zod');

/**
 * Base Invoice Schema
 */
const InvoiceSchema = z.object({
    id: z.string(),
    amount: z.number().positive(),
    customer: z.string().min(1),
    status: z.string(),
    createdAt: z.string(),
    deletedAt: z.string().nullable(),
});

/**
 * Request Schemas
 */
const CreateInvoiceRequestSchema = z.object({
    amount: z.number().positive(),
    customer: z.string().min(1),
});

/**
 * Response Schemas
 */
const CreateInvoiceResponseSchema = z.object({
    data: InvoiceSchema,
    message: z.string(),
});

const InvoiceListResponseSchema = z.object({
    data: z.array(InvoiceSchema),
    message: z.string()
});

const DeleteRestoreInvoiceResponseSchema = z.object({
    data: InvoiceSchema,
    message: z.string()
});

module.exports = {
    InvoiceSchema,
    CreateInvoiceRequestSchema,
    CreateInvoiceResponseSchema,
    InvoiceListResponseSchema,
    DeleteRestoreInvoiceResponseSchema
};
