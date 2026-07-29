---
type: Feature
title: "Add a readiness sub-check for kyc-webhooks"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Readiness for kyc-webhooks

### Description
The service readiness probe doesn't reflect kyc-webhooks's health. This issue adds a kyc-webhooks sub-check.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a kyc-webhooks readiness sub-check contributing to the overall readiness probe (fast, non-blocking, timeout-guarded).
- Degrade gracefully if kyc-webhooks is optional.
- Cover healthy and unhealthy in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-71-readiness`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: healthy passes, unhealthy fails, timeout bounded.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add readiness sub-check`

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
title: "Add structured request logging to kyc-webhooks"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Log kyc-webhooks requests

### Description
kyc-webhooks requests aren't logged consistently. This issue adds structured, PII-safe request logs.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Log each kyc-webhooks request with method, route, status, and duration via the structured logger; never log secrets/PII.
- Keep it at an appropriate level.
- Cover a log emission in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-72-reqlog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fields present, no PII, correct level.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add structured request logging`

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
title: "Add a soak/repeat smoke test for kyc-webhooks"
labels: type:test, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soak-test kyc-webhooks

### Description
kyc-webhooks isn't exercised under repeated calls, hiding leaks/flakiness. This issue adds a bounded soak test.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a test invoking kyc-webhooks repeatedly (bounded N) asserting stable results and no unbounded growth.
- Keep runtime short and deterministic.
- Note any leak found.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/kyc-webhooks-71-soak`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: stable over N calls, no growth.
- Include the full test output in the PR description.

### Example commit message
`test(kyc-webhooks): add soak smoke test`

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
title: "Separate the kyc-webhooks route handler from its business logic"
labels: type:refactor, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Split kyc-webhooks handler

### Description
kyc-webhooks's route handler mixes HTTP and business logic, hurting testability. This issue separates them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Extract kyc-webhooks's business logic into a unit-testable function the thin handler calls.
- Behaviour unchanged; add a direct unit test for the extracted logic.
- Existing tests still pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/kyc-webhooks-71-split`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: same responses, logic unit-tested.
- Include the full test output in the PR description.

### Example commit message
`refactor(kyc-webhooks): split handler and logic`

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
title: "Add a troubleshooting guide for kyc-webhooks"
labels: type:docs, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Troubleshoot kyc-webhooks

### Description
kyc-webhooks has no troubleshooting reference for common failures. This issue adds one.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/kyc-webhooks-troubleshooting.md` covering common kyc-webhooks errors, causes, and fixes.
- Cross-reference the error codes.
- Keep accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/kyc-webhooks-71-troubleshoot`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(kyc-webhooks): add troubleshooting guide`

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
title: "Add a readiness sub-check for escrow-read"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Readiness for escrow-read

### Description
The service readiness probe doesn't reflect escrow-read's health. This issue adds a escrow-read sub-check.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a escrow-read readiness sub-check contributing to the overall readiness probe (fast, non-blocking, timeout-guarded).
- Degrade gracefully if escrow-read is optional.
- Cover healthy and unhealthy in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-71-readiness`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: healthy passes, unhealthy fails, timeout bounded.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add readiness sub-check`

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
title: "Add structured request logging to escrow-read"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Log escrow-read requests

### Description
escrow-read requests aren't logged consistently. This issue adds structured, PII-safe request logs.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Log each escrow-read request with method, route, status, and duration via the structured logger; never log secrets/PII.
- Keep it at an appropriate level.
- Cover a log emission in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-72-reqlog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fields present, no PII, correct level.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add structured request logging`

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
title: "Add a soak/repeat smoke test for escrow-read"
labels: type:test, area:escrow-read, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soak-test escrow-read

### Description
escrow-read isn't exercised under repeated calls, hiding leaks/flakiness. This issue adds a bounded soak test.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a test invoking escrow-read repeatedly (bounded N) asserting stable results and no unbounded growth.
- Keep runtime short and deterministic.
- Note any leak found.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/escrow-read-71-soak`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: stable over N calls, no growth.
- Include the full test output in the PR description.

### Example commit message
`test(escrow-read): add soak smoke test`

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
title: "Separate the escrow-read route handler from its business logic"
labels: type:refactor, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Split escrow-read handler

### Description
escrow-read's route handler mixes HTTP and business logic, hurting testability. This issue separates them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Extract escrow-read's business logic into a unit-testable function the thin handler calls.
- Behaviour unchanged; add a direct unit test for the extracted logic.
- Existing tests still pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/escrow-read-71-split`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: same responses, logic unit-tested.
- Include the full test output in the PR description.

### Example commit message
`refactor(escrow-read): split handler and logic`

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
title: "Add a troubleshooting guide for escrow-read"
labels: type:docs, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Troubleshoot escrow-read

### Description
escrow-read has no troubleshooting reference for common failures. This issue adds one.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/escrow-read-troubleshooting.md` covering common escrow-read errors, causes, and fixes.
- Cross-reference the error codes.
- Keep accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/escrow-read-71-troubleshoot`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(escrow-read): add troubleshooting guide`

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
title: "Add a readiness sub-check for invoice-state"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Readiness for invoice-state

### Description
The service readiness probe doesn't reflect invoice-state's health. This issue adds a invoice-state sub-check.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a invoice-state readiness sub-check contributing to the overall readiness probe (fast, non-blocking, timeout-guarded).
- Degrade gracefully if invoice-state is optional.
- Cover healthy and unhealthy in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-71-readiness`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: healthy passes, unhealthy fails, timeout bounded.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add readiness sub-check`

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
title: "Add structured request logging to invoice-state"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Log invoice-state requests

### Description
invoice-state requests aren't logged consistently. This issue adds structured, PII-safe request logs.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Log each invoice-state request with method, route, status, and duration via the structured logger; never log secrets/PII.
- Keep it at an appropriate level.
- Cover a log emission in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-72-reqlog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fields present, no PII, correct level.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add structured request logging`

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
title: "Add a soak/repeat smoke test for invoice-state"
labels: type:test, area:invoice-state, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soak-test invoice-state

### Description
invoice-state isn't exercised under repeated calls, hiding leaks/flakiness. This issue adds a bounded soak test.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a test invoking invoice-state repeatedly (bounded N) asserting stable results and no unbounded growth.
- Keep runtime short and deterministic.
- Note any leak found.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/invoice-state-71-soak`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: stable over N calls, no growth.
- Include the full test output in the PR description.

### Example commit message
`test(invoice-state): add soak smoke test`

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
title: "Separate the invoice-state route handler from its business logic"
labels: type:refactor, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Split invoice-state handler

### Description
invoice-state's route handler mixes HTTP and business logic, hurting testability. This issue separates them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Extract invoice-state's business logic into a unit-testable function the thin handler calls.
- Behaviour unchanged; add a direct unit test for the extracted logic.
- Existing tests still pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/invoice-state-71-split`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: same responses, logic unit-tested.
- Include the full test output in the PR description.

### Example commit message
`refactor(invoice-state): split handler and logic`

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
title: "Add a troubleshooting guide for invoice-state"
labels: type:docs, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Troubleshoot invoice-state

### Description
invoice-state has no troubleshooting reference for common failures. This issue adds one.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/invoice-state-troubleshooting.md` covering common invoice-state errors, causes, and fixes.
- Cross-reference the error codes.
- Keep accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/invoice-state-71-troubleshoot`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(invoice-state): add troubleshooting guide`

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
title: "Add a readiness sub-check for metrics"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Readiness for metrics

### Description
The service readiness probe doesn't reflect metrics's health. This issue adds a metrics sub-check.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a metrics readiness sub-check contributing to the overall readiness probe (fast, non-blocking, timeout-guarded).
- Degrade gracefully if metrics is optional.
- Cover healthy and unhealthy in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-71-readiness`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: healthy passes, unhealthy fails, timeout bounded.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add readiness sub-check`

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
title: "Add structured request logging to metrics"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Log metrics requests

### Description
metrics requests aren't logged consistently. This issue adds structured, PII-safe request logs.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Log each metrics request with method, route, status, and duration via the structured logger; never log secrets/PII.
- Keep it at an appropriate level.
- Cover a log emission in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-72-reqlog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fields present, no PII, correct level.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add structured request logging`

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
title: "Add a soak/repeat smoke test for metrics"
labels: type:test, area:metrics, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soak-test metrics

### Description
metrics isn't exercised under repeated calls, hiding leaks/flakiness. This issue adds a bounded soak test.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a test invoking metrics repeatedly (bounded N) asserting stable results and no unbounded growth.
- Keep runtime short and deterministic.
- Note any leak found.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/metrics-71-soak`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: stable over N calls, no growth.
- Include the full test output in the PR description.

### Example commit message
`test(metrics): add soak smoke test`

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
title: "Separate the metrics route handler from its business logic"
labels: type:refactor, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Split metrics handler

### Description
metrics's route handler mixes HTTP and business logic, hurting testability. This issue separates them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Extract metrics's business logic into a unit-testable function the thin handler calls.
- Behaviour unchanged; add a direct unit test for the extracted logic.
- Existing tests still pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/metrics-71-split`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: same responses, logic unit-tested.
- Include the full test output in the PR description.

### Example commit message
`refactor(metrics): split handler and logic`

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
title: "Add a troubleshooting guide for metrics"
labels: type:docs, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Troubleshoot metrics

### Description
metrics has no troubleshooting reference for common failures. This issue adds one.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/metrics-troubleshooting.md` covering common metrics errors, causes, and fixes.
- Cross-reference the error codes.
- Keep accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/metrics-71-troubleshoot`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(metrics): add troubleshooting guide`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
