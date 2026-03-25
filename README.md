# LiquiFact Backend

API gateway and server for **LiquiFact** — the global invoice liquidity network on Stellar. This repo provides the Express-based REST API for invoice uploads, escrow state, and (future) Stellar/Horizon integration.

Part of the LiquiFact stack: **frontend** (Next.js) | **backend** (this repo) | **contracts** (Soroban).

---

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** 9+

---

## Setup

1. **Clone the repo**

   ```bash
   git clone <this-repo-url>
   cd liquifact-backend
   ```

2. **Install dependencies**

   ```bash
   npm ci
   ```

3. **Configure environment** (optional for local dev)

   ```bash
   cp .env.example .env
   # Edit .env if you need Stellar/Horizon/DB settings
   ```

---

## Development

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Start API with watch mode      |
| `npm run start`| Start API (production-style)  |
| `npm run lint` | Run ESLint on `src/`          |
| `npm test`     | Run Jest tests with coverage  |

Default port: **3001**. After starting:

- Health: [http://localhost:3001/health](http://localhost:3001/health)
- API info: [http://localhost:3001/api](http://localhost:3001/api)

---

## Project structure

```
liquifact-backend/
├── src/
│   ├── db/
│   │   ├── storage.js          # Persistent storage (JSON-based)
│   │   └── storage.test.js     # Storage tests
│   ├── models/
│   │   ├── invoice.js          # Invoice schema & validation
│   │   └── invoice.test.js     # Validation tests
│   ├── services/
│   │   ├── soroban.js          # Soroban contract wrapper
│   │   ├── invoiceService.js   # Invoice business logic
│   │   ├── invoiceService.test.js
│   │   └── soroban.test.js
│   ├── utils/
│   │   └── retry.js            # Exponential backoff utility
│   ├── index.js                # Express app, routes
│   └── index.test.js           # API integration tests
├── data/
│   └── invoices.json           # Invoice persistence (auto-created)
├── .env.example                # Env template
├── eslint.config.js
└── package.json
```

---

## Invoice Persistence Layer

### Overview

The invoice persistence layer provides durable storage for invoices with create, read, update, and list operations. It's implemented in three layers:

1. **Storage Layer** (`src/db/storage.js`) — Low-level file I/O with atomic writes
2. **Model Layer** (`src/models/invoice.js`) — Validation and sanitization
3. **Service Layer** (`src/services/invoiceService.js`) — Business logic and error handling

### Features

✅ **CRUD Operations** — Create, read, update, delete invoices
✅ **Validation** — Comprehensive input validation with security checks
✅ **Atomic Writes** — File-based storage with atomic rename for consistency
✅ **Filters** — List invoices with optional status filtering
✅ **Error Handling** — Graceful error handling throughout
✅ **Timestamps** — Auto-generated `createdAt` and `updatedAt` fields
✅ **JSDoc Comments** — Full API documentation

### Invoice Schema

```javascript
{
  "id": "inv_1711353600000_a1b2c3d4e",        // Auto-generated
  "invoiceNumber": "INV-2026-001",             // Business invoice ID (1-64 chars)
  "sellerName": "Acme Corp",                   // Seller name (max 255 chars)
  "buyerName": "Tech LLC",                     // Buyer name (max 255 chars)
  "amount": 5000.50,                           // Amount > 0
  "currency": "USD",                           // ISO 4217 code
  "dueDate": "2027-12-31T23:59:59Z",          // ISO 8601 date (future)
  "description": "Q1 services",                // Optional
  "status": "pending_verification",            // One of: pending_verification, verified, active, funded, completed, cancelled
  "createdAt": "2026-03-25T10:30:00Z",        // Auto-generated
  "updatedAt": "2026-03-25T10:30:00Z"         // Auto-updated
}
```

### API Endpoints

#### **GET /api/invoices**

List all invoices with optional filtering.

**Query Parameters:**
- `status` (optional) — Filter by invoice status

**Example:**
```bash
curl http://localhost:3001/api/invoices
curl http://localhost:3001/api/invoices?status=verified
```

**Response:**
```json
{
  "data": [
    {
      "id": "inv_1711353600000_a1b2c3d4e",
      "invoiceNumber": "INV-2026-001",
      "sellerName": "Acme Corp",
      "buyerName": "Tech LLC",
      "amount": 5000.50,
      "currency": "USD",
      "dueDate": "2027-12-31T23:59:59Z",
      "status": "verified",
      "createdAt": "2026-03-25T10:30:00Z",
      "updatedAt": "2026-03-25T10:30:00Z"
    }
  ],
  "count": 1
}
```

#### **POST /api/invoices**

Create a new invoice.

**Request Body:**
```json
{
  "invoiceNumber": "INV-2026-001",
  "sellerName": "Acme Corp",
  "buyerName": "Tech LLC",
  "amount": 5000.50,
  "currency": "USD",
  "dueDate": "2027-12-31T23:59:59Z",
  "description": "Q1 services"
}
```

**Response (201 Created):**
```json
{
  "data": {
    "id": "inv_1711353600000_a1b2c3d4e",
    "invoiceNumber": "INV-2026-001",
    "sellerName": "Acme Corp",
    "buyerName": "Tech LLC",
    "amount": 5000.50,
    "currency": "USD",
    "dueDate": "2027-12-31T23:59:59Z",
    "description": "Q1 services",
    "status": "pending_verification",
    "createdAt": "2026-03-25T10:30:00Z",
    "updatedAt": "2026-03-25T10:30:00Z"
  },
  "message": "Invoice created successfully"
}
```

**Validation Error Response (400):**
```json
{
  "error": "Validation failed",
  "errors": [
    "invoiceNumber must be 1-64 alphanumeric characters (dash/underscore allowed)",
    "amount must be greater than 0"
  ]
}
```

---

### Validation Rules

| Field | Rule |
|-------|------|
| `invoiceNumber` | 1-64 chars, alphanumeric + dash/underscore, required |
| `sellerName` | Max 255 chars, required |
| `buyerName` | Max 255 chars, required |
| `amount` | Positive number, max 999,999,999.99, required |
| `currency` | ISO 4217 3-letter code, required |
| `dueDate` | ISO 8601 date string, must be in future, required |
| `description` | Max 2000 chars, optional |
| `status` | One of 6 predefined statuses, optional (default: pending_verification) |

---

## Security Considerations

### Input Validation & Sanitization

- **Whitespace Trimming** — All string fields are trimmed to remove leading/trailing whitespace
- **Type Checking** — Strict type enforcement for all fields
- **Invoice Number** — Alphanumeric pattern prevents injection attacks (only `a-zA-Z0-9-_` allowed)
- **Amount Validation** — Must be positive; prevents negative/zero amounts
- **Currency Validation** — ISO 4217 compliance prevents invalid currencies
- **Date Validation** — Must be valid ISO 8601 and in the future
- **Field Whitelisting** — Only known fields are accepted (unknown fields ignored)

### Storage & Persistence

- **Atomic Writes** — Uses atomic file rename to prevent corruption
- **Temp File Cleanup** — Failed writes clean up temporary files
- **JSON Storage** — No SQL injection risk (not using SQL databases)  
- **No Encryption at Rest** — PII in plaintext; for production:
  - Add encryption layer (AES-256 for data at rest)
  - Use environment variables for secrets
  - Implement database-level encryption

### Recommendations for Production

1. **Database Migration** — Switch from JSON file to PostgreSQL/MongoDB
2. **Encryption at Rest** — Add encryption layer for sensitive fields
3. **Access Control** — Implement authentication/authorization (JWT/OAuth)
4. **Rate Limiting** — Add rate limiters to prevent abuse
5. **Audit Logging** — Log all invoice mutations for compliance
6. **HTTPS** — Enforce TLS for all endpoints
7. **API Versioning** — Version endpoints (`/api/v1/invoices`)

---

## Testing

### Run All Tests

```bash
npm test
```

### Test Coverage

The test suite covers:

- ✅ **Storage Layer** — File I/O, atomic writes, filtering, CRUD ops
- ✅ **Model Layer** — Validation rules, sanitization, edge cases
- ✅ **Service Layer** — Business logic, error handling, filtering
- ✅ **API Integration** — Request/response flows, status codes, error responses

**Coverage Goal:** 95%+ line coverage

### Test Output Example

```
PASS  src/db/storage.test.js (5.234 s)
PASS  src/models/invoice.test.js (2.156 s)
PASS  src/services/invoiceService.test.js (4.789 s)
PASS  src/index.test.js (3.456 s)

Test Suites: 4 passed, 4 total
Tests:       87 passed, 87 total
Coverage:    96.2% Statements | 95.8% Branches | 96.1% Functions | 95.9% Lines
```

### Example Test Cases

**Validation:**
- Valid invoice creation
- Negative amount rejection
- Past due date rejection
- Invalid currency code rejection
- Missing required fields rejection

**Filtering:**
- List all invoices
- Filter by status
- Filter by multiple fields
- Empty list handling

**Error Handling:**
- Storage failures
- Invalid invoice ID
- Non-existent invoice operations
- Corrupted JSON recovery

---

## Resiliency & Retries

To ensure reliable communication with external APIs, this backend implements a robust **Retry and Backoff** mechanism (`src/utils/retry.js`). 

### Key Features
- **Exponential Backoff (`withRetry`)**: Automatically retries transient errors (e.g., HTTP 429, 502, 503, 504, network timeouts).
- **Jitter**: Adds ±20% randomness to the delay to prevent thundering herd problems.
- **Security Caps**:
  - `maxRetries` is hard-capped at 10 to prevent unbounded retry loops.
  - `maxDelay` is hard-capped to 60,000ms (1 minute).
  - `baseDelay` is hard-capped to 10,000ms.
- **Contract Integration**: `src/services/soroban.js` wraps raw API calls securely with this utility, ensuring all escrow and invoice state interactions are fault-tolerant.

---

## CI/CD

GitHub Actions runs on every push and pull request to `main`:

- **Lint** — `npm run lint`
- **Build check** — `node --check src/index.js` (syntax)
- **Tests** — `npm test --coverage` (>95% coverage required)

Ensure your branch passes these before opening a PR.

---

## Contributing

1. **Fork** the repo and clone your fork.
2. **Create a branch** — `git checkout -b feature/your-feature`
3. **Write tests** — Ensure >95% coverage for new code
4. **Run tests** — `npm test`
5. **Lint code** — `npm run lint`
6. **Commit with clear messages** — Use conventional commit format
7. **Push and open PR** — Link related issues

### Commit Message Format

```
feat(api): implement persistent invoice create/list endpoints

- Add storage layer with atomic writes
- Add invoice validation and sanitization  
- Add comprehensive test suite (95%+ coverage)
- Document API and security considerations
```
2. **Create a branch** from `main`: `git checkout -b feature/your-feature` or `fix/your-fix`.
3. **Setup locally**: `npm ci`, optionally `cp .env.example .env`.
4. **Make changes**. Keep the style consistent:
   - Run `npm run lint` and fix any issues.
   - Use the existing Express/route patterns in `src/index.js`.
5. **Commit** with clear messages (e.g. `feat: add X`, `fix: Y`).
6. **Push** to your fork and open a **Pull Request** to `main`.
7. Wait for CI to pass and address any review feedback.

We welcome docs improvements, bug fixes, and new API endpoints aligned with the LiquiFact product (invoices, escrow, Stellar integration).

---

## License

MIT (see root LiquiFact project for full license).
