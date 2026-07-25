# Requirements Document

## Introduction

This feature refactors the `listInvestments` function in `src/services/investService.js` and its corresponding `GET /api/invest/opportunities` route in `src/routes/invest.js`. The current implementation uses a raw `invoiceId` string as a plain-text, unsigned cursor with only a soft page-size cap. This refactor replaces that with opaque, HMAC-signed keyset cursors (reusing the existing `encodeCursor`/`decodeCursor` infrastructure from `src/utils/cursorPagination.js`), enforces a bounded page size at the service layer, and adds standardized 400 error handling for invalid cursors. Existing consumers are preserved: response keys remain snake_case (`next_cursor`, `has_more`), item shape is unchanged, and the route path is unchanged.

## Glossary

- **InvestService**: The module at `src/services/investService.js` that contains `listInvestments` and related functions.
- **InvestRoute**: The Express router at `src/routes/invest.js` that exposes `GET /api/invest/opportunities`.
- **CursorPagination**: The utility module at `src/utils/cursorPagination.js` providing `encodeCursor`, `decodeCursor`, and `CursorError`.
- **Opaque Cursor**: A base64url-encoded, HMAC-SHA256-signed string that encodes keyset pagination state without exposing raw database IDs to consumers.
- **CursorError**: The domain error class thrown by `decodeCursor` when a cursor is malformed, tampered, has a wrong sort field, or is expired.
- **Keyset Pagination**: A pagination strategy that uses a stable, indexed column value from the last row of the current page to determine the start of the next page, rather than a row OFFSET.
- **Page Size**: The number of items returned per response page, bounded between 1 and 100.
- **HMAC**: Hash-based Message Authentication Code; used here with SHA-256 to sign cursor payloads so tampering is detectable.
- **InvestmentOpportunity**: The DTO shape returned in each element of the `data` array: `{ invoiceId, fundedBpsOfTarget, maturityAt, yieldBpsDisplay, onChain: { escrowAddress, ledgerIndex, ...enrichedFields } }`.
- **Tenant**: An authenticated organizational unit whose `tenantId` scopes all database queries.

---

## Requirements

### Requirement 1: Opaque HMAC-Signed Cursor Encoding

**User Story:** As a backend engineer, I want `listInvestments` to produce opaque, HMAC-signed cursors, so that raw database IDs are never exposed to consumers and cursor tampering is detectable.

#### Acceptance Criteria

1. WHEN `listInvestments` returns a non-empty page, THE InvestService SHALL encode the next cursor using `encodeCursor({ sortField: 'id', sortValue: lastId, id: lastId })` from CursorPagination.
2. WHEN `listInvestments` returns an empty page or the last page, THE InvestService SHALL set `meta.next_cursor` to `null` regardless of any pagination state previously computed.
3. WHEN `listInvestments` returns zero items after applying tenant, status, and keyset filters, THE InvestService SHALL set `meta.next_cursor` to `null` without calling `encodeCursor`.
3. THE InvestService SHALL NOT expose raw `invoiceId` strings directly as cursor values in `meta.next_cursor`.
4. WHEN a valid opaque cursor is supplied as input, THE InvestService SHALL pass it to `decodeCursor(cursor, 'id')` to extract the keyset position before executing the database query.
5. WHEN `decodeCursor` returns successfully, THE InvestService SHALL apply `WHERE id > decodedId` to the database query to resume from the correct page position.

---

### Requirement 2: Page Size Bounding and Clamping

**User Story:** As a backend engineer, I want the service layer to enforce a hard page-size ceiling, so that no single request can retrieve an unbounded number of records regardless of the `limit` value supplied.

#### Acceptance Criteria

1. THE InvestService SHALL apply a default page size of 20 when no `limit` parameter is provided.
2. WHEN the `limit` parameter is greater than 100, THE InvestService SHALL silently clamp it to 100.
3. WHEN the `limit` parameter is less than or equal to 0, THE InvestService SHALL use a page size of 20.
4. WHEN `limit` is between 1 and 100 inclusive, THE InvestService SHALL use the provided value as the page size.
5. THE InvestService SHALL set `meta.limit` in the response to the clamped page size actually used, not the raw input value.
6. THE InvestService SHALL perform all page-size clamping within the service layer, not the route layer.

---

### Requirement 3: Response Wrapper Invariance

**User Story:** As an existing API consumer, I want the response envelope shape and key names to remain unchanged, so that I do not need to update my client code after this refactor.

#### Acceptance Criteria

1. THE InvestService SHALL include `meta.next_cursor` (string or null) in every response from `listInvestments`.
2. THE InvestService SHALL include `meta.has_more` (boolean) in every response from `listInvestments`.
3. THE InvestService SHALL include `meta.limit` (number — the clamped limit used) in every response from `listInvestments`.
4. THE InvestService SHALL include `meta.count` (number — the count of items in the current page) in every response from `listInvestments`.
5. THE InvestService SHALL set `meta.has_more` to `true` when the number of items returned equals the clamped limit and at least one more record may exist.
6. THE InvestService SHALL set `meta.has_more` to `false` when the number of items returned is less than the clamped limit.

---

### Requirement 4: Item Schema Invariance

**User Story:** As an existing API consumer, I want the shape of each item in the `data` array to remain unchanged, so that my client-side deserialization logic continues to work without modification.

#### Acceptance Criteria

1. THE InvestService SHALL include `invoiceId` (string) on every item in the `data` array.
2. THE InvestService SHALL include `fundedBpsOfTarget` (number) on every item in the `data` array.
3. THE InvestService SHALL include `maturityAt` (ISO string or null) on every item in the `data` array.
4. THE InvestService SHALL include `yieldBpsDisplay` (number or null) on every item in the `data` array.
5. THE InvestService SHALL include `onChain` (object) with at least `escrowAddress` and `ledgerIndex` fields on every item in the `data` array.
6. THE InvestService SHALL NOT add, remove, or rename any top-level fields on individual item objects returned in the `data` array.

---

### Requirement 5: Invalid Cursor Handling

**User Story:** As an API consumer, I want a clear, structured error response when I submit a malformed or tampered cursor, so that I can distinguish a cursor error from other failures and know to start pagination from the first page.

#### Acceptance Criteria

1. WHEN `decodeCursor` throws a `CursorError`, THE InvestRoute SHALL return HTTP 400.
2. WHEN returning HTTP 400 for a cursor error, THE InvestRoute SHALL include `error.code` set to `"INVALID_CURSOR"` in the response body.
3. WHEN returning HTTP 400 for a cursor error, THE InvestRoute SHALL include `error.message` containing the human-readable description from the `CursorError` instance.
4. WHEN returning HTTP 400 for a cursor error, THE InvestRoute SHALL include `error.retryable` set to `false` in the response body.
5. IF a `CursorError` is thrown, THEN THE InvestRoute SHALL NOT propagate it to the global error handler as an unhandled exception.
6. WHEN a cursor string is absent from the request, THE InvestRoute SHALL pass `undefined` as the cursor to `listInvestments` and THE InvestService SHALL execute an unconstrained first-page query.

---

### Requirement 6: First-Page and Empty-Set Behavior

**User Story:** As an API consumer, I want predictable behavior on the first request (no cursor) and when there are no results, so that my pagination loop terminates correctly.

#### Acceptance Criteria

1. WHEN no `cursor` query parameter is present, THE InvestService SHALL return records ordered by `id ASC` starting from the first record that matches the tenant and status filters.
2. WHEN no matching records exist for the tenant and status filters, THE InvestService SHALL return `data: []`, `meta.next_cursor: null`, `meta.has_more: false`, and `meta.count: 0`.
3. WHEN `listInvestments` is called without a cursor and the total number of matching records is less than the clamped limit, THE InvestService SHALL return all matching records with `meta.has_more: false` and `meta.next_cursor: null`.

---

### Requirement 7: Exact-Page Boundary Behavior

**User Story:** As an API consumer, I want correct `has_more` and `next_cursor` values at exact page boundaries, so that my pagination loop neither drops the last page nor loops infinitely.

#### Acceptance Criteria

1. WHEN the total number of matching records is an exact multiple of the page size, THE InvestService SHALL return `meta.has_more: true` and a non-null `meta.next_cursor` on every page except the last.
2. WHEN the last page contains exactly as many items as the page size but no further records exist, THE InvestService SHALL detect this and return `meta.has_more: false` with `meta.next_cursor: null` on that final page.
3. THE InvestService SHALL use a fetch-one-extra strategy (fetch `limit + 1` rows) to determine whether more records exist without issuing a separate COUNT query.

---

### Requirement 8: Tenant Isolation Invariance

**User Story:** As a security-conscious engineer, I want the opaque cursor refactor to preserve existing tenant-scoping guarantees, so that no cursor value can be used to retrieve records belonging to a different tenant.

#### Acceptance Criteria

1. THE InvestService SHALL apply `WHERE tenant_id = tenantId` to every database query regardless of cursor content.
2. THE InvestService SHALL apply `WHERE deleted_at IS NULL` to every database query regardless of cursor content.
3. THE InvestService SHALL apply the `PUBLIC_INVESTABLE_INVOICE_STATUSES` status filter to every database query regardless of cursor content.
4. WHEN a cursor encodes a record ID that belongs to a different tenant, THE InvestService SHALL return an empty page rather than cross-tenant records, because the tenant filter takes precedence over the keyset position.

---

### Requirement 9: Test Coverage

**User Story:** As a backend engineer, I want comprehensive unit tests for the refactored `listInvestments` and the `/opportunities` route handler, so that regressions are caught automatically.

#### Acceptance Criteria

1. THE Test_Suite SHALL replace all stub tests in `src/tests/pagination.test.js` with real implementations covering the behaviors defined in Requirements 1–8.
2. WHEN testing `listInvestments`, THE Test_Suite SHALL mock the `db` (knex) query builder and `batchReadEscrowStates` to remain unit-level without requiring a live database.
3. THE Test_Suite SHALL include a test that verifies a `limit` of 1000 is silently clamped to 100 and that `meta.limit` equals 100 in the response.
4. THE Test_Suite SHALL include a test that verifies an empty result set returns `data: []`, `meta.next_cursor: null`, `meta.has_more: false`, and `meta.count: 0`.
5. THE Test_Suite SHALL include a test that verifies a malformed cursor string causes the route handler to return HTTP 400 with `error.code === "INVALID_CURSOR"`, and WHEN the cursor fails for any reason including tampering or expiry, THE InvestRoute SHALL always return HTTP 400 rather than any other error status.
6. THE Test_Suite SHALL include a test that verifies the exact-page boundary scenario (total equals a multiple of limit) produces correct `has_more` and `next_cursor` values.
7. THE Test_Suite SHALL include a test that verifies first-page behavior (no cursor) returns records ordered by `id ASC` and includes a non-null `meta.next_cursor` when more records exist.
8. THE Test_Suite SHALL achieve a minimum of 95% line and branch coverage on `src/services/investService.js` (the `listInvestments` function) and the `/opportunities` handler in `src/routes/invest.js`.
