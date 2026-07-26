---
type: Feature
title: "Add soft-delete and restore support to kyc-webhooks"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soft-delete for kyc-webhooks

### Description
Deleting kyc-webhooks records is destructive and irreversible. This issue adds soft-delete with a restore path and a retention window.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Mark kyc-webhooks records deleted (not purged) and exclude them from default reads; add a restore endpoint within a retention window.
- Purge past the window via a maintenance task.
- Cover delete, restore, and window-expiry in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-31-softdelete`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delete hides, restore within window, expiry purges.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add soft-delete and restore`

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
title: "Add an audit log for kyc-webhooks mutations"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Audit kyc-webhooks changes

### Description
Changes to kyc-webhooks leave no audit trail, complicating incident review. This issue records who/what/when for each mutation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Append an audit entry (actor, action, before/after summary, timestamp) on each kyc-webhooks write; expose a read view.
- Bound the log; redact secrets.
- Cover create/update/delete audit entries in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-32-audit`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: create, update, delete audit entries; redaction.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add mutation audit log`

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
title: "Add load/concurrency smoke tests for the kyc-webhooks endpoint"
labels: type:test, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Stress-test kyc-webhooks

### Description
The kyc-webhooks endpoint isn't tested under concurrency, hiding race conditions. This issue adds concurrency smoke tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests firing concurrent kyc-webhooks requests and asserting consistent state and no lost updates.
- Keep them deterministic and bounded (no real network).
- Fix any race surfaced (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/kyc-webhooks-31-concurrency`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: parallel writes, read-after-write, no lost update.
- Include the full test output in the PR description.

### Example commit message
`test(kyc-webhooks): add concurrency smoke tests`

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
title: "Extract kyc-webhooks business logic into a service layer"
labels: type:refactor, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Service layer for kyc-webhooks

### Description
kyc-webhooks logic is mixed into route handlers, hurting testability. This issue extracts a service layer.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move kyc-webhooks business logic into a service module; handlers become thin adapters.
- Behaviour unchanged; add unit tests for the service.
- No new deps.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/kyc-webhooks-31-service`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: service unit tests, handler delegates.
- Include the full test output in the PR description.

### Example commit message
`refactor(kyc-webhooks): extract service layer`

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
title: "Add an API changelog section for kyc-webhooks"
labels: type:docs, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Changelog for kyc-webhooks

### Description
Consumers can't track kyc-webhooks API changes. This issue adds a changelog section and a policy for updating it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a `docs/changelog-kyc-webhooks.md` (or a section) documenting notable kyc-webhooks API changes and a note to update it per PR.
- Backfill the last few notable changes.
- Keep it accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/kyc-webhooks-31-changelog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify entries against history.
- Include the full test output in the PR description.

### Example commit message
`docs(kyc-webhooks): add API changelog`

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
title: "Add soft-delete and restore support to escrow-read"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soft-delete for escrow-read

### Description
Deleting escrow-read records is destructive and irreversible. This issue adds soft-delete with a restore path and a retention window.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Mark escrow-read records deleted (not purged) and exclude them from default reads; add a restore endpoint within a retention window.
- Purge past the window via a maintenance task.
- Cover delete, restore, and window-expiry in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-31-softdelete`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delete hides, restore within window, expiry purges.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add soft-delete and restore`

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
title: "Add an audit log for escrow-read mutations"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Audit escrow-read changes

### Description
Changes to escrow-read leave no audit trail, complicating incident review. This issue records who/what/when for each mutation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Append an audit entry (actor, action, before/after summary, timestamp) on each escrow-read write; expose a read view.
- Bound the log; redact secrets.
- Cover create/update/delete audit entries in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-32-audit`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: create, update, delete audit entries; redaction.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add mutation audit log`

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
title: "Add load/concurrency smoke tests for the escrow-read endpoint"
labels: type:test, area:escrow-read, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Stress-test escrow-read

### Description
The escrow-read endpoint isn't tested under concurrency, hiding race conditions. This issue adds concurrency smoke tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests firing concurrent escrow-read requests and asserting consistent state and no lost updates.
- Keep them deterministic and bounded (no real network).
- Fix any race surfaced (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/escrow-read-31-concurrency`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: parallel writes, read-after-write, no lost update.
- Include the full test output in the PR description.

### Example commit message
`test(escrow-read): add concurrency smoke tests`

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
title: "Extract escrow-read business logic into a service layer"
labels: type:refactor, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Service layer for escrow-read

### Description
escrow-read logic is mixed into route handlers, hurting testability. This issue extracts a service layer.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move escrow-read business logic into a service module; handlers become thin adapters.
- Behaviour unchanged; add unit tests for the service.
- No new deps.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/escrow-read-31-service`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: service unit tests, handler delegates.
- Include the full test output in the PR description.

### Example commit message
`refactor(escrow-read): extract service layer`

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
title: "Add an API changelog section for escrow-read"
labels: type:docs, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Changelog for escrow-read

### Description
Consumers can't track escrow-read API changes. This issue adds a changelog section and a policy for updating it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a `docs/changelog-escrow-read.md` (or a section) documenting notable escrow-read API changes and a note to update it per PR.
- Backfill the last few notable changes.
- Keep it accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/escrow-read-31-changelog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify entries against history.
- Include the full test output in the PR description.

### Example commit message
`docs(escrow-read): add API changelog`

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
title: "Add soft-delete and restore support to invoice-state"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soft-delete for invoice-state

### Description
Deleting invoice-state records is destructive and irreversible. This issue adds soft-delete with a restore path and a retention window.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Mark invoice-state records deleted (not purged) and exclude them from default reads; add a restore endpoint within a retention window.
- Purge past the window via a maintenance task.
- Cover delete, restore, and window-expiry in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-31-softdelete`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delete hides, restore within window, expiry purges.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add soft-delete and restore`

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
title: "Add an audit log for invoice-state mutations"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Audit invoice-state changes

### Description
Changes to invoice-state leave no audit trail, complicating incident review. This issue records who/what/when for each mutation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Append an audit entry (actor, action, before/after summary, timestamp) on each invoice-state write; expose a read view.
- Bound the log; redact secrets.
- Cover create/update/delete audit entries in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-32-audit`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: create, update, delete audit entries; redaction.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add mutation audit log`

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
title: "Add load/concurrency smoke tests for the invoice-state endpoint"
labels: type:test, area:invoice-state, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Stress-test invoice-state

### Description
The invoice-state endpoint isn't tested under concurrency, hiding race conditions. This issue adds concurrency smoke tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests firing concurrent invoice-state requests and asserting consistent state and no lost updates.
- Keep them deterministic and bounded (no real network).
- Fix any race surfaced (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/invoice-state-31-concurrency`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: parallel writes, read-after-write, no lost update.
- Include the full test output in the PR description.

### Example commit message
`test(invoice-state): add concurrency smoke tests`

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
title: "Extract invoice-state business logic into a service layer"
labels: type:refactor, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Service layer for invoice-state

### Description
invoice-state logic is mixed into route handlers, hurting testability. This issue extracts a service layer.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move invoice-state business logic into a service module; handlers become thin adapters.
- Behaviour unchanged; add unit tests for the service.
- No new deps.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/invoice-state-31-service`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: service unit tests, handler delegates.
- Include the full test output in the PR description.

### Example commit message
`refactor(invoice-state): extract service layer`

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
title: "Add an API changelog section for invoice-state"
labels: type:docs, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Changelog for invoice-state

### Description
Consumers can't track invoice-state API changes. This issue adds a changelog section and a policy for updating it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a `docs/changelog-invoice-state.md` (or a section) documenting notable invoice-state API changes and a note to update it per PR.
- Backfill the last few notable changes.
- Keep it accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/invoice-state-31-changelog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify entries against history.
- Include the full test output in the PR description.

### Example commit message
`docs(invoice-state): add API changelog`

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
title: "Add soft-delete and restore support to metrics"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soft-delete for metrics

### Description
Deleting metrics records is destructive and irreversible. This issue adds soft-delete with a restore path and a retention window.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Mark metrics records deleted (not purged) and exclude them from default reads; add a restore endpoint within a retention window.
- Purge past the window via a maintenance task.
- Cover delete, restore, and window-expiry in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-31-softdelete`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delete hides, restore within window, expiry purges.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add soft-delete and restore`

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
title: "Add an audit log for metrics mutations"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Audit metrics changes

### Description
Changes to metrics leave no audit trail, complicating incident review. This issue records who/what/when for each mutation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Append an audit entry (actor, action, before/after summary, timestamp) on each metrics write; expose a read view.
- Bound the log; redact secrets.
- Cover create/update/delete audit entries in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-32-audit`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: create, update, delete audit entries; redaction.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add mutation audit log`

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
title: "Add load/concurrency smoke tests for the metrics endpoint"
labels: type:test, area:metrics, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Stress-test metrics

### Description
The metrics endpoint isn't tested under concurrency, hiding race conditions. This issue adds concurrency smoke tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests firing concurrent metrics requests and asserting consistent state and no lost updates.
- Keep them deterministic and bounded (no real network).
- Fix any race surfaced (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/metrics-31-concurrency`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: parallel writes, read-after-write, no lost update.
- Include the full test output in the PR description.

### Example commit message
`test(metrics): add concurrency smoke tests`

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
title: "Extract metrics business logic into a service layer"
labels: type:refactor, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Service layer for metrics

### Description
metrics logic is mixed into route handlers, hurting testability. This issue extracts a service layer.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move metrics business logic into a service module; handlers become thin adapters.
- Behaviour unchanged; add unit tests for the service.
- No new deps.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/metrics-31-service`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: service unit tests, handler delegates.
- Include the full test output in the PR description.

### Example commit message
`refactor(metrics): extract service layer`

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
title: "Add an API changelog section for metrics"
labels: type:docs, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Changelog for metrics

### Description
Consumers can't track metrics API changes. This issue adds a changelog section and a policy for updating it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a `docs/changelog-metrics.md` (or a section) documenting notable metrics API changes and a note to update it per PR.
- Backfill the last few notable changes.
- Keep it accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/metrics-31-changelog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify entries against history.
- Include the full test output in the PR description.

### Example commit message
`docs(metrics): add API changelog`

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
title: "Add soft-delete and restore support to config"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Soft-delete for config

### Description
Deleting config records is destructive and irreversible. This issue adds soft-delete with a restore path and a retention window.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Mark config records deleted (not purged) and exclude them from default reads; add a restore endpoint within a retention window.
- Purge past the window via a maintenance task.
- Cover delete, restore, and window-expiry in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-31-softdelete`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delete hides, restore within window, expiry purges.
- Include the full test output in the PR description.

### Example commit message
`feat(config): add soft-delete and restore`

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
title: "Add an audit log for config mutations"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Audit config changes

### Description
Changes to config leave no audit trail, complicating incident review. This issue records who/what/when for each mutation.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Append an audit entry (actor, action, before/after summary, timestamp) on each config write; expose a read view.
- Bound the log; redact secrets.
- Cover create/update/delete audit entries in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-32-audit`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: create, update, delete audit entries; redaction.
- Include the full test output in the PR description.

### Example commit message
`feat(config): add mutation audit log`

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
title: "Add load/concurrency smoke tests for the config endpoint"
labels: type:test, area:config, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Stress-test config

### Description
The config endpoint isn't tested under concurrency, hiding race conditions. This issue adds concurrency smoke tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add tests firing concurrent config requests and asserting consistent state and no lost updates.
- Keep them deterministic and bounded (no real network).
- Fix any race surfaced (note it).

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/config-31-concurrency`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: parallel writes, read-after-write, no lost update.
- Include the full test output in the PR description.

### Example commit message
`test(config): add concurrency smoke tests`

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
title: "Extract config business logic into a service layer"
labels: type:refactor, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Service layer for config

### Description
config logic is mixed into route handlers, hurting testability. This issue extracts a service layer.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Move config business logic into a service module; handlers become thin adapters.
- Behaviour unchanged; add unit tests for the service.
- No new deps.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/config-31-service`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: service unit tests, handler delegates.
- Include the full test output in the PR description.

### Example commit message
`refactor(config): extract service layer`

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
title: "Add an API changelog section for config"
labels: type:docs, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Changelog for config

### Description
Consumers can't track config API changes. This issue adds a changelog section and a policy for updating it.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add a `docs/changelog-config.md` (or a section) documenting notable config API changes and a note to update it per PR.
- Backfill the last few notable changes.
- Keep it accurate.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/config-31-changelog`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify entries against history.
- Include the full test output in the PR description.

### Example commit message
`docs(config): add API changelog`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
