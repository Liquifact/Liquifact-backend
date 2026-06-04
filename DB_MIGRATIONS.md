# Database Migrations

This project uses multiple migration systems to support development (SQLite) and production (Postgres) workflows. The purpose of this document is to describe the canonical migration workflow so contributors apply migrations consistently and avoid schema drift.

Key components
--------------

- `knexfile.js` — configuration used by some local tooling and historic JS migrations; not the primary runner for production migrations.
- `migrator-config.js` + `node-pg-migrate` — the authoritative runner for Postgres migrations (SQL files under `migrations/` and JS migrations created for node-pg-migrate).
- `migrations/*.sql` — canonical SQL migrations targeting Postgres features (JSONB, append-only triggers, indexes).
- `migrations/001_create_invoices_table.js` — legacy JS migration (knex-style); kept for historical reasons. New schema changes should prefer SQL or node-pg-migrate JS format and be added to the Postgres runner.
- `src/db/migrations/*.js` — helper migration scripts used by local tooling; they are not authoritative for production.
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
 # Migrations

 This project uses multiple migration systems to support development (SQLite) and production (Postgres) workflows. The purpose of this document is to describe the canonical migration workflow so contributors apply migrations consistently and avoid schema drift.

 Key components
 --------------

 - `knexfile.js` — configuration used by some local tooling and historic JS migrations; not the primary runner for production migrations.
 - `migrator-config.js` + `node-pg-migrate` — the authoritative runner for Postgres migrations (SQL files under `migrations/` and JS migrations created for node-pg-migrate).
 - `migrations/*.sql` — canonical SQL migrations targeting Postgres features (JSONB, append-only triggers, indexes).
 - `migrations/001_create_invoices_table.js` — legacy JS migration (knex-style); kept for historical reasons. New schema changes should prefer SQL or node-pg-migrate JS format and be added to the Postgres runner.
 - `src/db/migrations/*.js` — helper migration scripts used by local tooling; they are not authoritative for production.
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

 Important guidance
 ------------------

 - Do not modify `db.sqlite3` to propagate schema changes. Instead author migrations and run them against Postgres; if local dev requires a refreshed SQLite, re-create it from migrations but treat Postgres as the source of truth.
 - Prefer SQL or `node-pg-migrate` JS migrations over legacy `knex` JS files.
 - Keep migrations idempotent and reversible (`down` migration) where possible.

 FAQ
 ---

 Q: Why are there both SQL and JS migrations?

 A: SQL files are explicit and map closely to Postgres features; JS migrations (node-pg-migrate) are used for logic that requires programmatic changes. Both run under the Postgres runner.

