---
title: "Show Cursor plan quota in OpenClaw"
ticket: 26
status: draft
---

## Auto Run Result

Status: blocked. Blocking condition: `no subagents`. This worker has no subagent tool, and the workflow makes a subagent mandatory (the full-route implementer and the quick review lens), so it halted instead of faking either.

What was done before the halt:
- Spike (AC 1) done with the real key: Cursor returns usable plan, period, spend, limits, per-model usage, and reset data from `api2.cursor.sh` DashboardService (`GetPlanInfo`, `GetCurrentPeriodUsage`, `GetAggregatedUsageEvents`). The ticket is therefore not blocked on Cursor's side and the hooks are worth building. Findings: `MEMORY.md` and `_bmad-output/initiative-openclaw-all-cli/epic-cursor-cli/spike-cursor-plan-quota-dashboard-api.md`. Not tested: an API key against a login-only account, team accounts.
- Two findings that shape the build: the manifest needs `contracts.usageProviders: ["cursor-cli"]`; and OpenClaw 2026.10.3 calls `resolveUsageAuth` only when it sees a credential source (provider config key, Gateway env var through `providerUsageAuthEnvVars`, or an auth profile), so a key held only in the plugin config shows no quota unless the docs say so.
- A first draft (port `readQuota`, Cursor `quota.ts` with cache, request merge, token reuse, 10 min back-off, stale marking; core `quota.ts` hooks; `register.ts` wiring; manifest entries) type-checks (`tsc --noEmit`) but has no tests, no docs, no CHANGELOG line, no `npm run ci`, and no review. It is saved as `story-show-cursor-plan-quota-in-openclaw-draft.patch` beside this plan (`git apply` it) and reverted from the tree.

Not run: tests (`test/quota.test.ts`, `npm test`, `npm run ci`), review, docs, CHANGELOG, live `cursor-agent` check, and the live check of the usage hooks in the isolated Gateway.

To resume: dispatch again from an environment that can launch subagents (or with the review pinned to `none` and a oneshot route), apply the draft patch, and continue from the plan step.

- followup_review_recommended: false (no review ran)
- deferred items: 0
