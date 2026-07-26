'use strict';

/**
 * @fileoverview Tests for persistence write input validation.
 *
 * Covers:
 *  - Unit: `presignedUploadBodySchema` / `directUploadBodySchema` edge cases
 *  - HTTP: structured 400 on POST /api/sme/invoice/presigned-url and POST /api/sme/invoice
 *
 * Edge cases required by #683: missing field, wrong type, oversized string,
 * boundary numbers, unknown fields.
 */

const request = require('supertest');
const { createApp } = require('../src/index');
const storageService = require('../src/services/storage');
const {
  presignedUploadBodySchema,
  directUploadBodySchema,
  MAX_FILE_NAME_LENGTH,
  MAX_INVOICE_ID_LENGTH,
  MAX_FILE_SIZE_BYTES,
  PERSISTENCE_VALIDATION_CODE,
  PERSISTENCE_PROBLEM_TYPE,
  ALLOWED_MIME_TYPES,
} = require('../src/schemas/persistence');

jest.mock('../src/services/storage', () => {
  const actual = jest.requireActual('../src/services/storage');
  return {
    ...actual,
    uploadFile: jest.fn(),
    getSignedUrl: jest.fn(),
    getPresignedUploadUrl: jest.fn(),
  };
});

const app = createApp();

const VALID_PDF = 'application/pdf';

function validPresignedBody(overrides = {}) {
  return {
    fileName: 'invoice.pdf',
    mimeType: VALID_PDF,
    fileSize: 50_000,
    ...overrides,
  };
}

function expectValidationProblem(res) {
  expect(res.status).toBe(400);
  expect(res.body.type).toBe(PERSISTENCE_PROBLEM_TYPE);
  expect(res.body.title).toBe('Invalid persistence request body');
  expect(res.body.status).toBe(400);
  expect(res.body.code).toBe(PERSISTENCE_VALIDATION_CODE);
  expect(res.body.fieldErrors).toEqual(expect.any(Object));
}

// ── Schema unit tests ────────────────────────────────────────────────────────

describe('presignedUploadBodySchema', () => {
  describe('valid payloads', () => {
    it('accepts a minimal valid body', () => {
      const result = presignedUploadBodySchema.safeParse(validPresignedBody());
      expect(result.success).toBe(true);
      expect(result.data.fileName).toBe('invoice.pdf');
      expect(result.data.fileSize).toBe(50_000);
    });

    it('accepts optional invoiceId', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ invoiceId: 'inv-42' })
      );
      expect(result.success).toBe(true);
      expect(result.data.invoiceId).toBe('inv-42');
    });

    it('accepts every allowlisted mimeType', () => {
      for (const mimeType of ALLOWED_MIME_TYPES) {
        const result = presignedUploadBodySchema.safeParse(
          validPresignedBody({ mimeType })
        );
        expect(result.success).toBe(true);
      }
    });

    it('accepts fileSize at lower boundary (1)', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: 1 })
      );
      expect(result.success).toBe(true);
    });

    it('accepts fileSize at upper boundary (MAX_FILE_SIZE_BYTES)', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: MAX_FILE_SIZE_BYTES })
      );
      expect(result.success).toBe(true);
    });

    it('accepts fileName at max length', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: `${'a'.repeat(MAX_FILE_NAME_LENGTH - 4)}.pdf` })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('missing fields', () => {
    it('rejects missing fileName', () => {
      const { fileName: _omit, ...body } = validPresignedBody();
      const result = presignedUploadBodySchema.safeParse(body);
      expect(result.success).toBe(false);
    });

    it('rejects missing mimeType', () => {
      const { mimeType: _omit, ...body } = validPresignedBody();
      const result = presignedUploadBodySchema.safeParse(body);
      expect(result.success).toBe(false);
    });

    it('rejects missing fileSize', () => {
      const { fileSize: _omit, ...body } = validPresignedBody();
      const result = presignedUploadBodySchema.safeParse(body);
      expect(result.success).toBe(false);
    });

    it('rejects empty object', () => {
      const result = presignedUploadBodySchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('wrong types', () => {
    it('rejects fileName as number', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: 123 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects mimeType as number', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ mimeType: 1 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects fileSize as string', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: '50000' })
      );
      expect(result.success).toBe(false);
    });

    it('rejects fileSize as boolean', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: true })
      );
      expect(result.success).toBe(false);
    });

    it('rejects invoiceId as number', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ invoiceId: 99 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects null body fields', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: null })
      );
      expect(result.success).toBe(false);
    });
  });

  describe('oversized strings and out-of-range numbers', () => {
    it('rejects oversized fileName', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: `${'a'.repeat(MAX_FILE_NAME_LENGTH + 1)}.pdf` })
      );
      expect(result.success).toBe(false);
    });

    it('rejects empty fileName', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: '' })
      );
      expect(result.success).toBe(false);
    });

    it('rejects path traversal in fileName', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: '../etc/passwd.pdf' })
      );
      expect(result.success).toBe(false);
    });

    it('rejects slash in fileName', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileName: 'dir/invoice.pdf' })
      );
      expect(result.success).toBe(false);
    });

    it('rejects fileSize of 0', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: 0 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects negative fileSize', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: -1 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects non-integer fileSize', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: 1.5 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects fileSize just above max', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ fileSize: MAX_FILE_SIZE_BYTES + 1 })
      );
      expect(result.success).toBe(false);
    });

    it('rejects disallowed mimeType', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ mimeType: 'text/html' })
      );
      expect(result.success).toBe(false);
    });

    it('rejects oversized invoiceId', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ invoiceId: 'a'.repeat(MAX_INVOICE_ID_LENGTH + 1) })
      );
      expect(result.success).toBe(false);
    });

    it('rejects invoiceId with path characters', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ invoiceId: '../../admin' })
      );
      expect(result.success).toBe(false);
    });
  });

  describe('unknown fields', () => {
    it('rejects an unknown top-level key', () => {
      const result = presignedUploadBodySchema.safeParse(
        validPresignedBody({ extra: 'nope' })
      );
      expect(result.success).toBe(false);
    });

    it('rejects constructor / prototype-pollution keys', () => {
      const body = Object.assign(Object.create(null), validPresignedBody(), {
        constructor: { name: 'evil' },
      });
      const result = presignedUploadBodySchema.safeParse(body);
      expect(result.success).toBe(false);
    });
  });
});

describe('directUploadBodySchema', () => {
  it('accepts empty object (invoiceId optional)', () => {
    expect(directUploadBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts valid invoiceId', () => {
    const result = directUploadBodySchema.safeParse({ invoiceId: 'inv-1' });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields', () => {
    const result = directUploadBodySchema.safeParse({ foo: 'bar' });
    expect(result.success).toBe(false);
  });

  it('rejects wrong-type invoiceId', () => {
    const result = directUploadBodySchema.safeParse({ invoiceId: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects oversized invoiceId', () => {
    const result = directUploadBodySchema.safeParse({
      invoiceId: 'x'.repeat(MAX_INVOICE_ID_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});

// ── HTTP integration tests ───────────────────────────────────────────────────

describe('POST /api/sme/invoice/presigned-url validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storageService.getPresignedUploadUrl.mockResolvedValue({
      url: 'https://s3.example.com/upload',
      key: 'tenants/t/invoices/i/file.pdf',
    });
  });

  it('returns 200 for a valid body', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_valid-body-001')
      .send(validPresignedBody({ invoiceId: 'custom-1' }));

    expect(res.status).toBe(200);
    expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'invoice.pdf',
        mimeType: VALID_PDF,
        fileSize: 50_000,
        invoiceId: 'custom-1',
      })
    );
  });

  it('returns structured 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_missing-fields-001')
      .send({ fileName: 'test.pdf' });

    expectValidationProblem(res);
    expect(res.body.fieldErrors.mimeType || res.body.fieldErrors.fileSize).toBeDefined();
    expect(storageService.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns structured 400 for wrong type (fileSize string)', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_wrong-type-001')
      .send(validPresignedBody({ fileSize: '50000' }));

    expectValidationProblem(res);
    expect(res.body.fieldErrors.fileSize).toBeDefined();
    expect(storageService.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns structured 400 for oversized fileName', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_oversized-name-001')
      .send(validPresignedBody({ fileName: `${'a'.repeat(MAX_FILE_NAME_LENGTH + 1)}.pdf` }));

    expectValidationProblem(res);
    expect(res.body.fieldErrors.fileName).toMatch(/exceed/);
    expect(storageService.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns structured 400 for fileSize above max', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_oversized-size-001')
      .send(validPresignedBody({ fileSize: MAX_FILE_SIZE_BYTES + 1 }));

    expectValidationProblem(res);
    expect(res.body.fieldErrors.fileSize).toBeDefined();
    expect(storageService.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns structured 400 for fileSize at zero boundary', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_zero-size-001')
      .send(validPresignedBody({ fileSize: 0 }));

    expectValidationProblem(res);
    expect(res.body.fieldErrors.fileSize).toBeDefined();
  });

  it('accepts fileSize at max boundary without calling with invalid size', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_max-boundary-001')
      .send(validPresignedBody({ fileSize: MAX_FILE_SIZE_BYTES }));

    expect(res.status).toBe(200);
    expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ fileSize: MAX_FILE_SIZE_BYTES })
    );
  });

  it('returns structured 400 for unknown fields', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_unknown-field-001')
      .send(validPresignedBody({ unexpected: true }));

    expectValidationProblem(res);
    expect(storageService.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns structured 400 for disallowed mimeType', async () => {
    const res = await request(app)
      .post('/api/sme/invoice/presigned-url')
      .set('X-Tenant-Id', 'test-tenant')
      .set('Idempotency-Key', 'ik_bad-mime-001')
      .send(validPresignedBody({ mimeType: 'text/html' }));

    expectValidationProblem(res);
    expect(res.body.fieldErrors.mimeType).toBeDefined();
    expect(storageService.getPresignedUploadUrl).not.toHaveBeenCalled();
  });
});

describe('POST /api/sme/invoice validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storageService.uploadFile.mockResolvedValue('tenants/t/invoices/i/file.pdf');
    storageService.getSignedUrl.mockResolvedValue('https://signed.example.com/x');
  });

  it('returns 200 for a valid multipart upload', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('X-Tenant-Id', 'test-tenant')
      .attach('invoice', Buffer.from('%PDF-1.4'), 'test.pdf')
      .field('invoiceId', 'test-inv');

    expect(res.status).toBe(200);
  });

  it('returns structured 400 for unknown form fields', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('X-Tenant-Id', 'test-tenant')
      .attach('invoice', Buffer.from('%PDF-1.4'), 'test.pdf')
      .field('invoiceId', 'test-inv')
      .field('extraField', 'nope');

    expectValidationProblem(res);
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('returns structured 400 for oversized invoiceId', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('X-Tenant-Id', 'test-tenant')
      .attach('invoice', Buffer.from('%PDF-1.4'), 'test.pdf')
      .field('invoiceId', 'x'.repeat(MAX_INVOICE_ID_LENGTH + 1));

    expectValidationProblem(res);
    expect(res.body.fieldErrors.invoiceId).toBeDefined();
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('returns structured 400 for invalid invoiceId characters', async () => {
    const res = await request(app)
      .post('/api/sme/invoice')
      .set('X-Tenant-Id', 'test-tenant')
      .attach('invoice', Buffer.from('%PDF-1.4'), 'test.pdf')
      .field('invoiceId', '../../evil');

    expectValidationProblem(res);
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });
});
