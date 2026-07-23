# RFC 7807 Problem+JSON Error Handling

This document describes the implementation of RFC 7807 Problem Details for HTTP APIs in the LiquiFact backend.

## Overview

The LiquiFact API now returns standardized error responses in the `application/problem+json` format for all 4xx and 5xx errors, providing consistent error handling across the entire API.

## RFC 7807 Specification

The API implements the [RFC 7807 Problem Details for HTTP APIs](https://tools.ietf.org/html/rfc7807) specification, which defines a standard format for error responses.

## Error Response Format

All error responses follow this structure:

```json
{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Amount and customer are required fields",
  "instance": "/api/invoices"
}
```

### Fields

- **type** (required): A URI reference that identifies the problem type
- **title** (required): A short, human-readable summary of the problem type
- **status** (required): The HTTP status code
- **detail** (optional): A human-readable explanation specific to this occurrence
- **instance** (optional): A URI reference that identifies the specific occurrence of the problem

## Problem Types

The following problem types are defined:

### Validation Errors

- **Type**: `https://liquifact.com/probs/validation-error`
- **Status**: 400
- **Title**: "Validation Error"
- **Description**: Request validation failed

### Not Found Errors

- **Type**: `https://liquifact.com/probs/not-found`
- **Status**: 404
- **Title**: "Resource Not Found"
- **Description**: Requested resource does not exist

### Conflict Errors

- **Type**: `https://liquifact.com/probs/conflict`
- **Status**: 409
- **Title**: "Conflict"
- **Description**: Request conflicts with current state

### Service Unavailable

- **Type**: `https://liquifact.com/probs/service-unavailable`
- **Status**: 503
- **Title**: "Service Unavailable"
- **Description**: Service temporarily unavailable

### Unauthorized

- **Type**: `https://liquifact.com/probs/unauthorized`
- **Status**: 401
- **Title**: "Unauthorized"
- **Description**: Authentication required

### Forbidden

- **Type**: `https://liquifact.com/probs/forbidden`
- **Status**: 403
- **Title**: "Forbidden"
- **Description**: Access denied

### Rate Limited

- **Type**: `https://liquifact.com/probs/rate-limited`
- **Status**: 429
- **Title**: "Too Many Requests"
- **Description**: Rate limit exceeded

### Internal Server Error

- **Type**: `https://liquifact.com/probs/internal-server-error`
- **Status**: 500
- **Title**: "Internal Server Error"
- **Description**: Unexpected server error

## API Examples

### 1. Validation Error (Request Body)

**Request:**

```bash
curl -X POST http://localhost:3001/api/invoices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{}'
```

**Response:**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body contains invalid or missing fields.",
  "fieldErrors": {
    "amount": "amount is required",
    "seller": "seller is required",
    "currency": "currency is required",
    "dueDate": "dueDate is required",
    "buyer": "buyer is required"
  }
}
```

### 1b. Validation Error (Query Parameters)

**Request:**

```bash
curl -X GET "http://localhost:3001/api/marketplace?yieldBpsMin=-100&status=invalid" \
  -H "Authorization: Bearer your-token"
```

**Response:**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://liquifact.io/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Query parameters contain invalid values.",
  "fieldErrors": {
    "yieldBpsMin": "yieldBpsMin must be a non-negative integer",
    "status": "Invalid status. Must be one of: pending_verification, verified, funded, partially_funded, completed, defaulted"
  }
}
```

### 2. Not Found Error

**Request:**

```bash
curl -X GET http://localhost:3001/api/invoices/nonexistent \
  -H "Authorization: Bearer your-token"
```

**Response:**

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{
  "type": "https://liquifact.com/probs/not-found",
  "title": "Invoice Not Found",
  "status": 404,
  "detail": "Invoice with ID 'nonexistent' not found",
  "instance": "/api/invoices/nonexistent"
}
```

### 3. Conflict Error

**Request:**

```bash
curl -X DELETE http://localhost:3001/api/invoices/inv_123 \
  -H "Authorization: Bearer your-token"
```

**Response:**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://liquifact.com/probs/conflict",
  "title": "Conflict",
  "status": 400,
  "detail": "Invoice is already deleted",
  "instance": "/api/invoices/inv_123"
}
```

### 4. Service Unavailable Error

**Request:**

```bash
curl -X GET http://localhost:3001/api/escrow/inv_123 \
  -H "Authorization: Bearer your-token"
```

**Response:**

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/problem+json

{
  "type": "https://liquifact.com/probs/service-unavailable",
  "title": "Service Unavailable",
  "status": 503,
  "detail": "Error fetching escrow state",
  "instance": "/api/escrow/inv_123"
}
```

## Implementation Details

### Architecture / Data Flow

Every RFC 7807 response follows this flow through the system:

```
Route / Service
  │
  ├─ throw new AppError({...})     ──┐
  │      OR                          │
  └─ next(Error)                   ──┤
                                     ▼
                          ┌──────────────────┐
                          │  problemJson     │
                          │  Middleware       │
                          │  (Express error   │
                          │   handler)        │
                          └────────┬─────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │      mapError()           │
                     │  Normalises any thrown    │
                     │  value to a stable        │
                     │  { status, code, message, │
                     │    retryable, retryHint } │
                     └─────────────┬─────────────┘
                                   │
                     ┌─────────────▼──────────────┐
                     │  formatProblemDetails()    │
                     │  (Canonical Builder)       │
                     │  src/utils/problemDetails  │
                     │                             │
                     │  The **only** place that   │
                     │  assembles RFC 7807 fields │
                     └─────────────┬──────────────┘
                                   │
                     ┌─────────────▼──────────────┐
                     │  200+ JSON response with   │
                     │  Content-Type:             │
                     │    application/problem+json│
                     └────────────────────────────┘
```

#### 1. AppError (optional, for structured errors)

Route handlers may throw `AppError` (defined in `src/errors/AppError.js`) to attach explicit RFC 7807 fields:

```javascript
throw new AppError({
  type: "https://liquifact.com/probs/validation-error",
  title: "Validation Error",
  status: 400,
  detail: "Amount is required",
  instance: req.originalUrl,
  code: "VALIDATION_FAILED",
  retryable: false,
  retryHint: "Check field values",
});
```

Internally, `AppError.constructor` calls `formatProblemDetails` and reads back every field (including extensions) from the builder's output, making `formatProblemDetails` the sole source of truth.

#### 2. mapError (error normaliser)

`mapError` (`src/errors/mapError.js`) converts any thrown value to a stable contract:

```
{ status: number, code: string, message: string, retryable: boolean, retryHint: string }
```

It handles `AppError`, body-parser syntax errors, CORS rejections, network errors (`ECONNREFUSED`), circuit-breaker state, and generic fallbacks. The mapped object is then consumed by the middleware. **mapError does not construct RFC 7807 objects**; it only provides the raw data that flows into the canonical builder.

#### 3. Canonical Builder (`formatProblemDetails`)

`src/utils/problemDetails.js` exports `formatProblemDetails` — the **single canonical builder** for all RFC 7807 problem objects:

```javascript
const formatProblemDetails = require("./utils/problemDetails");

const problem = formatProblemDetails({
  type: "https://liquifact.com/probs/validation-error",
  title: "Validation Error",
  status: 400,
  detail: "Amount is required",
  instance: "/api/invoices",
  code: "VALIDATION_FAILED", // optional extension
  retryable: false, // optional extension
  retryHint: "Check field values", // optional extension
});
```

The builder:
- Resolves defaults for `type` (`"about:blank"`), `title` (`"An unexpected error occurred"`), and `status` (`500`)
- Conditionally includes `detail`, `instance`, and all extensions only when present
- Strips `stack` in production (`NODE_ENV === "production"`)
- Always outputs `retry_hint` (snake_case) in the JSON response for the `retryHint` input

Both `AppError.constructor` and `problemJsonHandler` call this builder — no other code path assembles RFC 7807 fields.

#### 4. Middleware (problemJson)

The middleware (`src/middleware/problemJson.js`):

1. Calls `mapError(error)` to normalise the thrown value
2. Resolves problem-specific fields (`type`, `title`, `instance`) based on error type
3. Calls `formatProblemDetails` with the resolved fields → obtains the final problem object
4. Sets `Content-Type: application/problem+json` and sends the response

It also provides:
- `createProblemDetails(options)` — thin convenience wrapper over `formatProblemDetails`
- `notFoundHandler(req, res, next)` — creates a `404` AppError and passes it through the normal flow

### Request Correlation

Each error response includes an `instance` field that references the request correlation ID (`urn:uuid:${requestId}`), enabling end-to-end tracing.

## Security Considerations

1. **No Information Leakage**: Stack traces and internal error details are not exposed in production
2. **Consistent Error Format**: All errors follow the same structure to prevent information disclosure
3. **Rate Limiting**: Error endpoints are subject to the same rate limiting as other endpoints
4. **Logging**: All errors are logged with appropriate severity levels for monitoring

## Migration Guide

### For API Consumers

1. **Update Error Handling**: Modify your client code to handle `application/problem+json` responses
2. **Check Content-Type**: Always check the `Content-Type` header before parsing error responses
3. **Use Problem Type**: Use the `type` field for programmatic error handling
4. **Display Title/Detail**: Use the `title` and `detail` fields for user-facing messages

### Example Client Code

```javascript
try {
  const response = await fetch("/api/invoices", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/problem+json")) {
      const problem = await response.json();
      console.error(`Error: ${problem.title} - ${problem.detail}`);
      // Handle based on problem.type
      return;
    }
    // Handle other error formats
  }

  const data = await response.json();
  // Process successful response
} catch (error) {
  console.error("Network error:", error);
}
```

## Testing

The problem+json middleware is thoroughly tested in `tests/problems.test.js` with 95%+ coverage including:

- Problem type mapping
- Error response format validation
- Request correlation
- Logging verification
- Edge cases and error conditions

## Monitoring and Observability

1. **Structured Logging**: All errors are logged with structured data including request ID and problem type
2. **Metrics**: Error types and HTTP status codes are available for monitoring
3. **Correlation**: Request IDs enable end-to-end tracing of errors
4. **Alerting**: Critical errors (5xx) trigger appropriate alerts

## Best Practices

1. **Use Specific Problem Types**: Choose the most specific problem type for each error scenario
2. **Provide Helpful Details**: Include actionable information in the `detail` field
3. **Maintain Consistency**: Use the same error format across all endpoints
4. **Document Problem Types**: Keep this documentation updated with new problem types
5. **Test Error Scenarios**: Include error cases in your API testing strategy

## OpenAPI Integration

The problem+json format is integrated with OpenAPI/Swagger documentation:

```yaml
components:
  schemas:
    Problem:
      type: object
      required:
        - type
        - title
        - status
      properties:
        type:
          type: string
          format: uri
          description: A URI reference that identifies the problem type
        title:
          type: string
          description: A short, human-readable summary of the problem type
        status:
          type: integer
          description: The HTTP status code
        detail:
          type: string
          description: A human-readable explanation specific to this occurrence
        instance:
          type: string
          format: uri
          description: A URI reference that identifies the specific occurrence
```

## Support

For questions or issues related to the problem+json error handling implementation, please refer to:

1. The RFC 7807 specification: https://tools.ietf.org/html/rfc7807
2. The middleware implementation: `src/middleware/problemJson.js`
3. Test cases: `tests/problems.test.js`
4. API documentation: `/docs` endpoint
