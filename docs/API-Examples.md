# API Examples - RFC 7807 Problem+JSON Error Handling

This document provides practical examples of how to interact with the LiquiFact API and handle problem+json error responses.

## Setup

### Base URL
```
http://localhost:3001
```

### Authentication
All protected endpoints require a Bearer token:
```bash
export TOKEN="your-jwt-token-here"
```

## Error Response Examples

### 1. Validation Error (400)

**Request:**
```bash
curl -X POST http://localhost:3001/api/invoices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "amount": "",
    "customer": ""
  }'
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_123456789

{
  "type": "https://liquifact.com/probs/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Amount and customer are required fields",
  "instance": "/api/invoices"
}
```

### 2. Not Found Error (404)

**Request:**
```bash
curl -X GET http://localhost:3001/api/invoices/nonexistent-id \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**
```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
X-Request-ID: req_123456790

{
  "type": "https://liquifact.com/probs/not-found",
  "title": "Invoice Not Found",
  "status": 404,
  "detail": "Invoice with ID 'nonexistent-id' not found",
  "instance": "/api/invoices/nonexistent-id"
}
```

### 3. Conflict Error (409)

**Request:**
```bash
curl -X DELETE http://localhost:3001/api/invoices/already-deleted-id \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_123456791

{
  "type": "https://liquifact.com/probs/conflict",
  "title": "Conflict",
  "status": 400,
  "detail": "Invoice is already deleted",
  "instance": "/api/invoices/already-deleted-id"
}
```

### 4. Service Unavailable Error (503)

**Request:**
```bash
curl -X GET http://localhost:3001/api/escrow/inv_123 \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**
```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/problem+json
X-Request-ID: req_123456792

{
  "type": "https://liquifact.com/probs/service-unavailable",
  "title": "Service Unavailable",
  "status": 503,
  "detail": "Error fetching escrow state",
  "instance": "/api/escrow/inv_123"
}
```

### 5. Unauthorized Error (401)

**Request:**
```bash
curl -X GET http://localhost:3001/api/invoices \
  -H "Authorization: Bearer invalid-token"
```

**Response:**
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
X-Request-ID: req_123456793

{
  "type": "https://liquifact.com/probs/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid or expired authentication token",
  "instance": "/api/invoices"
}
```

### 6. Rate Limited Error (429)

**Request:**
```bash
# Make multiple rapid requests to trigger rate limiting
for i in {1..100}; do
  curl -X GET http://localhost:3001/api/invoices \
    -H "Authorization: Bearer $TOKEN" \
    -w "%{http_code}\n" \
    -o /dev/null \
    -s
done
```

**Response:**
```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
X-Request-ID: req_123456794
Retry-After: 60

{
  "type": "https://liquifact.com/probs/rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Rate limit exceeded. Please try again later.",
  "instance": "/api/invoices"
}
```

## Success Response Examples

### 1. Create Invoice (201)

**Request:**
```bash
curl -X POST http://localhost:3001/api/invoices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "amount": 10000,
    "customer": "Acme Corp"
  }'
```

**Response:**
```http
HTTP/1.1 201 Created
Content-Type: application/json
X-Request-ID: req_123456795

{
  "data": {
    "id": "inv_1640995200000_123",
    "amount": 10000,
    "customer": "Acme Corp",
    "status": "pending_verification",
    "createdAt": "2021-12-31T23:59:59.999Z",
    "deletedAt": null
  },
  "message": "Invoice uploaded successfully."
}
```

### 2. Get Invoice (200)

**Request:**
```bash
curl -X GET http://localhost:3001/api/invoices/inv_1640995200000_123 \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req_123456796

{
  "data": {
    "id": "inv_1640995200000_123",
    "amount": 10000,
    "customer": "Acme Corp",
    "status": "pending_verification",
    "createdAt": "2021-12-31T23:59:59.999Z",
    "deletedAt": null
  },
  "message": "Invoice retrieved successfully"
}
```

## Client Implementation Examples

### JavaScript/Node.js

```javascript
class LiquiFactAPI {
  constructor(baseURL, token) {
    this.baseURL = baseURL;
    this.token = token;
  }

  async request(method, endpoint, data = null) {
    const url = `${this.baseURL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      }
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/problem+json')) {
          const problem = await response.json();
          throw new APIError(problem);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof APIError) {
        console.error(`API Error: ${error.problem.title} - ${error.problem.detail}`);
        // Handle specific error types
        switch (error.problem.type) {
          case 'https://liquifact.com/probs/validation-error':
            // Handle validation errors
            break;
          case 'https://liquifact.com/probs/not-found':
            // Handle not found errors
            break;
          case 'https://liquifact.com/probs/rate-limited':
            // Handle rate limiting
            console.log('Rate limited. Waiting before retry...');
            await new Promise(resolve => setTimeout(resolve, 60000));
            return this.request(method, endpoint, data); // Retry
          default:
            // Handle other errors
            break;
        }
      }
      throw error;
    }
  }

  async createInvoice(amount, customer) {
    return this.request('POST', '/api/invoices', { amount, customer });
  }

  async getInvoice(id) {
    return this.request('GET', `/api/invoices/${id}`);
  }

  async deleteInvoice(id) {
    return this.request('DELETE', `/api/invoices/${id}`);
  }
}

class APIError extends Error {
  constructor(problem) {
    super(problem.detail);
    this.problem = problem;
    this.name = 'APIError';
  }
}

// Usage example
const api = new LiquiFactAPI('http://localhost:3001', 'your-token');

try {
  const invoice = await api.createInvoice(10000, 'Acme Corp');
  console.log('Invoice created:', invoice);
} catch (error) {
  console.error('Failed to create invoice:', error.message);
}
```

### Python

```python
import requests
import json
from typing import Dict, Any, Optional

class LiquiFactAPI:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url
        self.token = token
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}'
        })

    def request(self, method: str, endpoint: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{endpoint}"
        
        try:
            response = self.session.request(method, url, json=data)
            
            if not response.ok:
                content_type = response.headers.get('content-type', '')
                if 'application/problem+json' in content_type:
                    problem = response.json()
                    raise APIError(problem)
                response.raise_for_status()
            
            return response.json()
        
        except requests.exceptions.RequestException as e:
            raise APIError({
                'type': 'https://liquifact.com/probs/network-error',
                'title': 'Network Error',
                'status': 500,
                'detail': str(e),
                'instance': endpoint
            })

    def create_invoice(self, amount: int, customer: str) -> Dict[str, Any]:
        return self.request('POST', '/api/invoices', {'amount': amount, 'customer': customer})

    def get_invoice(self, invoice_id: str) -> Dict[str, Any]:
        return self.request('GET', f'/api/invoices/{invoice_id}')

    def delete_invoice(self, invoice_id: str) -> Dict[str, Any]:
        return self.request('DELETE', f'/api/invoices/{invoice_id}')


class APIError(Exception):
    def __init__(self, problem: Dict[str, Any]):
        self.problem = problem
        super().__init__(problem.get('detail', 'Unknown error'))

    def __str__(self):
        return f"{self.problem.get('title', 'API Error')}: {self.problem.get('detail', 'Unknown error')}"


# Usage example
api = LiquiFactAPI('http://localhost:3001', 'your-token')

try:
    invoice = api.create_invoice(10000, 'Acme Corp')
    print('Invoice created:', invoice)
except APIError as e:
    print(f'API Error: {e}')
    print(f'Problem Type: {e.problem.get("type")}')
    print(f'Status: {e.problem.get("status")}')
```

### cURL Script

```bash
#!/bin/bash

# Configuration
BASE_URL="http://localhost:3001"
TOKEN="your-jwt-token-here"

# Helper function to handle responses
handle_response() {
    local response=$1
    local status_code=$(echo "$response" | head -n1 | cut -d' ' -f2)
    
    if [[ $status_code -ge 400 ]]; then
        echo "Error occurred (HTTP $status_code):"
        echo "$response" | grep -E '"type"|"title"|"detail"' | sed 's/^[[:space:]]*//'
        return 1
    else
        echo "Success (HTTP $status_code):"
        echo "$response" | tail -n +2
        return 0
    fi
}

# Create invoice
echo "Creating invoice..."
response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/invoices" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"amount": 10000, "customer": "Acme Corp"}')

if handle_response "$response"; then
    # Extract invoice ID from response
    invoice_id=$(echo "$response" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    echo "Invoice ID: $invoice_id"
    
    # Get invoice
    echo -e "\nGetting invoice..."
    get_response=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL/api/invoices/$invoice_id" \
        -H "Authorization: Bearer $TOKEN")
    handle_response "$get_response"
    
    # Delete invoice
    echo -e "\nDeleting invoice..."
    delete_response=$(curl -s -w "\n%{http_code}" -X DELETE "$BASE_URL/api/invoices/$invoice_id" \
        -H "Authorization: Bearer $TOKEN")
    handle_response "$delete_response"
fi
```

## Testing Error Handling

### Test Script (JavaScript)

```javascript
const testErrorHandling = async () => {
  const api = new LiquiFactAPI('http://localhost:3001', 'test-token');
  
  console.log('Testing error scenarios...\n');
  
  // Test 1: Validation error
  try {
    await api.createInvoice('', '');
  } catch (error) {
    console.log('✓ Validation error handled correctly');
    console.log(`  Type: ${error.problem.type}`);
    console.log(`  Title: ${error.problem.title}`);
    console.log(`  Detail: ${error.problem.detail}\n`);
  }
  
  // Test 2: Not found error
  try {
    await api.getInvoice('nonexistent-id');
  } catch (error) {
    console.log('✓ Not found error handled correctly');
    console.log(`  Type: ${error.problem.type}`);
    console.log(`  Title: ${error.problem.title}`);
    console.log(`  Detail: ${error.problem.detail}\n`);
  }
  
  // Test 3: Success case
  try {
    const invoice = await api.createInvoice(10000, 'Test Corp');
    console.log('✓ Invoice created successfully');
    console.log(`  ID: ${invoice.data.id}\n`);
    
    // Clean up
    await api.deleteInvoice(invoice.data.id);
    console.log('✓ Invoice deleted successfully\n');
  } catch (error) {
    console.log('✗ Unexpected error:', error.message);
  }
};

testErrorHandling();
```

## Best Practices

### 1. Always Check Content-Type
```javascript
const contentType = response.headers.get('content-type');
if (contentType && contentType.includes('application/problem+json')) {
  // Handle problem+json error
}
```

### 2. Use Problem Type for Programmatic Handling
```javascript
switch (error.problem.type) {
  case 'https://liquifact.com/probs/validation-error':
    // Show validation errors to user
    break;
  case 'https://liquifact.com/probs/rate-limited':
    // Implement retry logic
    break;
  default:
    // Show generic error message
}
```

### 3. Log Request IDs for Debugging
```javascript
const requestId = response.headers.get('x-request-id');
console.log(`Request ID: ${requestId}`);
```

### 4. Implement Exponential Backoff for Rate Limiting
```javascript
const retryWithBackoff = async (fn, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.problem.type === 'https://liquifact.com/probs/rate-limited' && i < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, i), 30000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
};
```

## Troubleshooting

### Common Issues

1. **Invalid Token**: Ensure your JWT token is valid and not expired
2. **Missing Headers**: Always include `Content-Type: application/json` for POST/PUT requests
3. **Malformed JSON**: Validate your JSON payload before sending
4. **Rate Limiting**: Implement proper rate limiting handling in your client

### Debug Mode

Enable debug logging to see detailed request/response information:

```javascript
const api = new LiquiFactAPI('http://localhost:3001', 'your-token');
api.debug = true; // Enable debug logging
```

This will log all requests and responses for debugging purposes.
