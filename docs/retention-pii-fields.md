# Retention PII field configuration

The retention purge job scrubs sensitive columns before hard-deleting aged rows.
Configure the field list via environment so new PII columns are not missed:

- `RETENTION_PII_FIELDS` — comma-separated column names (e.g. `email,phone,legal_name`)
- Defaults cover user profile, invoice counterparty, and webhook callback URLs

When adding a migration that stores personal data, append the column to the
configured list and extend `tests/retention.redaction.test.js`.

See also `docs/retention.md` for dry-run and audit log behaviour.
