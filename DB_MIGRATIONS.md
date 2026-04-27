# Database Migrations

## Quick Start

```bash
docker-compose -f docker-compose.dev.yml up -d
npm run db:migrate
```

## Migration Commands

| Command | Description |
|---------|-------------|
| `npm run db:migrate` | Run all pending migrations |
| `npm run db:migrate:down` | Roll back the last migration |
| `npm run db:migrate:create <name>` | Create a new migration file |
| `npm run db:migrate:reset` | Reset database (drop & re-run all) |
| `npm run db:setup` | Initial database setup |

## Database Schema

### invoices

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| amount | NUMERIC(18,7) | Invoice amount |
| buyer | VARCHAR(255) | Buyer name |
| seller | VARCHAR(255) | Seller name |
| currency | CHAR(3) | ISO 4217 currency code |
| status | VARCHAR(50) | Invoice status |
| due_date | DATE | Payment due date |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |
| deleted_at | TIMESTAMPTZ | Soft delete timestamp |
| tenant_id | UUID | Tenant identifier |

## Production Deployment

1. Ensure `DATABASE_URL` is set in the environment.
2. Run `npm run db:migrate` before starting the service.
3. Migrations are transactional — a failed migration rolls back automatically.
4. Never run `db:migrate:reset` in production.

## Troubleshooting

- **Migration fails**: Check `DATABASE_URL` and database connectivity.
- **Duplicate migration**: Each migration file must have a unique timestamp prefix.
- **Rollback**: Use `npm run db:migrate:down` to revert the last migration.
