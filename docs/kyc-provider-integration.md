# External KYC provider integration

The KYC service stub should be replaced with an HTTP client that:

1. Submits applicant payloads to the configured provider base URL
2. Verifies webhook signatures before updating tenant KYC state
3. Maps provider statuses into LiquiFact's `pending|approved|rejected` enum

Configure `KYC_PROVIDER_URL`, `KYC_PROVIDER_API_KEY`, and webhook secrets via
environment. Fail closed — block funding routes when status is unknown.

See `tests/kyc.provider.test.js` for stub behaviour regression tests.
