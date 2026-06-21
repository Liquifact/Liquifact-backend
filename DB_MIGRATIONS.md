# Database Migration Workflow

Liquifact keeps both PostgreSQL and local-development migration tooling in the
repository. This guide defines the canonical workflow so contributors can add,
apply, review, and roll back schema changes without creating drift between
local SQLite helpers and the production PostgreSQL schema.

## Canonical Runner

Use `node-pg-migrate` for all production PostgreSQL schema changes.

- `migrator-config.js` points `node-pg-migrate` at the `migrations/` directory.
- `npm run db:setup` and `npm run db:migrate` both run `node-pg-migrate up`.
- `npm run db:migrate:down` runs `node-pg-migrate down`.
- `npm run db:migrate:create <name>` creates a new migration file.
- `npm run db:migrate:reset` resets and reapplies the migration set.

`knexfile.js` and `npm run db:rollback` remain for legacy/local workflows, but
new migrations should not depend on Knex as the primary runner. Prefer
`db:migrate:down` when documenting or testing rollback behavior for new changes.

## Migration Systems In This Repo

| Location or file | Purpose | Ownership |
| --- | --- | --- |
| `migrator-config.js` | Configuration for `node-pg-migrate` environments | Authoritative for PostgreSQL migrations |
| `migrations/*.sql` | SQL-first PostgreSQL migrations | Preferred for schema changes that map cleanly to SQL |
| `migrations/*.js` | Programmatic migrations run from the main migration directory | Allowed when a migration needs JavaScript logic |
| `migrations/001_create_invoices_table.js` | Older Knex-style migration kept for history | Legacy; do not copy for new work |
| `knexfile.js` | Knex configuration for legacy/local tooling and seeds | Compatibility only |
| `src/db/migrations/*.js` | App/local helper migrations | Not authoritative for production schema |
| `db.sqlite3` | Local convenience database when present | Never treat as the source of truth |

## Recommended Command Order

Start from a clean environment and run the canonical setup before developing a
database-backed change:

```bash
npm install
cp .env.example .env
# Set DATABASE_URL to a local PostgreSQL database.
npm run db:setup
npm test
```

For day-to-day migration work:

```bash
# Apply all pending migrations.
npm run db:migrate

# Roll back the most recent node-pg-migrate migration.
npm run db:migrate:down

# Create a new migration.
npm run db:migrate:create add_new_table

# Reset the database in a disposable local/test database.
npm run db:migrate:reset
```

Avoid `npm run db:rollback` for new migration documentation. It uses Knex and is
kept only for historical compatibility with older local workflows.

## Creating A New Migration

1. Choose the right format.
   - Use SQL in `migrations/YYYYMMDDHHMMSS_description.sql` for straightforward
     DDL, indexes, triggers, constraints, and extensions.
   - Use `node-pg-migrate` JavaScript in `migrations/` when the change needs
     programmatic branching or data backfill logic.
2. Include both forward and rollback behavior.
   - SQL migrations should be written so reviewers can identify the matching
     rollback path or operational undo steps.
   - JavaScript migrations should provide both `up` and `down` exports.
3. Test on PostgreSQL, not only SQLite.
   - Production relies on PostgreSQL features such as `JSONB`, `BIGSERIAL`,
     triggers, constraints, and index behavior that SQLite does not fully match.
4. Update documentation when the workflow or required environment variables
   change.

## Existing Migration Inventory

| Migration | Scope |
| --- | --- |
| `001_create_invoices_table.js` | Legacy Knex-style invoice table migration |
| `20240101000000_initial_schema.sql` | Initial invoice-management schema |
| `20240425000000_create_invoices_table.sql` | PostgreSQL invoice table |
| `20240425000001_create_users_and_tenants.sql` | Users and tenants |
| `20240425000002_add_tenant_to_invoices.sql` | Tenant linkage for invoices |
| `20240425000003_create_escrow_operations.sql` | Escrow operation tables |
| `20240426000000_add_marketplace_fields_to_invoices.sql` | Marketplace invoice fields |
| `20240426000000_create_audit_logs_table.sql` | Invoice state audit logs |
| `20250425000000_create_retention_system.sql` | Retention policies and legal holds |
| `202604260001_create_audit_log_events.sql` | Append-only audit event ledger |
| `202604260002_enforce_audit_log_append_only.sql` | Database-level append-only enforcement |
| `20260427123000_create_escrow_event_index_tables.sql` | Escrow event index tables |
| `20260429000000_create_reconciliation_runs.js` | Reconciliation run persistence |
| `20260601000000_create_idempotency_keys.sql` | Idempotency key storage |
| `20260601000001_create_investor_commitments.js` | Investor commitment storage |
| `20260602000000_create_webhook_dead_letters.sql` | Webhook dead-letter queue |

`src/db/migrations/20260425_add_kyc_status.js` is a local/application helper
migration and should not be considered part of the canonical production
migration history.

## Local PostgreSQL Setup

Use any local PostgreSQL service that exposes a database matching
`DATABASE_URL`. A disposable Docker instance is enough for migration validation:

```bash
docker run --rm \
  --name liquifact-postgres \
  -e POSTGRES_PASSWORD=pass \
  -e POSTGRES_DB=liquifact_dev \
  -p 5432:5432 \
  postgres:15
```

Then set:

```bash
DATABASE_URL=postgresql://postgres:pass@localhost:5432/liquifact_dev
```

Apply migrations with:

```bash
npm run db:migrate
```

## CI And Deployment Notes

- Run migrations against PostgreSQL in CI and deployment environments.
- Use the same `node-pg-migrate` command path as local development:
  `npm run db:migrate`.
- Run seeds only after schema migrations have completed successfully.
- Never deploy a migration that was validated only against SQLite.
- Treat `db:migrate:reset` as a disposable local/test command only. Do not use it
  against shared staging or production databases.

## Reviewer Checklist

- The migration lives in `migrations/` and is ordered by timestamp.
- The migration was tested with `npm run db:migrate` against PostgreSQL.
- Rollback behavior was tested with `npm run db:migrate:down` or documented as
  an explicit operational rollback when a destructive reverse migration is not
  safe.
- The change avoids editing `db.sqlite3` as a schema source.
- Any new required environment variables are documented in `.env.example` and
  relevant setup docs.
- Application tests or focused database tests cover the schema change when
  behavior changes.

## Troubleshooting

### `DATABASE_URL` is missing

Set `DATABASE_URL` in `.env` or the shell before running migration commands.
`migrator-config.js` falls back to local database names for development and
test, but explicit URLs make CI and local debugging easier to reason about.

### Migration succeeds locally but fails in CI

Confirm the local run used PostgreSQL. SQLite may accept different types,
constraints, or index definitions and should not be used as the final migration
validation target.

### Rollback uses a different tool

Use `npm run db:migrate:down` for node-pg-migrate rollback checks. The
`db:rollback` script invokes Knex and exists only for legacy compatibility.

### Duplicate or conflicting timestamps

Create a fresh timestamped migration and keep the earlier committed history in
place. Do not rename already-merged migration files unless the team explicitly
coordinates a migration-history rewrite.
