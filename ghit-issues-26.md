---
type: Feature
title: "Add a webhook callback on kyc-webhooks events"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on kyc-webhooks events

### Description
Consumers must poll for kyc-webhooks changes. This issue adds an outbound webhook callback on notable kyc-webhooks events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on kyc-webhooks events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): add event webhook callback`

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
title: "Add gzip response compression for large kyc-webhooks results"
labels: type:feature, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress kyc-webhooks responses

### Description
Large kyc-webhooks responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for kyc-webhooks responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/kyc-webhooks-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(kyc-webhooks): compress large responses`

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
title: "Add snapshot tests for kyc-webhooks error-response bodies"
labels: type:test, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot kyc-webhooks errors

### Description
kyc-webhooks error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the kyc-webhooks error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/kyc-webhooks-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(kyc-webhooks): snapshot error bodies`

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
title: "Consolidate kyc-webhooks error handling into shared middleware"
labels: type:refactor, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize kyc-webhooks errors

### Description
kyc-webhooks handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route kyc-webhooks errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/kyc-webhooks-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(kyc-webhooks): centralize error handling`

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
title: "Add a data-retention note for kyc-webhooks"
labels: type:docs, area:kyc-webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document kyc-webhooks retention

### Description
kyc-webhooks's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/kyc-webhooks-retention.md` covering what kyc-webhooks stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/kyc-webhooks-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(kyc-webhooks): document data retention`

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
title: "Add a webhook callback on escrow-read events"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on escrow-read events

### Description
Consumers must poll for escrow-read changes. This issue adds an outbound webhook callback on notable escrow-read events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on escrow-read events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): add event webhook callback`

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
title: "Add gzip response compression for large escrow-read results"
labels: type:feature, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress escrow-read responses

### Description
Large escrow-read responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for escrow-read responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/escrow-read-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(escrow-read): compress large responses`

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
title: "Add snapshot tests for escrow-read error-response bodies"
labels: type:test, area:escrow-read, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot escrow-read errors

### Description
escrow-read error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the escrow-read error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/escrow-read-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(escrow-read): snapshot error bodies`

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
title: "Consolidate escrow-read error handling into shared middleware"
labels: type:refactor, area:escrow-read, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize escrow-read errors

### Description
escrow-read handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route escrow-read errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/escrow-read-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(escrow-read): centralize error handling`

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
title: "Add a data-retention note for escrow-read"
labels: type:docs, area:escrow-read, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document escrow-read retention

### Description
escrow-read's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/escrow-read-retention.md` covering what escrow-read stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/escrow-read-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(escrow-read): document data retention`

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
title: "Add a webhook callback on invoice-state events"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on invoice-state events

### Description
Consumers must poll for invoice-state changes. This issue adds an outbound webhook callback on notable invoice-state events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on invoice-state events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): add event webhook callback`

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
title: "Add gzip response compression for large invoice-state results"
labels: type:feature, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress invoice-state responses

### Description
Large invoice-state responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for invoice-state responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/invoice-state-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(invoice-state): compress large responses`

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
title: "Add snapshot tests for invoice-state error-response bodies"
labels: type:test, area:invoice-state, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot invoice-state errors

### Description
invoice-state error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the invoice-state error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/invoice-state-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(invoice-state): snapshot error bodies`

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
title: "Consolidate invoice-state error handling into shared middleware"
labels: type:refactor, area:invoice-state, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize invoice-state errors

### Description
invoice-state handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route invoice-state errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/invoice-state-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(invoice-state): centralize error handling`

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
title: "Add a data-retention note for invoice-state"
labels: type:docs, area:invoice-state, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document invoice-state retention

### Description
invoice-state's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/invoice-state-retention.md` covering what invoice-state stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/invoice-state-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(invoice-state): document data retention`

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
title: "Add a webhook callback on metrics events"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on metrics events

### Description
Consumers must poll for metrics changes. This issue adds an outbound webhook callback on notable metrics events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on metrics events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): add event webhook callback`

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
title: "Add gzip response compression for large metrics results"
labels: type:feature, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress metrics responses

### Description
Large metrics responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for metrics responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/metrics-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(metrics): compress large responses`

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
title: "Add snapshot tests for metrics error-response bodies"
labels: type:test, area:metrics, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot metrics errors

### Description
metrics error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the metrics error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/metrics-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(metrics): snapshot error bodies`

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
title: "Consolidate metrics error handling into shared middleware"
labels: type:refactor, area:metrics, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize metrics errors

### Description
metrics handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route metrics errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/metrics-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(metrics): centralize error handling`

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
title: "Add a data-retention note for metrics"
labels: type:docs, area:metrics, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document metrics retention

### Description
metrics's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/metrics-retention.md` covering what metrics stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/metrics-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(metrics): document data retention`

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
title: "Add a webhook callback on config events"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on config events

### Description
Consumers must poll for config changes. This issue adds an outbound webhook callback on notable config events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on config events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(config): add event webhook callback`

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
title: "Add gzip response compression for large config results"
labels: type:feature, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress config responses

### Description
Large config responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for config responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/config-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(config): compress large responses`

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
title: "Add snapshot tests for config error-response bodies"
labels: type:test, area:config, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot config errors

### Description
config error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the config error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/config-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(config): snapshot error bodies`

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
title: "Consolidate config error handling into shared middleware"
labels: type:refactor, area:config, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize config errors

### Description
config handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route config errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/config-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(config): centralize error handling`

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
title: "Add a data-retention note for config"
labels: type:docs, area:config, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document config retention

### Description
config's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/config-retention.md` covering what config stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/config-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(config): document data retention`

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
title: "Add a webhook callback on indexer events"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on indexer events

### Description
Consumers must poll for indexer changes. This issue adds an outbound webhook callback on notable indexer events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on indexer events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(indexer): add event webhook callback`

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
title: "Add gzip response compression for large indexer results"
labels: type:feature, area:indexer, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress indexer responses

### Description
Large indexer responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for indexer responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/indexer-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(indexer): compress large responses`

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
title: "Add snapshot tests for indexer error-response bodies"
labels: type:test, area:indexer, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot indexer errors

### Description
indexer error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the indexer error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/indexer-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(indexer): snapshot error bodies`

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
title: "Consolidate indexer error handling into shared middleware"
labels: type:refactor, area:indexer, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize indexer errors

### Description
indexer handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route indexer errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/indexer-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(indexer): centralize error handling`

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
title: "Add a data-retention note for indexer"
labels: type:docs, area:indexer, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document indexer retention

### Description
indexer's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/indexer-retention.md` covering what indexer stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/indexer-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(indexer): document data retention`

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
title: "Add a webhook callback on persistence events"
labels: type:feature, area:persistence, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on persistence events

### Description
Consumers must poll for persistence changes. This issue adds an outbound webhook callback on notable persistence events.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Emit a signed webhook to subscribers on persistence events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/persistence-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(persistence): add event webhook callback`

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
title: "Add gzip response compression for large persistence results"
labels: type:feature, area:persistence, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress persistence responses

### Description
Large persistence responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Enable gzip/deflate for persistence responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/persistence-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(persistence): compress large responses`

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
title: "Add snapshot tests for persistence error-response bodies"
labels: type:test, area:persistence, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot persistence errors

### Description
persistence error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add snapshot tests for the persistence error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/persistence-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(persistence): snapshot error bodies`

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
title: "Consolidate persistence error handling into shared middleware"
labels: type:refactor, area:persistence, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize persistence errors

### Description
persistence handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Route persistence errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/persistence-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(persistence): centralize error handling`

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
title: "Add a data-retention note for persistence"
labels: type:docs, area:persistence, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document persistence retention

### Description
persistence's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Liquifact/Liquifact-backend only.
- Add `docs/persistence-retention.md` covering what persistence stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/persistence-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(persistence): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the Liquifact community on Discord:** https://discord.gg/JrGPH4V3
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
