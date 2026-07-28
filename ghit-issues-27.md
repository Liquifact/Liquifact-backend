---
type: Feature
title: "Add total-count pagination metadata to kyc-webhooks list responses"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count kyc-webhooks pages

### Description
kyc-webhooks list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Include a total-count (and page metadata) in kyc-webhooks list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add pagination total count`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add ETag / conditional-GET support to kyc-webhooks read endpoints"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag kyc-webhooks

### Description
kyc-webhooks reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a stable ETag on kyc-webhooks reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add conditional GET`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add spec-contract tests for kyc-webhooks against the OpenAPI document"
labels: type:test, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test kyc-webhooks

### Description
kyc-webhooks responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests asserting kyc-webhooks responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/kyc-webhooks-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(kyc-webhooks): add OpenAPI contract tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Extract kyc-webhooks magic strings into a constants module"
labels: type:refactor, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name kyc-webhooks strings

### Description
kyc-webhooks uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move the kyc-webhooks literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/kyc-webhooks-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(kyc-webhooks): extract string constants`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a sequence diagram for the kyc-webhooks request lifecycle"
labels: type:docs, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram kyc-webhooks

### Description
kyc-webhooks's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a docs section with a sequence diagram of the kyc-webhooks request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/kyc-webhooks-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(kyc-webhooks): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add total-count pagination metadata to escrow-read list responses"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count escrow-read pages

### Description
escrow-read list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Include a total-count (and page metadata) in escrow-read list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add pagination total count`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add ETag / conditional-GET support to escrow-read read endpoints"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag escrow-read

### Description
escrow-read reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a stable ETag on escrow-read reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add conditional GET`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add spec-contract tests for escrow-read against the OpenAPI document"
labels: type:test, area:escrow-read, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test escrow-read

### Description
escrow-read responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests asserting escrow-read responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/escrow-read-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(escrow-read): add OpenAPI contract tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Extract escrow-read magic strings into a constants module"
labels: type:refactor, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name escrow-read strings

### Description
escrow-read uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move the escrow-read literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/escrow-read-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(escrow-read): extract string constants`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a sequence diagram for the escrow-read request lifecycle"
labels: type:docs, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram escrow-read

### Description
escrow-read's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a docs section with a sequence diagram of the escrow-read request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/escrow-read-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(escrow-read): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add total-count pagination metadata to invoice-state list responses"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count invoice-state pages

### Description
invoice-state list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Include a total-count (and page metadata) in invoice-state list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add pagination total count`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add ETag / conditional-GET support to invoice-state read endpoints"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag invoice-state

### Description
invoice-state reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a stable ETag on invoice-state reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add conditional GET`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add spec-contract tests for invoice-state against the OpenAPI document"
labels: type:test, area:invoice-state, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test invoice-state

### Description
invoice-state responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests asserting invoice-state responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/invoice-state-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(invoice-state): add OpenAPI contract tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Extract invoice-state magic strings into a constants module"
labels: type:refactor, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name invoice-state strings

### Description
invoice-state uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move the invoice-state literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/invoice-state-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(invoice-state): extract string constants`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a sequence diagram for the invoice-state request lifecycle"
labels: type:docs, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram invoice-state

### Description
invoice-state's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a docs section with a sequence diagram of the invoice-state request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/invoice-state-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(invoice-state): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add total-count pagination metadata to metrics list responses"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count metrics pages

### Description
metrics list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Include a total-count (and page metadata) in metrics list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add pagination total count`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add ETag / conditional-GET support to metrics read endpoints"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag metrics

### Description
metrics reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a stable ETag on metrics reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add conditional GET`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add spec-contract tests for metrics against the OpenAPI document"
labels: type:test, area:metrics, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test metrics

### Description
metrics responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests asserting metrics responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/metrics-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(metrics): add OpenAPI contract tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Extract metrics magic strings into a constants module"
labels: type:refactor, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name metrics strings

### Description
metrics uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move the metrics literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/metrics-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(metrics): extract string constants`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a sequence diagram for the metrics request lifecycle"
labels: type:docs, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram metrics

### Description
metrics's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a docs section with a sequence diagram of the metrics request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/metrics-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(metrics): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add total-count pagination metadata to config list responses"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count config pages

### Description
config list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Include a total-count (and page metadata) in config list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(config): add pagination total count`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add ETag / conditional-GET support to config read endpoints"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag config

### Description
config reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a stable ETag on config reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(config): add conditional GET`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add spec-contract tests for config against the OpenAPI document"
labels: type:test, area:config, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test config

### Description
config responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests asserting config responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/config-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(config): add OpenAPI contract tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Extract config magic strings into a constants module"
labels: type:refactor, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name config strings

### Description
config uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move the config literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/config-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(config): extract string constants`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a sequence diagram for the config request lifecycle"
labels: type:docs, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram config

### Description
config's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a docs section with a sequence diagram of the config request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/config-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(config): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add total-count pagination metadata to indexer list responses"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count indexer pages

### Description
indexer list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Include a total-count (and page metadata) in indexer list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(indexer): add pagination total count`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add ETag / conditional-GET support to indexer read endpoints"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag indexer

### Description
indexer reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a stable ETag on indexer reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(indexer): add conditional GET`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add spec-contract tests for indexer against the OpenAPI document"
labels: type:test, area:indexer, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test indexer

### Description
indexer responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests asserting indexer responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/indexer-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(indexer): add OpenAPI contract tests`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Extract indexer magic strings into a constants module"
labels: type:refactor, area:indexer, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name indexer strings

### Description
indexer uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move the indexer literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/indexer-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(indexer): extract string constants`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a sequence diagram for the indexer request lifecycle"
labels: type:docs, area:indexer, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram indexer

### Description
indexer's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a docs section with a sequence diagram of the indexer request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/indexer-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(indexer): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
