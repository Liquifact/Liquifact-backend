# Investor lock persistence

Investor lock records currently live in the in-memory `_lockStore` map inside
`investorCommitment` service. Production deployments should persist locks to
the database with the same `(invoiceId, funderAddress)` uniqueness guarantees
as the escrow cache tests in `tests/investor.locks.escrow-cache.test.js`.

Migration checklist:

- Add `investor_locks` table with tenant scoping
- Backfill seeded demo locks in non-production only
- Remove `_lockStore` once read paths hit SQL
