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

Default port: **3001**. After starting:

- Health: [http://localhost:3001/health](http://localhost:3001/health)
- API info: [http://localhost:3001/api](http://localhost:3001/api)

---

## Project structure

```
liquifact-backend/
├── src/
│   ├── services/
│   │   └── soroban.js       # Contract interaction wrappers
│   ├── utils/
│   │   └── retry.js         # Exponential backoff utility
│   ├── workers/
│   │   ├── queue.js         # In-memory job queue
│   │   └── worker.js        # Background job processor
│   └── index.js             # Express app, routes
├── .env.example             # Env template
├── eslint.config.js
└── package.json
```

---

## Resiliency & Retries

To ensure reliable communication with Soroban contract provider APIs, this backend implements a robust **Retry and Backoff** mechanism (`src/utils/retry.js`). 

### Key Features
- **Exponential Backoff (`withRetry`)**: Automatically retries transient errors (e.g., HTTP 429, 502, 503, 504, network timeouts).
- **Jitter**: Adds ±20% randomness to the delay to prevent thundering herd problems.
- **Security Caps**:
  - `maxRetries` is hard-capped at 10 to prevent unbounded retry loops.
  - `maxDelay` is hard-capped to 60,000ms (1 minute).
  - `baseDelay` is hard-capped to 10,000ms.
- **Contract Integration**: `src/services/soroban.js` wraps raw API calls securely with this utility, ensuring all escrow and invoice state interactions are fault-tolerant.

---

## Background Worker

For asynchronous task processing (e.g., webhook callbacks, account verification, retry logic), this backend provides a lightweight background worker abstraction implemented in `src/workers/`:

### Components

- **`JobQueue`** (`src/workers/queue.js`): In-memory job queue with state management
  - Type-safe job enrollment with metadata
  - Job status tracking (pending, processing, completed, failed)
  - Retry management with configurable max attempts (capped at 10)
  - Optional webhook notifications for job updates
  - Security: Validates job data size (max 1MB), webhook URLs, and prevents private IPs

- **`BackgroundWorker`** (`src/workers/worker.js`): Async job processor
  - Configurable concurrency (default 2, max 10) to prevent resource exhaustion
  - Job handlers registered per type with timeout enforcement (max 5 minutes)
  - Automatic retry on transient failures, respecting max attempts
  - Webhook notifications on job completion/failure/retry
  - Graceful shutdown with active job waiting

### Usage Example

```javascript
const { JobQueue } = require('./src/workers/queue');
const { BackgroundWorker } = require('./src/workers/worker');

// Create queue and worker
const queue = new JobQueue();
const worker = new BackgroundWorker(queue, {
  maxConcurrency: 2,
  jobTimeout: 30000,
  enableWebhooks: true,
});

// Register a handler
worker.registerHandler('verification', async (jobData) => {
  // Process verification (e.g., call external API)
  console.log('Processing verification for user:', jobData.userId);
  // ... handler logic
});

// Start worker (runs in background)
worker.start();

// Enqueue a job
const jobId = queue.enqueue('verification', 
  { userId: '123', email: 'user@example.com' },
  {
    maxAttempts: 3,
    webhookUrl: 'https://api.example.com/webhook/job-status'
  }
);

// Later: stop worker gracefully
await worker.stop();
```

### Security Considerations

- **Input Validation**: Job data is validated for size, type, and structure
- **Concurrency Limits**: Capped at 10 concurrent jobs to prevent resource exhaustion
- **Timeout Enforcement**: Handlers are forced to timeout after 5 minutes maximum
- **Webhook Security**: URL validation prevents SSRF attacks (blocks private IPs in production)
- **Retry Bounds**: Max attempts capped at 10, delay capped at 60 seconds
- **Error Isolation**: Failed jobs don't crash the worker; errors are logged and retry-managed
- **Audit Trail**: All job state changes are tracked with timestamps

### Testing

Full test coverage (96%+) for queue and worker behavior:

```bash
npm test src/workers/worker.test.js
```

Tests verify:
- Job enqueue, status updates, and retries
- Worker concurrency and timeout enforcement
- Error handling and recovery
- Webhook notification flow
- Security constraints (size limits, URL validation, etc.)

---

## CI/CD

GitHub Actions runs on every push and pull request to `main`:

- **Lint** — `npm run lint`
- **Build check** — `node --check src/index.js` (syntax)

Ensure your branch passes these before opening a PR.

---

## Contributing

1. **Fork** the repo and clone your fork.
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
