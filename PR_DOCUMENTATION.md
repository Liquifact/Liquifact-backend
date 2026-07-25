# Pull Request: Add Idempotency Key Support to Admin Config Write Endpoints

## Description
This PR implements optional idempotency support for the `POST /api/admin/config` endpoint, preventing the double-application of configuration updates during request retries. The feature is designed for safe, gradual rollout—it only enforces idempotency if the client provides the `Idempotency-Key` header. 

## Changes Made
### 1. Route & Middleware Updates (`src/routes/adminConfig.js`)
- Introduced an `optionalIdempotency` wrapper around the existing `idempotencyMiddleware`. It checks for the presence of the `Idempotency-Key` header and delegates to the underlying idempotency logic, bypassing it if the header is absent.
- Integrated the `optionalIdempotency` middleware into the `POST /api/admin/config` route handler pipeline.

### 2. OpenAPI & API Documentation
- Updated the JSDoc for `POST /api/admin/config` to document the newly supported `Idempotency-Key` header parameter.
- Documented new failure scenarios:
  - **400 Bad Request:** Now includes validation errors for malformed idempotency keys.
  - **409 Conflict:** Added response schema for idempotency conflicts (i.e., when a key is reused with a different payload).

### 3. Unit Tests (`tests/unit/adminConfig.idempotency.test.js`)
- Added a comprehensive unit test suite leveraging `supertest` and Jest mocks for database transaction builders.
- **Coverage includes:**
  - Standard bypassing of the idempotency logic when the header is omitted.
  - Rejection of invalid `Idempotency-Key` formats.
  - Correct handling and persistence of the initial request.
  - Successful replay of cached responses for exactly matching keys and payloads.
  - Verification that a `409 Conflict` is returned when a key is reused with a modified request body.

## Verification
- Unit tests have been implemented and pass.
- The OpenAPI specification dynamically updates based on the JSDoc comments.

## Related Issues
- **Resolves:** Issue #755 (Idempotency Key Support)
