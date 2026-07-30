Add a maxElapsedMs cumulative-budget guard to the Soroban retry wrapper
Repo Avatar
Liquifact/Liquifact-backend
Add a maxElapsedMs cumulative-budget guard to the Soroban retry wrapper
Description
The retry wrapper in `src/services/soroban.js` uses exponential backoff with a max attempt count and per-delay cap, but it never bounds the total elapsed time across attempts. Under repeated transient failures, a single call can spend many seconds retrying and blow past the caller's HTTP timeout, turning a degraded dependency into hung requests. A cumulative time budget should abort retries early.

Requirements and context
Repository scope: Liquifact/Liquifact-backend only.
Add a maxElapsedMs option to withRetry (configurable, with a sane default) and stop retrying once the budget is exhausted, surfacing the last error.
Record the elapsed budget consumption in the Soroban latency metrics so exhaustion is observable.
Ensure the budget interacts correctly with the existing attempt and per-delay caps (whichever triggers first wins).
Suggested execution
Fork the repo and create a branch
git checkout -b enhancement/soroban-retry-elapsed-budget
Implement changes
Write code in: `src/services/soroban.js`.
Write comprehensive tests in: `src/services/soroban.test.js` — assert retries stop at the budget and the last error propagates.
Add documentation: document the budget option in the Soroban resilience docs.
JSDoc the new option.
Validate security: ensure errors surfaced after budget exhaustion are user-safe, not raw RPC internals.
Test and commit
Test and commit
Run npm test and npm run lint.
Cover edge cases: budget shorter than first backoff, budget never reached, and immediate success.
Example commit message
feat: add cumulative elapsed-time budget to Soroban retry wrapper

Guidelines
Minimum 95 percent test coverage for impacted modules.
Clear, reviewer-focused documentation.
Timeframe: 96 hours.Add a maxElapsedMs cumulative-budget guard to the Soroban retry wrapper
Repo Avatar
Liquifact/Liquifact-backend
Add a maxElapsedMs cumulative-budget guard to the Soroban retry wrapper
Description
The retry wrapper in `src/services/soroban.js` uses exponential backoff with a max attempt count and per-delay cap, but it never bounds the total elapsed time across attempts. Under repeated transient failures, a single call can spend many seconds retrying and blow past the caller's HTTP timeout, turning a degraded dependency into hung requests. A cumulative time budget should abort retries early.

Requirements and context
Repository scope: Liquifact/Liquifact-backend only.
Add a maxElapsedMs option to withRetry (configurable, with a sane default) and stop retrying once the budget is exhausted, surfacing the last error.
Record the elapsed budget consumption in the Soroban latency metrics so exhaustion is observable.
Ensure the budget interacts correctly with the existing attempt and per-delay caps (whichever triggers first wins).
Suggested execution
Fork the repo and create a branch
git checkout -b enhancement/soroban-retry-elapsed-budget
Implement changes
Write code in: `src/services/soroban.js`.
Write comprehensive tests in: `src/services/soroban.test.js` — assert retries stop at the budget and the last error propagates.
Add documentation: document the budget option in the Soroban resilience docs.
JSDoc the new option.
Validate security: ensure errors surfaced after budget exhaustion are user-safe, not raw RPC internals.
Test and commit
Test and commit
Run npm test and npm run lint.
Cover edge cases: budget shorter than first backoff, budget never reached, and immediate success.
Example commit message
feat: add cumulative elapsed-time budget to Soroban retry wrapper

Guidelines
Minimum 95 percent test coverage for impacted modules.
Clear, reviewer-focused documentation.
AddAdd