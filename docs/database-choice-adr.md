# ADR: Database Choice for Invoice Persistence

## Status
Accepted

## Context
The LiquiFact backend currently uses in-memory storage for invoices, which is insufficient for production. We need to persist invoice data with verification states (pending, approved, on_chain) and support filtering.

## Decision
We will use SQLite for development and testing, with PostgreSQL as the recommended production database.

## Rationale
- **Development Simplicity**: SQLite requires no server setup, making it ideal for local development and CI/CD pipelines.
- **Existing Setup**: The codebase uses Knex.js, which supports both SQLite and PostgreSQL with minimal changes.
- **Production Scalability**: PostgreSQL provides better concurrency, advanced features (JSONB, transactions), and is suitable for financial data in production.
- **Migration Path**: Easy to migrate from SQLite to PostgreSQL by changing the connection string and running migrations.
- **Testing**: SQLite is perfect for isolated, fast-running tests.

## Alternatives Considered
- **PostgreSQL Only**: More robust but requires server setup for development.
- **SQLite Only**: Sufficient for small-scale but not ideal for high-concurrency production.

## Consequences
- Use SQLite for development: `DATABASE_URL=sqlite:///db.sqlite3`
- Use PostgreSQL for production: `DATABASE_URL=postgresql://...`
- Environment variable `DATABASE_URL` controls the database type.
- Migrations are database-agnostic where possible.

## Idempotency Keys
Idempotency keys for POST /api/invoices are not implemented in this iteration. They can be added later using a unique constraint on a client-provided key stored in the database. The decision was made to keep the initial implementation simple and focus on core persistence functionality.</content>
<parameter name="filePath">/Users/mac/drips/Liquifact-backend/docs/database-choice-adr.md