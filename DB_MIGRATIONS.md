# Database Migrations

This project uses multiple migration systems to support development (SQLite) and production (Postgres) workflows. The purpose of this document is to describe the canonical migration workflow so contributors apply migrations consistently and avoid schema drift.

Key components
--------------

- `knexfile.js` — configuration used by some local tooling and historic JS migrations; not the primary runner for production migrations.
- `migrator-config.js` + `node-pg-migrate` — the authoritative runner for Postgres migrations (SQL files under `migrations/` and JS migrations created for node-pg-migrate).
- `migrations/*.sql` — canonical SQL migrations targeting Postgres features (JSONB, append-only triggers, indexes).
- `migrations/001_create_invoices_table.js` — legacy JS migration (knex-style); kept for historical reasons. New schema changes should prefer SQL or node-pg-migrate JS format and be added to the Postgres runner.
- `src/db/migrations/*.js` — helper migration scripts used by local tooling; they are not authoritative for production.

### Migration inventory

| File | Type | Runner | Notes |
|------|------|--------|-------|
| `001_create_invoices_table.js` | JS | **Knex** (legacy) | Historical migration, kept for backward compatibility |
| `20240101000000_initial_schema.sql` | SQL | **node-pg-migrate** | Initial schema creation |
| `20240425000000_create_invoices_table.sql` | SQL | **node-pg-migrate** | Creates invoices table |
| `20240425000001_create_users_and_tenants.sql` | SQL | **node-pg-migrate** | User & tenant tables |
| `20240425000002_add_tenant_to_invoices.sql` | SQL | **node-pg-migrate** | Adds tenant_id foreign key |
| `20240425000003_create_escrow_operations.sql` | SQL | **node-pg-migrate** | Escrow operations schema |
| `20240426000000_add_marketplace_fields_to_invoices.sql` | SQL | **node-pg-migrate** | Marketplace fields |
| `20240426000000_create_audit_logs_table.sql` | SQL | **node-pg-migrate** | Audit log table |
| `20250425000000_create_retention_system.sql` | SQL | **node-pg-migrate** | Retention system tables |
| `202604260001_create_audit_log_events.sql` | SQL | **node-pg-migrate** | Audit log events |
| `202604260002_enforce_audit_log_append_only.sql` | SQL | **node-pg-migrate** | Enforces append‑only audit log (trigger) |
| `20260427123000_create_escrow_event_index_tables.sql` | SQL | **node-pg-migrate** | Index tables for escrow events |
| `20260429000000_create_reconciliation_runs.js` | JS | **node-pg-migrate** | Reconciliation run logic |
| `20260601000000_create_idempotency_keys.sql` | SQL | **node-pg-migrate** | Idempotency keys table |
| `20260601000001_create_investor_commitments.js` | JS | **node-pg-migrate** | Investor commitments |
| `20260602000000_create_webhook_dead_letters.sql` | SQL | **node-pg-migrate** | Dead‑letter queue for webhooks |
| `20260625000000_create_background_jobs.sql` | SQL | **node-pg-migrate** | Durable backing for job queue (opt-in via `JOB_QUEUE_PERSISTENCE_ENABLED`) |

**Authoritative scripts**
- `npm run db:setup` → runs `node-pg-migrate up` (same as `db:migrate`).
- `npm run db:migrate` → runs `node-pg-migrate up`.
- `npm run db:migrate:down` → runs `node-pg-migrate down`.
- `npm run db:rollback` → legacy `knex migrate:rollback` (only affects the old `001_create_invoices_table.js` if ever used).

**Local setup walkthrough**
```bash
# Start PostgreSQL via Docker
docker-compose -f docker-compose.dev.yml up -d
# Export DATABASE_URL (or copy .env.example to .env and edit)
cp .env.example .env
# Run migrations
npm run db:setup
```
- `db.sqlite3` — a developer convenience SQLite database used for quick local iteration. This file is not the source of truth for schema or production migrations.

Authoritative migration runner
------------------------------

The canonical migration runner for production is `node-pg-migrate` (configured via `migrator-config.js`). New migrations must be authored to run under `node-pg-migrate` and tested against a Postgres instance. This runner is used in CI and deployment pipelines to ensure consistent ordering and behavior.

Why Postgres is authoritative
-----------------------------

- Production uses Postgres and relies on Postgres-only features: `JSONB` columns, append-only triggers for audit logs, `BIGSERIAL` primary keys, and advanced index types. These features do not translate exactly to SQLite.
- Using Postgres in CI and local testing ensures migrations exercise the same semantics as production (e.g., JSONB indexes and constraints).

Local development with SQLite
----------------------------

- `db.sqlite3` is provided for fast local iteration and lightweight tests. It is convenient, but it diverges from Postgres in several important ways (types, constraints, triggers, indexes). DO NOT treat the SQLite schema file as the canonical schema.
- When developing a migration locally, test it against both SQLite (if needed for quick iteration) and Postgres (recommended) before submitting a PR.

Test environment database isolation
------------------------------------

`src/db/knex.js` enforces strict environment isolation:

- **NODE_ENV=test** always resolves to the `test` block in `knexfile.js`.
  The test block uses SQLite `:memory:`, so tests never touch a shared file
  or network database. There is **no fallback** to development or production
  config — if the `test` block is missing, the factory throws immediately.

- **NODE_ENV=production** requires `DATABASE_URL` to be set; the factory
  throws if it is absent, preventing accidental connections to a default host.

- **Pool error handlers** are attached to every Knex instance so connection
  failures surface in application logs rather than as unhandled rejections.

Most unit tests should mock `src/db/knex` via Jest's manual mock at
`src/db/__mocks__/knex.js`. The real Knex factory is used only in integration
tests that need genuine SQLite behaviour.

Connection pool configuration
------------------------------

The factory in `src/db/knex.js` applies these defaults to every environment
(values can be overridden per-environment in `knexfile.js` via a `pool` key):

| Setting | Default | Notes |
|---------|---------|-------|
| `min` | 2 | Minimum idle connections |
| `max` | 10 | Maximum concurrent connections |
| `createTimeoutMillis` | 30 000 | Timeout for new connection creation |
| `acquireTimeoutMillis` | 30 000 | Timeout to acquire a connection |
| `idleTimeoutMillis` | 600 000 | Idle connection lifetime |
| `reapIntervalMillis` | 1 000 | Idle-connection reap interval |

The `test` block overrides `max: 1` to keep the in-memory SQLite serialised.

Recommended workflow (creating and applying migrations)
------------------------------------------------------

1. Create a new migration (prefer SQL or node-pg-migrate JS):

	 - SQL: create a new file in `migrations/` using the established naming convention (`YYYYMMDDHHMMSS_description.sql`).
	 - JS (node-pg-migrate): use `node-pg-migrate create description --migrations-dir migrations` and author `exports.up`/`exports.down` in the generated file.

2. Run against a local Postgres to validate (recommended):

	 - Start a local Postgres (Docker recommended):

		 ```powershell
		 docker run --rm -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=liquifact -p 5432:5432 -d postgres:15
		 ```

	 - Configure `DATABASE_URL` or the appropriate `.env` values to point to your local Postgres.

	 - Run migrations (node-pg-migrate):

		 ```bash
		 npx node-pg-migrate up -d migrator-config.js
		 ```

3. Validate the schema and any Postgres-specific features (JSONB, triggers, indexes).

4. Run the test suite (CI will run migrations against Postgres as part of integration):

	 ```bash
	 npm test
	 npm run test:coverage
	 ```

Commands reference
------------------

- Create a node-pg-migrate migration:
	```bash
	npx node-pg-migrate create add_some_table -d migrations --migrations-dir migrations
	```
- Apply migrations (up):
	```bash
	npx node-pg-migrate up -d migrator-config.js
	```
- Rollback last batch (down):
	```bash
	npx node-pg-migrate down -d migrator-config.js
	```
- Reset (drop and re-run):
	```bash
	npx node-pg-migrate reset -d migrator-config.js
	```

CI notes
--------

- CI should run migrations against a Postgres test database (not SQLite). Use the same `node-pg-migrate` commands as above.
- The pipeline should seed any required test data after migration.
- Unit tests use the Jest manual mock (`src/db/__mocks__/knex.js`) and never touch a real DB.

Important guidance
------------------

- Do not modify `db.sqlite3` to propagate schema changes. Instead author migrations and run them against Postgres; if local dev requires a refreshed SQLite, re-create it from migrations but treat Postgres as the source of truth.
- Prefer SQL or `node-pg-migrate` JS migrations over legacy `knex` JS files.
- Keep migrations idempotent and reversible (`down` migration) where possible.

FAQ
---

Q: Why are there both SQL and JS migrations?

A: SQL files are explicit and map closely to Postgres features; JS migrations (node-pg-migrate) are used for logic that requires programmatic changes. Both run under the Postgres runner.

Q: Why does `src/db/knex.js` throw when the test config block is missing?

A: Silent fallback to a development or production database during tests is a data-safety hazard. An explicit error surfaces misconfiguration immediately rather than silently writing test data to a shared DB.

Q: How do I add per-worker schema isolation for parallel tests?

A: Jest's `--runInBand` flag serialises workers (one process). If you move to parallel workers in the future, override the `test.connection.filename` per worker using Jest's `workerIdleMemoryLimit` + a `globalSetup` script that sets `TEST_WORKER_ID` and appends it to `:memory:` or a worker-scoped SQLite path.
