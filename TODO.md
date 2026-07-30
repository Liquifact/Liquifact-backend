# Task: #908 — Gate escrow-read behind a feature flag

## Steps

- [x] Plan created and approved
- [x] Step 1: Edit `src/config/index.js` — add `ESCROW_READ_PROJECTION_ENABLED` to Zod schema
- [x] Step 2: Edit `src/services/escrowRead.js` — gate `getEscrowStateWithProjection()` with feature flag
- [x] Step 3: Edit `src/config/index.test.js` — add config validation tests for new flag
- [x] Step 4: Edit `tests/escrow.read.test.js` — add feature flag tests covering flag on, flag off, default
- [x] Step 5: Edit `README.md` — document the new env flag
- [x] Step 6: Cannot run `npm run lint` and `npm test` — Node.js is not available in this environment

