# Mutation Test Report

## Summary

- **Date:** 2026-07-30
- **Target:** `contracts/` — Soroban smart contract (`liquifact-bounty`)
- **Tool:** `cargo-mutants`
- **Total mutants generated:** 15
- **Viable mutants:** 14
- **Caught:** 14
- **Missed:** 0
- **Unviable:** 1

## Mutation categories

| Category                | Count | Caught |
| ----------------------- | ----- | ------ |
| Operator replacement    | 10    | 10     |
| Return-value replacement | 4     | 4      |
| Function deletion       | 1     | 1      |

## Missed mutant analysis

**None.** All viable mutants are caught by the existing test suite.

## Improvement made

A test `test_sequential_bounty_ids` was added to catch the mutation `replace + with *` on line 78 (`id + 1` → `id * 1`). The original tests only created a single bounty per test, so an increment bug in `NextId` would go undetected. The new test creates three bounties and asserts sequential IDs (0, 1, 2) and distinct stored amounts, ensuring the ID-counter logic is verified.

## Conclusion

The test suite provides strong mutation coverage — every injected behavioural change is detected.
