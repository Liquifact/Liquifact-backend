# Invoice verification thresholds

Fraud and manual-review thresholds are configurable per tenant via environment
or tenant policy records:

| Setting | Purpose |
|---------|---------|
| `FRAUD_SCORE_AUTO_REJECT` | Scores at/above auto-decline |
| `FRAUD_SCORE_MANUAL_REVIEW` | Scores requiring analyst review |
| `VERIFICATION_DUPLICATE_WINDOW_HOURS` | Duplicate invoice detection window |

Adjust thresholds when onboarding high-risk corridors; audit changes in the
retention log. Service defaults are documented in `docs/configuration.md`.
