# Post-upload MIME and size validation

After a client completes a presigned S3 upload, the API re-validates:

1. Declared `Content-Type` matches the allowlist for invoice attachments
2. Object size is within tenant limits (bytes, not just Content-Length at sign time)
3. Checksum metadata matches the uploaded object when provided

Failures mark the upload as `rejected` and do not attach the file to the
invoice record. See `tests/invoiceFile.upload.test.js` for regression coverage.
