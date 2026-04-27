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

### 1. Validation Error

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
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Amount and customer are required fields",
  "instance": "/api/invoices"
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

### Middleware

The problem+json middleware is implemented in `src/middleware/problemJson.js` and includes:

- Error type mapping for common HTTP errors
- Request correlation via instance URI
- Secure logging with pino logger
- Production-safe error responses (no stack traces)

### Error Handling

All route handlers now use the `AppError` class to throw structured errors:

```javascript
throw new AppError({
  type: 'https://liquifact.com/probs/validation-error',
  title: 'Validation Error',
  status: 400,
  detail: 'Amount and customer are required fields',
  instance: req.originalUrl,
});
```

### Request Correlation

Each error response includes an `instance` field that references the original request URL, enabling request correlation and debugging.

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
  const response = await fetch('/api/invoices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({})
  });
  
  if (!response.ok) {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/problem+json')) {
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
  console.error('Network error:', error);
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
