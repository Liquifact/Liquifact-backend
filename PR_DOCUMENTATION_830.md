# Pull Request: Document the API Keys Request Lifecycle End-to-End

## Description
This PR resolves **Issue #830** by adding comprehensive documentation for the API keys request lifecycle in the LiquiFact backend. The goal is to provide new contributors with a clear, end-to-end view of how an API key is validated, authenticated, and utilized by downstream handlers.

## Changes Made
### 1. New Documentation (`docs/api-keys-flow.md`)
Created a new technical overview document containing:
- **Architecture Diagram**: A Mermaid sequence diagram detailing the request flow through the system.
- **Validation and Persistence**: Explains the transition from a SQLite-backed database to an environment-backed registry (`API_KEYS`), highlighting validation rules (`src/config/apiKeys.js`) and startup enforcement.
- **Authentication Middleware**: Documents the exact sequence in `src/middleware/apiKeyAuth.js`, including presence checks, constant-time lookups (via `timingSafeStringEqual`), revocation processing, and scope checks.
- **Handler Execution**: Illustrates how downstream handlers utilize the authenticated `req.apiClient` object for operations such as auditing without exposing raw keys.
- **Key Rotation**: Provides a step-by-step guide for performing zero-downtime key rotation using the environment-backed approach.

## Verification
- The documentation accurately reflects the current state of the codebase.
- The Mermaid diagram renders correctly.
- This is a documentation-only PR; existing tests cover the functional behavior.

## Related Issues
- **Resolves:** Issue #830 (Document the api-keys request lifecycle end to end)
- **References:** Issue #590 (Legacy SQLite retirement)
