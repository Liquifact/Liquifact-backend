---
type: Feature
title: "Propagate a correlation/trace id through the kyc-webhooks flow"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Trace kyc-webhooks requests

### Description
kyc-webhooks requests can't be traced across layers, slowing incident triage. This issue propagates a correlation id end to end.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Accept/generate a correlation id on kyc-webhooks requests and thread it through logs and downstream calls.
- Return it in responses/errors for support.
- Cover propagation in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-41-trace`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: generated when absent, echoed, present in logs.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): propagate correlation id`

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
title: "Gate kyc-webhooks behind a feature flag"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Feature-flag kyc-webhooks

### Description
New kyc-webhooks behavior can't be toggled without a deploy. This issue adds a config feature flag around it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a config/env feature flag that enables/disables the kyc-webhooks behavior at runtime with a safe default.
- Cover both enabled and disabled paths in tests.
- Document the flag.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-42-flag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: flag on, flag off, default.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add feature flag`

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
title: "Add regression tests for known kyc-webhooks edge cases"
labels: type:test, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Regression-test kyc-webhooks

### Description
Previously-fixed kyc-webhooks edge cases lack guards, risking re-breakage. This issue adds regression tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests reproducing the tricky kyc-webhooks edge cases (empty, boundary, malformed) so they can't regress.
- Reference the scenarios in test names.
- Fix any still-broken case (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/kyc-webhooks-41-regression`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: empty, boundary, malformed inputs.
- Include the full test output in the PR description.

### Example commit message
`test(kyc-webhooks): add edge-case regression tests`

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
title: "Add validation schemas for kyc-webhooks request/response payloads"
labels: type:refactor, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Schema-validate kyc-webhooks

### Description
kyc-webhooks payloads are validated ad hoc. This issue introduces declarative schemas for consistent validation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Define request/response schemas for kyc-webhooks and validate against them at the boundary.
- Reject invalid payloads with structured errors; behaviour otherwise unchanged.
- Cover valid/invalid in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/kyc-webhooks-41-schema`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: valid passes, invalid rejected with details.
- Include the full test output in the PR description.

### Example commit message
`refactor(kyc-webhooks): add validation schemas`

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
title: "Add copy-paste example requests for the kyc-webhooks endpoints"
labels: type:docs, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Examples for kyc-webhooks

### Description
The kyc-webhooks endpoints lack ready-to-run examples. This issue adds curl/HTTP examples.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/kyc-webhooks-examples.md` with runnable request/response examples for each kyc-webhooks endpoint.
- Keep them accurate; note required headers/auth.
- Verify each example against the route.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/kyc-webhooks-41-examples`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify examples against routes.
- Include the full test output in the PR description.

### Example commit message
`docs(kyc-webhooks): add request examples`

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
title: "Propagate a correlation/trace id through the escrow-read flow"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Trace escrow-read requests

### Description
escrow-read requests can't be traced across layers, slowing incident triage. This issue propagates a correlation id end to end.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Accept/generate a correlation id on escrow-read requests and thread it through logs and downstream calls.
- Return it in responses/errors for support.
- Cover propagation in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-41-trace`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: generated when absent, echoed, present in logs.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): propagate correlation id`

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
title: "Gate escrow-read behind a feature flag"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Feature-flag escrow-read

### Description
New escrow-read behavior can't be toggled without a deploy. This issue adds a config feature flag around it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a config/env feature flag that enables/disables the escrow-read behavior at runtime with a safe default.
- Cover both enabled and disabled paths in tests.
- Document the flag.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-42-flag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: flag on, flag off, default.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add feature flag`

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
title: "Add regression tests for known escrow-read edge cases"
labels: type:test, area:escrow-read, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Regression-test escrow-read

### Description
Previously-fixed escrow-read edge cases lack guards, risking re-breakage. This issue adds regression tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests reproducing the tricky escrow-read edge cases (empty, boundary, malformed) so they can't regress.
- Reference the scenarios in test names.
- Fix any still-broken case (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/escrow-read-41-regression`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: empty, boundary, malformed inputs.
- Include the full test output in the PR description.

### Example commit message
`test(escrow-read): add edge-case regression tests`

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
title: "Add validation schemas for escrow-read request/response payloads"
labels: type:refactor, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Schema-validate escrow-read

### Description
escrow-read payloads are validated ad hoc. This issue introduces declarative schemas for consistent validation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Define request/response schemas for escrow-read and validate against them at the boundary.
- Reject invalid payloads with structured errors; behaviour otherwise unchanged.
- Cover valid/invalid in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/escrow-read-41-schema`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: valid passes, invalid rejected with details.
- Include the full test output in the PR description.

### Example commit message
`refactor(escrow-read): add validation schemas`

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
title: "Add copy-paste example requests for the escrow-read endpoints"
labels: type:docs, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Examples for escrow-read

### Description
The escrow-read endpoints lack ready-to-run examples. This issue adds curl/HTTP examples.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/escrow-read-examples.md` with runnable request/response examples for each escrow-read endpoint.
- Keep them accurate; note required headers/auth.
- Verify each example against the route.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/escrow-read-41-examples`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify examples against routes.
- Include the full test output in the PR description.

### Example commit message
`docs(escrow-read): add request examples`

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
title: "Propagate a correlation/trace id through the invoice-state flow"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Trace invoice-state requests

### Description
invoice-state requests can't be traced across layers, slowing incident triage. This issue propagates a correlation id end to end.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Accept/generate a correlation id on invoice-state requests and thread it through logs and downstream calls.
- Return it in responses/errors for support.
- Cover propagation in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-41-trace`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: generated when absent, echoed, present in logs.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): propagate correlation id`

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
title: "Gate invoice-state behind a feature flag"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Feature-flag invoice-state

### Description
New invoice-state behavior can't be toggled without a deploy. This issue adds a config feature flag around it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a config/env feature flag that enables/disables the invoice-state behavior at runtime with a safe default.
- Cover both enabled and disabled paths in tests.
- Document the flag.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-42-flag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: flag on, flag off, default.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add feature flag`

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
title: "Add regression tests for known invoice-state edge cases"
labels: type:test, area:invoice-state, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Regression-test invoice-state

### Description
Previously-fixed invoice-state edge cases lack guards, risking re-breakage. This issue adds regression tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests reproducing the tricky invoice-state edge cases (empty, boundary, malformed) so they can't regress.
- Reference the scenarios in test names.
- Fix any still-broken case (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/invoice-state-41-regression`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: empty, boundary, malformed inputs.
- Include the full test output in the PR description.

### Example commit message
`test(invoice-state): add edge-case regression tests`

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
title: "Add validation schemas for invoice-state request/response payloads"
labels: type:refactor, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Schema-validate invoice-state

### Description
invoice-state payloads are validated ad hoc. This issue introduces declarative schemas for consistent validation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Define request/response schemas for invoice-state and validate against them at the boundary.
- Reject invalid payloads with structured errors; behaviour otherwise unchanged.
- Cover valid/invalid in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/invoice-state-41-schema`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: valid passes, invalid rejected with details.
- Include the full test output in the PR description.

### Example commit message
`refactor(invoice-state): add validation schemas`

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
title: "Add copy-paste example requests for the invoice-state endpoints"
labels: type:docs, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Examples for invoice-state

### Description
The invoice-state endpoints lack ready-to-run examples. This issue adds curl/HTTP examples.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/invoice-state-examples.md` with runnable request/response examples for each invoice-state endpoint.
- Keep them accurate; note required headers/auth.
- Verify each example against the route.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/invoice-state-41-examples`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify examples against routes.
- Include the full test output in the PR description.

### Example commit message
`docs(invoice-state): add request examples`

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
title: "Propagate a correlation/trace id through the metrics flow"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Trace metrics requests

### Description
metrics requests can't be traced across layers, slowing incident triage. This issue propagates a correlation id end to end.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Accept/generate a correlation id on metrics requests and thread it through logs and downstream calls.
- Return it in responses/errors for support.
- Cover propagation in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-41-trace`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: generated when absent, echoed, present in logs.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): propagate correlation id`

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
title: "Gate metrics behind a feature flag"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Feature-flag metrics

### Description
New metrics behavior can't be toggled without a deploy. This issue adds a config feature flag around it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a config/env feature flag that enables/disables the metrics behavior at runtime with a safe default.
- Cover both enabled and disabled paths in tests.
- Document the flag.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-42-flag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: flag on, flag off, default.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add feature flag`

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
title: "Add regression tests for known metrics edge cases"
labels: type:test, area:metrics, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Regression-test metrics

### Description
Previously-fixed metrics edge cases lack guards, risking re-breakage. This issue adds regression tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests reproducing the tricky metrics edge cases (empty, boundary, malformed) so they can't regress.
- Reference the scenarios in test names.
- Fix any still-broken case (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/metrics-41-regression`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: empty, boundary, malformed inputs.
- Include the full test output in the PR description.

### Example commit message
`test(metrics): add edge-case regression tests`

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
title: "Add validation schemas for metrics request/response payloads"
labels: type:refactor, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Schema-validate metrics

### Description
metrics payloads are validated ad hoc. This issue introduces declarative schemas for consistent validation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Define request/response schemas for metrics and validate against them at the boundary.
- Reject invalid payloads with structured errors; behaviour otherwise unchanged.
- Cover valid/invalid in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/metrics-41-schema`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: valid passes, invalid rejected with details.
- Include the full test output in the PR description.

### Example commit message
`refactor(metrics): add validation schemas`

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
title: "Add copy-paste example requests for the metrics endpoints"
labels: type:docs, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Examples for metrics

### Description
The metrics endpoints lack ready-to-run examples. This issue adds curl/HTTP examples.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/metrics-examples.md` with runnable request/response examples for each metrics endpoint.
- Keep them accurate; note required headers/auth.
- Verify each example against the route.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/metrics-41-examples`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify examples against routes.
- Include the full test output in the PR description.

### Example commit message
`docs(metrics): add request examples`

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
title: "Propagate a correlation/trace id through the config flow"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Trace config requests

### Description
config requests can't be traced across layers, slowing incident triage. This issue propagates a correlation id end to end.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Accept/generate a correlation id on config requests and thread it through logs and downstream calls.
- Return it in responses/errors for support.
- Cover propagation in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-41-trace`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: generated when absent, echoed, present in logs.
- Include the full test output in the PR description.

### Example commit message
`feat(config): propagate correlation id`

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
title: "Gate config behind a feature flag"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Feature-flag config

### Description
New config behavior can't be toggled without a deploy. This issue adds a config feature flag around it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a config/env feature flag that enables/disables the config behavior at runtime with a safe default.
- Cover both enabled and disabled paths in tests.
- Document the flag.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-42-flag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: flag on, flag off, default.
- Include the full test output in the PR description.

### Example commit message
`feat(config): add feature flag`

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
title: "Add regression tests for known config edge cases"
labels: type:test, area:config, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Regression-test config

### Description
Previously-fixed config edge cases lack guards, risking re-breakage. This issue adds regression tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests reproducing the tricky config edge cases (empty, boundary, malformed) so they can't regress.
- Reference the scenarios in test names.
- Fix any still-broken case (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/config-41-regression`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: empty, boundary, malformed inputs.
- Include the full test output in the PR description.

### Example commit message
`test(config): add edge-case regression tests`

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
title: "Add validation schemas for config request/response payloads"
labels: type:refactor, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Schema-validate config

### Description
config payloads are validated ad hoc. This issue introduces declarative schemas for consistent validation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Define request/response schemas for config and validate against them at the boundary.
- Reject invalid payloads with structured errors; behaviour otherwise unchanged.
- Cover valid/invalid in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/config-41-schema`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: valid passes, invalid rejected with details.
- Include the full test output in the PR description.

### Example commit message
`refactor(config): add validation schemas`

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
title: "Add copy-paste example requests for the config endpoints"
labels: type:docs, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Examples for config

### Description
The config endpoints lack ready-to-run examples. This issue adds curl/HTTP examples.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/config-examples.md` with runnable request/response examples for each config endpoint.
- Keep them accurate; note required headers/auth.
- Verify each example against the route.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/config-41-examples`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify examples against routes.
- Include the full test output in the PR description.

### Example commit message
`docs(config): add request examples`

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
title: "Propagate a correlation/trace id through the indexer flow"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Trace indexer requests

### Description
indexer requests can't be traced across layers, slowing incident triage. This issue propagates a correlation id end to end.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Accept/generate a correlation id on indexer requests and thread it through logs and downstream calls.
- Return it in responses/errors for support.
- Cover propagation in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-41-trace`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: generated when absent, echoed, present in logs.
- Include the full test output in the PR description.

### Example commit message
`feat(indexer): propagate correlation id`

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
title: "Gate indexer behind a feature flag"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Feature-flag indexer

### Description
New indexer behavior can't be toggled without a deploy. This issue adds a config feature flag around it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a config/env feature flag that enables/disables the indexer behavior at runtime with a safe default.
- Cover both enabled and disabled paths in tests.
- Document the flag.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-42-flag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: flag on, flag off, default.
- Include the full test output in the PR description.

### Example commit message
`feat(indexer): add feature flag`

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
title: "Add regression tests for known indexer edge cases"
labels: type:test, area:indexer, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Regression-test indexer

### Description
Previously-fixed indexer edge cases lack guards, risking re-breakage. This issue adds regression tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests reproducing the tricky indexer edge cases (empty, boundary, malformed) so they can't regress.
- Reference the scenarios in test names.
- Fix any still-broken case (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/indexer-41-regression`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: empty, boundary, malformed inputs.
- Include the full test output in the PR description.

### Example commit message
`test(indexer): add edge-case regression tests`

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
title: "Add validation schemas for indexer request/response payloads"
labels: type:refactor, area:indexer, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Schema-validate indexer

### Description
indexer payloads are validated ad hoc. This issue introduces declarative schemas for consistent validation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Define request/response schemas for indexer and validate against them at the boundary.
- Reject invalid payloads with structured errors; behaviour otherwise unchanged.
- Cover valid/invalid in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/indexer-41-schema`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: valid passes, invalid rejected with details.
- Include the full test output in the PR description.

### Example commit message
`refactor(indexer): add validation schemas`

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
title: "Add copy-paste example requests for the indexer endpoints"
labels: type:docs, area:indexer, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Examples for indexer

### Description
The indexer endpoints lack ready-to-run examples. This issue adds curl/HTTP examples.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/indexer-examples.md` with runnable request/response examples for each indexer endpoint.
- Keep them accurate; note required headers/auth.
- Verify each example against the route.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/indexer-41-examples`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify examples against routes.
- Include the full test output in the PR description.

### Example commit message
`docs(indexer): add request examples`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
