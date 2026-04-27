const { z } = require('zod');

const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD',
  'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'KRW', 'ZAR', 'NGN',
  'GHS', 'KES', 'TZS', 'UGX', 'XOF', 'XAF', 'MAD', 'EGP', 'AED', 'SAR',
];

const VALID_STATUSES = ['paid', 'pending', 'overdue'];
const VALID_SORT_FIELDS = ['amount', 'date', 'createdAt'];

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'Date must be in YYYY-MM-DD format',
}).refine((val) => !isNaN(Date.parse(val)), {
  message: 'Date must be a valid date',
});

const currencySchema = z.string()
  .length(3, { message: 'Currency must be a 3-letter ISO 4217 code' })
  .refine(
    (val) => SUPPORTED_CURRENCIES.includes(val.toUpperCase()),
    { message: `Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}` }
  );

const invoiceCreateSchema = z.object({
  amount: z.number()
    .positive({ message: 'Amount must be a positive number' })
    .finite({ message: 'Amount must be a finite number' }),
  dueDate: dateSchema.optional(),
  buyer: z.string()
    .min(1, { message: 'Buyer is required' })
    .max(255, { message: 'Buyer name must not exceed 255 characters' })
    .trim()
    .optional(),
  customer: z.string()
    .min(1)
    .max(255)
    .trim()
    .optional(),
  seller: z.string()
    .min(1, { message: 'Seller is required' })
    .max(255, { message: 'Seller name must not exceed 255 characters' })
    .trim()
    .optional(),
  currency: currencySchema.optional(),
  description: z.string()
    .max(1000, { message: 'Description must not exceed 1000 characters' })
    .optional(),
  invoiceNumber: z.string()
    .max(100, { message: 'Invoice number must not exceed 100 characters' })
    .optional(),
}).superRefine((data, ctx) => {
  // Require either buyer or customer
  if (!data.buyer && !data.customer) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Buyer is required', path: ['buyer'] });
  }
  // If buyer is explicitly provided as empty string, flag it
  if (data.buyer !== undefined && data.buyer.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Buyer is required', path: ['buyer'] });
  }
  if (data.seller !== undefined && data.seller.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Seller is required', path: ['seller'] });
  }
});

const paginationQuerySchema = z.object({
  page: z.coerce.number()
    .int({ message: 'Page must be an integer' })
    .positive({ message: 'Page must be a positive number' })
    .default(1),
  limit: z.coerce.number()
    .int({ message: 'Limit must be an integer' })
    .min(1, { message: 'Limit must be at least 1' })
    .max(100, { message: 'Limit must not exceed 100' })
    .default(20),
  status: z.enum(VALID_STATUSES, {
    errorMap: () => ({ message: `Status must be one of: ${VALID_STATUSES.join(', ')}` }),
  }).optional(),
  smeId: z.string()
    .min(1, { message: 'SME ID is required' })
    .max(100, { message: 'SME ID must not exceed 100 characters' })
    .optional(),
  buyerId: z.string()
    .min(1, { message: 'Buyer ID is required' })
    .max(100, { message: 'Buyer ID must not exceed 100 characters' })
    .optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  sortBy: z.enum(VALID_SORT_FIELDS, {
    errorMap: () => ({ message: `SortBy must be one of: ${VALID_SORT_FIELDS.join(', ')}` }),
  }).optional(),
  order: z.enum(['asc', 'desc'], {
    errorMap: () => ({ message: 'Order must be either "asc" or "desc"' }),
  }).optional(),
});

function parseValidationErrors(zodError) {
  const fieldErrors = {};
  
  const issues = zodError.errors ?? zodError.issues ?? [];
  
  for (const issue of issues) {
    const path = issue.path?.join('.') ?? '';
    if (!fieldErrors[path]) {
      fieldErrors[path] = issue.message;
    }
  }
  
  return fieldErrors;
}

function validateBody(schema) {
  return (req, res, next) => {
    try {
      req.validated = schema.parse(req.body);
      next();
    } catch (error) {
      if (error.name === 'ZodError') {
        const fieldErrors = parseValidationErrors(error);
        return res.status(400).json({
          error: 'Validation Failed',
          message: 'Request body contains invalid or missing fields',
          fieldErrors,
        });
      }
      next(error);
    }
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    try {
      req.validatedQuery = schema.parse(req.query);
      next();
    } catch (error) {
      if (error.name === 'ZodError') {
        const fieldErrors = parseValidationErrors(error);
        return res.status(400).json({
          error: 'Validation Failed',
          message: 'Query parameters contain invalid values',
          fieldErrors,
        });
      }
      next(error);
    }
  };
}

module.exports = {
  invoiceCreateSchema,
  paginationQuerySchema,
  validateBody,
  validateQuery,
  parseValidationErrors,
  SUPPORTED_CURRENCIES,
  VALID_STATUSES,
  VALID_SORT_FIELDS,
};
