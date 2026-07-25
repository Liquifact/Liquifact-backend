const request = require('supertest');
const crypto = require('crypto');
const createApp = require('../src/index').createApp;
const storageService = require('../src/services/storage');

jest.mock('../src/services/storage');

const app = createApp();

const VALID_PDF_MIME = 'application/pdf';
const VALID_JPEG_MIME = 'image/jpeg';
const BLOCKED_MIME_TYPES = [
  'text/html',
  'application/xml',
  'application/json',
  'image/gif',
  'application/octet-stream',
  'text/plain',
  'application/javascript',
];

describe('SME Invoice Upload - Security Hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Direct Upload (POST /api/sme/invoice)', () => {
    it('should upload PDF invoice successfully with tenant ID', async () => {
      const mockKey = 'tenants/test-tenant/invoices/test-inv/uuid-test.pdf';
      const mockSignedUrl = 'https://signed-url.example.com/test';

      storageService.uploadFile.mockResolvedValue(mockKey);
      storageService.getSignedUrl.mockResolvedValue(mockSignedUrl);

      const response = await request(app)
        .post('/api/sme/invoice')
        .set('X-Tenant-Id', 'test-tenant')
        .attach('invoice', Buffer.from('fake pdf content'), 'test.pdf')
        .field('invoiceId', 'test-inv');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        message: 'Invoice uploaded successfully',
        fileKey: mockKey,
        signedUrl: mockSignedUrl,
        invoiceId: 'test-inv',
      });
      expect(storageService.uploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        'test.pdf',
        VALID_PDF_MIME,
        'test-tenant',
        'test-inv',
      );
    });

    it('should return 400 if no tenant is provided', async () => {
      const response = await request(app)
        .post('/api/sme/invoice')
        .attach('invoice', Buffer.from('fake pdf content'), 'test.pdf')
        .field('invoiceId', 'test-inv');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Missing tenant context.');
    });

    it('should return 400 if no file provided', async () => {
      const response = await request(app)
        .post('/api/sme/invoice')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Content-Type', 'multipart/form-data');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invoice file is required');
    });

    it('should reject upload when storage service rejects INVALID_MIME_TYPE', async () => {
      const error = new Error('Invalid MIME type: "text/plain". Allowed: application/pdf, image/jpeg, image/png, image/tiff');
      error.code = 'INVALID_MIME_TYPE';
      storageService.uploadFile.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/sme/invoice')
        .set('X-Tenant-Id', 'test-tenant')
        .attach('invoice', Buffer.from('bad content'), 'test.txt');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid MIME type');
    });

    it('should reject upload when storage service rejects FILE_TOO_LARGE', async () => {
      const error = new Error('File size exceeds maximum');
      error.code = 'FILE_TOO_LARGE';
      storageService.uploadFile.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/sme/invoice')
        .set('X-Tenant-Id', 'test-tenant')
        .attach('invoice', Buffer.from('content'), 'test.pdf');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('File size exceeds maximum');
    });
  });

  describe('Presigned Upload URL (POST /api/sme/invoice/presigned-url)', () => {
    it('should generate presigned upload URL for valid request with tenant and idempotency key', async () => {
      const mockResult = {
        url: 'https://s3-presigned.example.com/upload',
        key: 'tenants/test-tenant/invoices/inv-abc/uuid-file.pdf',
      };
      storageService.getPresignedUploadUrl.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', 'ik_test-key-123')
        .send({
          fileName: 'invoice.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 50000,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        message: 'Presigned upload URL generated',
        uploadUrl: mockResult.url,
        fileKey: mockResult.key,
      });
      expect(response.body.invoiceId).toBeDefined();
      expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        invoiceId: expect.any(String),
        fileName: 'invoice.pdf',
        mimeType: VALID_PDF_MIME,
        fileSize: 50000,
      });
    });

    it('should return the same invoiceId on idempotent retry with same key and body', async () => {
      const mockResult = {
        url: 'https://s3-presigned.example.com/upload',
        key: 'tenants/test-tenant/invoices/custom-inv-42/uuid-file.pdf',
      };
      storageService.getPresignedUploadUrl.mockResolvedValue(mockResult);

      const key = 'ik_test-key-456';
      const body = {
        fileName: 'invoice.pdf',
        mimeType: VALID_PDF_MIME,
        fileSize: 50000,
        invoiceId: 'custom-inv-42',
      };

      // First call
      const first = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', key)
        .send(body);

      expect(first.status).toBe(200);
      const firstInvoiceId = first.body.invoiceId;

      // Second call with same key and body
      const second = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', key)
        .send(body);

      expect(second.status).toBe(200);
      expect(second.body.invoiceId).toBe(firstInvoiceId);
    });

    it('should return 409 when same idempotency key is used with different body', async () => {
      const key = 'ik_test-key-789';

      // First call with body A
      await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', key)
        .send({
          fileName: 'invoice.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 50000,
        })
        .expect(200);

      // Second call with same key but body B
      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', key)
        .send({
          fileName: 'different.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 100000,
        });

      expect(response.status).toBe(409);
      expect(response.body.type).toMatch(/conflict/);
    });

    it('should return 400 if Idempotency-Key header is missing', async () => {
      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .send({
          fileName: 'invoice.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 50000,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Idempotency-Key header is required for this endpoint.');
    });

    it('should return 400 if no tenant is provided', async () => {
      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('Idempotency-Key', 'ik_test-key-012')
        .send({
          fileName: 'invoice.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 50000,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Missing tenant context.');
    });

    it('should include invoiceId from request body', async () => {
      const mockResult = {
        url: 'https://s3-presigned.example.com/upload',
        key: 'tenants/test-tenant/invoices/custom-inv-42/uuid-file.pdf',
      };
      storageService.getPresignedUploadUrl.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', 'ik_test-key-345')
        .send({
          fileName: 'invoice.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 50000,
          invoiceId: 'custom-inv-42',
        });

      expect(response.status).toBe(200);
      expect(response.body.invoiceId).toBe('custom-inv-42');
      expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        invoiceId: 'custom-inv-42',
        fileName: 'invoice.pdf',
        mimeType: VALID_PDF_MIME,
        fileSize: 50000,
      });
    });

    it('should return 400 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', 'ik_test-key-678')
        .send({ fileName: 'test.pdf' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('fileName, mimeType, and fileSize are required');
    });

    it('should return 400 for invalid MIME type', async () => {
      const error = new Error('Invalid MIME type: "text/html"');
      error.code = 'INVALID_MIME_TYPE';
      storageService.getPresignedUploadUrl.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', 'ik_test-key-901')
        .send({
          fileName: 'test.html',
          mimeType: 'text/html',
          fileSize: 1000,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid MIME type');
    });

    it('should return 400 for oversized file', async () => {
      const error = new Error('File size 1048576 exceeds maximum');
      error.code = 'FILE_TOO_LARGE';
      storageService.getPresignedUploadUrl.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', 'ik_test-key-234')
        .send({
          fileName: 'large.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 1048576,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('File size exceeds maximum');
    });

    it('should never expose AWS credentials in response', async () => {
      const mockResult = {
        url: 'https://s3-presigned.example.com/upload',
        key: 'tenants/uuid/invoices/uuid/file.pdf',
      };
      storageService.getPresignedUploadUrl.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/sme/invoice/presigned-url')
        .set('X-Tenant-Id', 'test-tenant')
        .set('Idempotency-Key', 'ik_test-key-567')
        .send({
          fileName: 'invoice.pdf',
          mimeType: VALID_PDF_MIME,
          fileSize: 50000,
        });

      const bodyString = JSON.stringify(response.body);
      expect(bodyString).not.toContain('AKIA');
      expect(bodyString).not.toContain('secretAccessKey');
      expect(bodyString).not.toContain('AWS_ACCESS_KEY');
      expect(bodyString).not.toContain('aws_secret');
    });
  });
});

describe('StorageService Unit - File Validation', () => {
  let StorageService;

  beforeAll(() => {
    StorageService = require('../src/services/storage').StorageService;
  });

  describe('_sanitizeFilename', () => {
    const svc = new StorageService();

    it('should reject directory traversal attempts', () => {
      expect(() =>
        svc._sanitizeFilename('../../etc/passwd')
      ).toThrow('Path traversal detected');
    });

    it('should handle simple filename', () => {
      expect(svc._sanitizeFilename('invoice.pdf')).toBe('invoice.pdf');
    });

    it('should remove null bytes', () => {
      expect(svc._sanitizeFilename('evil\0.pdf')).toBe('evil.pdf');
    });

    it('should replace special characters with underscores', () => {
      const result = svc._sanitizeFilename('bad:chars|here?.pdf');
      expect(result).toBe('bad_chars_here_.pdf');
    });

    it('should reject empty input', () => {
      expect(() => svc._sanitizeFilename('')).toThrow('Invalid filename');
    });

    it('should reject non-string input', () => {
      expect(() => svc._sanitizeFilename(null)).toThrow('Invalid filename');
      expect(() => svc._sanitizeFilename(undefined)).toThrow('Invalid filename');
    });

    it('should truncate long filenames', () => {
      const long = 'a'.repeat(300) + '.pdf';
      const result = svc._sanitizeFilename(long);
      expect(result.length).toBeLessThanOrEqual(255);
    });

  it('should reject Windows traversal attempts', () => {
    expect(() =>
      svc._sanitizeFilename('..\\..\\windows\\system32')
    ).toThrow();
  });

    it('should handle angle brackets in filename', () => {
      const result = svc._sanitizeFilename('<script>alert(1)</script>.pdf');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });
  });

  describe('_validateMimeType', () => {
    const svc = new StorageService();

    it('should accept application/pdf', () => {
      expect(svc._validateMimeType('application/pdf')).toBe(true);
    });

    it('should accept image/jpeg', () => {
      expect(svc._validateMimeType('image/jpeg')).toBe(true);
    });

    it('should accept image/png', () => {
      expect(svc._validateMimeType('image/png')).toBe(true);
    });

    it('should accept image/tiff', () => {
      expect(svc._validateMimeType('image/tiff')).toBe(true);
    });

    it('should reject text/html', () => {
      expect(svc._validateMimeType('text/html')).toBe(false);
    });

    it('should reject application/octet-stream', () => {
      expect(svc._validateMimeType('application/octet-stream')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(svc._validateMimeType('')).toBe(false);
    });
  });

  describe('_validateTenantId', () => {
    const svc = new StorageService();

    it('accepts valid tenant ids', () => {
      expect(svc._validateTenantId('tenant-123')).toBe(true);
    });

    it('rejects path traversal', () => {
      expect(svc._validateTenantId('../../admin')).toBe(false);
    });

    it('rejects slashes', () => {
      expect(svc._validateTenantId('tenant/admin')).toBe(false);
    });

    it('rejects empty values', () => {
      expect(svc._validateTenantId('')).toBe(false);
    });
  });

  describe('_validateInvoiceId', () => {
    const svc = new StorageService();

    it('accepts valid invoice ids', () => {
      expect(svc._validateInvoiceId('inv-123')).toBe(true);
    });

    it('rejects traversal attempts', () => {
      expect(svc._validateInvoiceId('../../invoice')).toBe(false);
    });

    it('rejects slashes', () => {
      expect(svc._validateInvoiceId('inv/123')).toBe(false);
    });

    it('rejects empty values', () => {
      expect(svc._validateInvoiceId('')).toBe(false);
    });
  });

  describe('_generateKey', () => {
    const svc = new StorageService();
    const realUUID = crypto.randomUUID;

    beforeAll(() => {
      crypto.randomUUID = () => 'fixed-uuid-123';
    });

    afterAll(() => {
      crypto.randomUUID = realUUID;
    });

    it('should generate tenant-scoped key', () => {
      const key = svc._generateKey('tenant-abc', 'inv-42', 'report.pdf');
      expect(key).toMatch(/^tenants\/tenant-abc\/invoices\/inv-42\/fixed-uuid-123-report\.pdf$/);
    });

    it('should include UUID in key to prevent enumeration', () => {
      const key = svc._generateKey('t1', 'i1', 'doc.pdf');
      expect(key).toContain('fixed-uuid-123');
    });
  });

  describe('uploadFile validation', () => {
    const svc = new StorageService();

    it('should reject oversized files', async () => {
      const bigBuffer = Buffer.alloc(svc.maxFileSize + 1);
      await expect(
        svc.uploadFile(bigBuffer, 'test.pdf', 'application/pdf')
      ).rejects.toThrow('exceeds maximum');
    });

    it('should reject invalid MIME types', async () => {
      const buf = Buffer.from('small content');
      await expect(
        svc.uploadFile(buf, 'test.html', 'text/html')
      ).rejects.toThrow('Invalid MIME type');
    });
  });

  describe('getPresignedUploadUrl validation', () => {
    const svc = new StorageService();

    it('rejects invalid tenant ids', async () => {
      await expect(
        svc.getPresignedUploadUrl({
          tenantId: '../../admin',
          invoiceId: 'inv1',
          fileName: 'file.pdf',
          mimeType: 'application/pdf',
          fileSize: 100,
        })
      ).rejects.toThrow();
    });

    it('rejects invalid invoice ids', async () => {
      await expect(
        svc.getPresignedUploadUrl({
          tenantId: 'tenant1',
          invoiceId: '../../invoice',
          fileName: 'file.pdf',
          mimeType: 'application/pdf',
          fileSize: 100,
        })
      ).rejects.toThrow();
    });

    it('should reject oversized file sizes', async () => {
      await expect(
        svc.getPresignedUploadUrl({
          tenantId: 't1',
          invoiceId: 'i1',
          fileName: 'big.pdf',
          mimeType: 'application/pdf',
          fileSize: svc.maxFileSize + 1,
        })
      ).rejects.toThrow('exceeds maximum');
    });

    it('should reject invalid MIME types', async () => {
      await expect(
        svc.getPresignedUploadUrl({
          tenantId: 't1',
          invoiceId: 'i1',
          fileName: 'bad.html',
          mimeType: 'text/html',
          fileSize: 100,
        })
      ).rejects.toThrow('Invalid MIME type');
    });
  });
});

describe('InvoiceFile Route - Presigned Upload (POST /api/invoices/:id/presigned-upload)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should generate presigned upload URL', async () => {
    storageService.getPresignedUploadUrl.mockResolvedValue({
      url: 'https://s3.example.com/presigned',
      key: 'tenants/unknown/invoices/inv-456/uuid-file.pdf',
    });

    const response = await request(app)
      .post('/api/invoices/inv-456/presigned-upload')
      .send({
        fileName: 'invoice.pdf',
        mimeType: VALID_PDF_MIME,
        fileSize: 50000,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.uploadUrl).toBe('https://s3.example.com/presigned');
    expect(response.body.data.fileKey).toContain('tenants/unknown/invoices/inv-456');
  });

  it('should return 400 for missing invoice ID', async () => {
    const response = await request(app)
      .post('/api/invoices//presigned-upload')
      .send({ fileName: 'test.pdf', mimeType: VALID_PDF_MIME, fileSize: 100 });

    expect(response.status).toBe(400);
  });

  it('should return 400 for missing fields', async () => {
    const response = await request(app)
      .post('/api/invoices/inv-1/presigned-upload')
      .send({ fileName: 'test.pdf' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Bad Request');
  });

  it('should return 400 for invalid MIME type', async () => {
    const error = new Error('Invalid MIME type');
    error.code = 'INVALID_MIME_TYPE';
    storageService.getPresignedUploadUrl.mockRejectedValue(error);

    const response = await request(app)
      .post('/api/invoices/inv-1/presigned-upload')
      .send({
        fileName: 'test.html',
        mimeType: 'text/html',
        fileSize: 100,
      });

    expect(response.status).toBe(400);
  });

  it('should never leak credentials in response', async () => {
    storageService.getPresignedUploadUrl.mockResolvedValue({
      url: 'https://s3.example.com/presigned',
      key: 'tenants/uuid/invoices/uuid/file.pdf',
    });

    const response = await request(app)
      .post('/api/invoices/inv-1/presigned-upload')
      .send({
        fileName: 'invoice.pdf',
        mimeType: VALID_PDF_MIME,
        fileSize: 50000,
      });

    const bodyString = JSON.stringify(response.body);
    expect(bodyString).not.toContain('AKIA');
    expect(bodyString).not.toContain('secretAccessKey');
    expect(bodyString).not.toContain('AWS');
  });
});

describe('getSignedUrl expiry validation', () => {
  const svc = new StorageService();

  it('rejects expiry less than 1 second', async () => {
    await expect(
      svc.getSignedUrl('test-key', 0)
    ).rejects.toThrow('Expiry must be between');
  });

  it('rejects expiry greater than max allowed', async () => {
    await expect(
      svc.getSignedUrl('test-key', 999999)
    ).rejects.toThrow('Expiry must be between');
  });
});
