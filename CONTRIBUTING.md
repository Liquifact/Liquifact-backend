# Contributing to LiquiFact Backend

Thanks for contributing to the LiquiFact backend. This guide documents the workflow, branch naming, local checks, testing expectations, and CI behavior used by this repository.

---

## Local Setup

Use Node.js 20 and npm 9 or newer.

```bash
npm install --no-package-lock
cp .env.example .env
```

For database-backed work, start the local services and run migrations:

```bash
docker-compose -f docker-compose.dev.yml up -d
npm run db:migrate
```

Run the API locally:

```bash
npm run dev
```

---

## Branch Naming

Create focused branches from `main` using the project convention:

```
<type>/<area>-<issue-number>-<short-slug>
```

| Type | When to use |
| --- | --- |
| `feature` | New functionality |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code restructuring, no behavior change |
| `test` | Adding or improving tests |
| `chore` | Tooling, config, dependency updates |
| `ci` | CI/CD changes |

Examples:

```
docs/contributing-291-ci-expectations
fix/invoices-42-state-transition
feature/escrow-18-reconciliation
test/auth-middleware-155-coverage
```

Keep each branch scoped to one issue or one cohesive change. Do not bundle unrelated fixes.

---

## Commit Style

Use conventional-style commit messages:

```
docs: add backend contributing guide
fix: validate invoice state transitions
test: cover escrow reconciliation failure path
refactor: extract shared auth middleware stack
```

---

## Code Style

### Prettier

The project uses Prettier for formatting. The config is in `.prettierrc`:

- Single quotes
- Semicolons
- Trailing commas
- 100-character print width
- 2-space indentation

Format your code before opening a PR:

```bash
npx prettier --write .
```

`.prettierignore` excludes generated files. Do not disable Prettier for new source files.

### ESLint

ESLint enforces style and security rules via `eslint.config.js` using the `eslint-plugin-jsdoc` and `eslint-plugin-security` plugins.

All functions and methods in `src/` must have JSDoc comments with `@description`, `@param`, and `@returns` tags. Test files are exempt.

Check lint on your changes:

```bash
npm run lint
```

Auto-fix safe issues:

```bash
npm run lint:fix
```

> The full lint job in CI is allowed to fail (there are pre-existing lint errors in the repo). **Your new or modified files must not introduce new lint errors.** CI will lint only the files changed in your PR and fail the build if they have errors.

### TypeScript

TypeScript is optional and incremental. If you add `.ts` files, run:

```bash
npm run typecheck
```

For JSDoc-based type checking on existing JavaScript:

```bash
npm run typecheck:jsdoc
```

See `docs/typescript-plan.md` for the migration approach.

---

## Testing

### Running Tests

```bash
npm test
```

This runs the full Jest suite with `--runInBand --forceExit`. Tests use stubbed/mocked external dependencies — no live database, Stellar network, Redis, or S3 is required for unit and integration tests.

For coverage:

```bash
npm run test:coverage
```

### Writing Tests

- Add or update tests for any changed behavior under `tests/` or collocated `*.test.js` files.
- Prefer focused unit tests for service and middleware logic.
- Use integration tests for route behavior.
- Use existing helpers in `tests/helpers/` and mocks in `tests/mocks/` before creating new test utilities.
- Mock all external dependencies: database (knex), Stellar/Soroban RPC, S3, Redis, Sentry. Follow the patterns already used in the test suite.
- Tests must be deterministic and not depend on external network access or a running database.
- If your issue asks for coverage improvements, run `npm run test:coverage` and include the relevant output in the PR description.

### Pre-existing Test Failures

Some tests in `tests/retention.*`, `tests/soroban.sim.test.js`, and `tests/kyc.gating.test.js` have pre-existing failures unrelated to recent changes. Do not let these block your PR. Document any new test failures you observe.

---

## CI Expectations

CI runs on all pushes to `main` and all pull requests targeting `main`. The workflow file is `.github/workflows/ci.yml`.

### Lint job

1. Checks out the repo with full history (`fetch-depth: 0`).
2. Installs dependencies with `npm install --no-package-lock`.
3. Detects which `.js` files changed in the PR using `git diff origin/main...HEAD`.
4. **Fails the build** if any changed `.js` files have lint errors.
5. Runs `npm run lint` on the full `src/` directory as a soft check (`continue-on-error: true`) to surface pre-existing issues without blocking the PR.

**What this means for contributors:** Your changed files must pass lint. Pre-existing errors in other files do not fail your PR, but you should not add to them.

### Test job

1. Installs dependencies with `npm install --no-package-lock`.
2. Runs `npm test` — the full Jest suite.
3. Runs `node --check src/index.js` — a fast syntax validation of the main entry point.

The test job has a 10-minute timeout. Test failures in your changed code will fail the build.

### Concurrency

Concurrent runs for the same branch/PR are cancelled automatically. If you push multiple commits quickly, earlier CI runs are cancelled in favor of the latest.

---

## Load Baseline and E2E Tests

### Load Baseline

The load baseline suite (`tests/load/`) measures throughput and latency for core read endpoints. It is **not** part of `npm test` and is not run in CI. Run it manually against a locally running API:

```bash
npm run dev          # Terminal 1
npm run load:baseline  # Terminal 2
```

See `README.md` for environment variables and safety defaults. Do not run the load suite against production without explicit approval.

### E2E API Tests

The E2E suite spins up the API, a test Postgres database, and a mock Soroban server using Docker Compose:

```bash
npm run e2e:api
```

E2E tests are not part of the standard CI run. Run them locally when your change affects health, authentication, or escrow endpoints end-to-end. Requires Docker and Docker Compose.

---

## Security and Data Handling

This backend handles invoice data, authentication, escrow state, and payment-adjacent workflows.

- Do not commit `.env` files, private keys, API keys, bearer tokens, or generated credentials.
- When changing auth, upload, webhook, or payment-related code, include a short security note in the PR describing the trust boundary and validation path.
- Sensitive fields (password, token, secret, apiKey, privateKey) are redacted before audit log persistence — follow this pattern for any new fields.
- Remote load targets are blocked by default; never hardcode credentials or non-local URLs in test helpers.

---

## Pull Request Checklist

Before requesting review:

- [ ] The PR title is concise (under 70 characters). Put details in the description.
- [ ] The PR references the issue: `Closes #<issue-number>`.
- [ ] The diff is scoped to the requested change — no unrelated refactors or formatting churn.
- [ ] New or changed `.js` files pass `npm run lint` (no new errors).
- [ ] `npm test` was run and any new failures are explained.
- [ ] `npx prettier --write .` was run on changed files.
- [ ] JSDoc comments (`@description`, `@param`, `@returns`) are present on all new functions in `src/`.
- [ ] Migration changes include rollback instructions or operational notes.
- [ ] No secrets, build output, or generated files are included.

---

## Community and Campaign

LiquiFact backend tasks may be part of the GrantFox OSS / Official Campaign. Use the LiquiFact Discord linked in campaign issues for coordination, review questions, and reward follow-up after eligible merged work.

## Metrics Documentation Rule
- [ ] I have documented notable metrics API changes in `docs/changelog-metrics.md` (or checked that no metric changes occurred).
