# Pull Request: Protect API Key Registry State Invariants

Closes #1273

## Summary

Harden `src/config/apiKeys.js` so registry construction validates every entry, rejects duplicate normalized keys, and stores an immutable snapshot of each validated API key entry. This prevents input objects and scope arrays from changing authorization after registry construction.

## Changes

- Keep the existing `Map<string, ApiKeyEntry>` registry interface and rebuild it from the current environment on each load.
- Validate direct `buildKeyRegistry` inputs as well as entries produced by `parseApiKeys`; reject non-array input deterministically.
- Build the registry in a local map and return it only after every candidate passes validation. Duplicate detection runs against normalized keys.
- Copy and freeze registry entries and their scopes so later source mutation cannot alter client identity, revocation, or permissions.
- Keep the exported `KNOWN_ENTRY_FIELDS` Set for compatibility while isolating validation from external mutation. Freeze the recognized scopes list to prevent callers from expanding allowed permissions at runtime.
- Preserve the mutable return shape of `validateEntry` and `parseApiKeys`; immutability is applied when the registry takes ownership of an entry.
- Add regressions for source mutation, invalid direct inputs, and attempts to weaken field validation through the exported Set.

## Invariant and failure handling

The registry contains only validated entries, each key maps to one entry, and the authorization attributes captured at construction cannot be changed through input aliases. A malformed or duplicate candidate throws before a registry is returned, so callers cannot observe partial state. Existing authentication still rejects unknown, revoked, and under-scoped keys through the existing middleware.

No key value is added to error messages or logs by this change. Existing diagnostics for validation and duplicate configuration remain intact.

## Acceptance criteria mapping

| Criterion | Implementation and evidence |
| --- | --- |
| Deterministic valid, invalid, duplicate, and boundary inputs | Existing parsing and validation rules remain; registry validates direct inputs and checks normalized duplicates. Existing boundary tests remain in `tests/unit/apiKeyValidation.test.js`; direct-input cases are in `tests/unit/apiKeyAuth.test.js`. |
| Authorization and validation invariants | Private field allowlist, frozen scope list, and immutable registry snapshots protect accepted scopes and revocation state. |
| Retries, partial failure, and concurrency | Registry construction is synchronous and local; failed builds return no partial registry. Independent loads create independent snapshots from their supplied environment. |
| Focused tests | Added regression tests in `tests/unit/apiKeyAuth.test.js` and `tests/unit/apiKeyValidation.test.js`. |
| Caller compatibility | Existing exports and Map shape remain; `validateEntry`/`parseApiKeys` values remain mutable as before. |
| Diagnosable failures without secret exposure | Existing indexed validation errors and duplicate-key error remain; key material is not included. |

## Verification

- `node --check src/config/apiKeys.js` — passed.
- `git diff --check` — passed.
- Focused Jest suites were attempted with `npm test -- --runTestsByPath tests/unit/apiKeyAuth.test.js tests/unit/apiKeyValidation.test.js`, but could not start because Jest is not installed in this checkout (`sh: 1: jest: not found`). CI verification is still required.
