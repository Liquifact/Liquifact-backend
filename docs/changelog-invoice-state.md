# Changelog: Invoice State API

All notable changes to the `invoice-state` API will be documented in this file.

**Note to contributors:** Please update this changelog as part of any PR that introduces changes to the `invoice-state` API (features, bug fixes, or notable refactors).

## Recent Changes

* **Refactor:** Extract service layer for invoice-state (Commit `995c5224`)
* **Feature:** Add rate limiting to invoice-state (Commit `60b55a43`)
* **Feature:** Add cursor pagination for invoice-state endpoints (Commit `d1211c13`)
* **Feature:** Persist transitions to the database with tenant scoping (Commit `56069ea9`)
* **Feature:** Implement full transition matrix, route handlers, and audit logging (Commit `66f6ab39`)
* **Feature:** Validate and bound request inputs (Commit `f3656ccb`)
* **Documentation:** Document the API contract (Commit `f673c18e`)
