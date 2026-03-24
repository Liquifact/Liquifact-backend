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
│   └── index.js    # Express app, routes (health, invoices, escrow)
├── .env.example   # Env template (PORT, Stellar, DB placeholders)
├── eslint.config.js
└── package.json
```

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

## RBAC (Role-Based Access Control)

This project uses a simple RBAC system.

### Roles
- admin
- operator
- user

### How it works
- Role is passed via `x-role` header (temporary simulation)
- Middleware enforces access control

### Protected Operations
- POST /api/invoices/:id/approve → admin, operator
- POST /api/escrow/:invoiceId/settle → admin only

### Example
curl -H "x-role: admin" http://localhost:3001/api/invoices
curl -X POST http://localhost:3001/api/invoices/123/approve -H "x-role: admin"
curl -X POST http://localhost:3001/api/escrow/123/settle -H "x-role: admin"

### Security Notes

- RBAC is enforced via middleware
- Roles are currently simulated via `x-role` header
- This is NOT secure for production
- Future implementation should extract roles from verified JWT tokens

## Invoice Status State Machine

Valid transitions:

draft → pending_verification  
pending_verification → approved | draft  
approved → funded  
funded → settled  
settled → closed  

Endpoint:
PATCH /api/invoices/:id/status

### Example
curl -X PATCH http://localhost:3001/api/invoices/123/status \
  -H "Content-Type: application/json" \
  -H "x-role: admin" \
  -d '{"currentStatus":"approved","nextStatus":"funded"}'

### Security Notes

- Transitions are strictly validated defensively against the `INVOICE_STATE_TRANSITIONS` policy map.
- Cannot bypass transitions via route handler since `invoiceStateGuard` triggers.
- Returns `400 Bad Request` or `403 Forbidden` according to the respective failure.

---

## License

MIT (see root LiquiFact project for full license).
