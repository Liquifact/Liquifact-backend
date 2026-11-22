# Contributing to LiquiFact Backend

1. Use Node.js 20+ and install with `npm ci`.
2. Create a branch from `main`, keep changes focused.
3. Before opening a PR run `npm run lint`, `npm run build` and `npm test`.
4. Coverage enforcement:
   - Run `npm run test:coverage` to generate a coverage report.
   - The test suite enforces global coverage thresholds:
     - Statements: 90%
     - Branches: 81%
     - Functions: 92%
     - Lines: 91%
   - Coverage output is generated locally in the `coverage/` directory.
   - Ensure the coverage thresholds are not regressed; failing thresholds will cause the test command to fail.
5. If you change dependencies, commit the regenerated `package-lock.json`.

CI ('.github/workflows/ci.yml') runs the same lint, build and test steps on
every push to `main` and on pull requests.
