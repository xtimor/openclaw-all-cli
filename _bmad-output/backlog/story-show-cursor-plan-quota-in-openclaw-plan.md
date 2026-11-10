---
title: 'Show Cursor plan quota in OpenClaw'
type: 'feature'
ticket: 'story-show-cursor-plan-quota-in-openclaw'
created: '2026-11-10'
status: 'in-review'
baseline_revision: '9a81c89787d35978df0897b1de00ba485af3b093'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/backlog/story-show-cursor-plan-quota-in-openclaw.md'
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/epic-cursor-cli/spike-cursor-plan-quota-dashboard-api.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A user of `cursor-cli` models cannot see their Cursor plan quota in OpenClaw's usage surfaces.

**Approach:** Offer OpenClaw's `resolveUsageAuth` and `fetchUsageSnapshot` hooks through an optional adapter port `readQuota`; the Cursor reader (spike done, spike note) asks `GetPlanInfo` and `GetCurrentPeriodUsage`, caches 60 s per key, merges concurrent calls, reuses the 1 h token, backs off 10 min on failure and answers the last reading marked stale.

## Boundaries & Constraints

**Always:** the core names no CLI; only Cursor-reported values are shown; a quota failure never throws to a caller; the secret key and token are never logged.

**Never:** a quota request from a chat turn or a background poll; changes to per-turn usage behavior; cost estimation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh read | key, valid Cursor answers | snapshot with plan, windows (used %, reset), spend summary | none |
| N refreshes in TTL | N calls (also concurrent) | at most one Cursor request set, token reused | none |
| Failure | 429, 5xx, 401 key rejected, changed shape | last snapshot marked stale, or none; no throw; held off 10 min | one warning line, no secrets |
| No port | adapter without `readQuota` | no usage hooks registered | none |
| No key | login only | `resolveUsageAuth` answers handled, no row | none |

</intent-contract>

## Code Map

- `src/core/ports.ts` — `QuotaSnapshot`, `QuotaQuery`, `QuotaReport`, optional `CliAdapter.readQuota` (draft applied).
- `src/adapters/cursor/quota.ts` — reader: cache, merge, token reuse, back-off, stale (draft applied).
- `src/core/quota.ts` — `createUsageHooks`; `src/core/register.ts` spreads it into `registerProvider`.
- `openclaw.plugin.json` — `providerUsageAuthEnvVars`, `contracts.usageProviders`.
- Reuse the `src/adapters/cursor/usage.ts` tests' fake-fetch style (`test/`) for new tests.

## Tasks & Acceptance

- [ ] `test/quota.test.ts` — cover the matrix: snapshot mapping, TTL + concurrent merge (one request set), token reuse, back-off on 429/5xx/rejected/changed with stale or no snapshot, hooks (no port, no key, throw) -- AC 2-6.
- [ ] `docs/providers/cursor.md` — quota section: what is shown, source, 60 s cache, 10 min back-off, the credential-source limit (key only in plugin config shows no quota in OpenClaw 2026.10.3; use `CURSOR_API_KEY` in the Gateway env), login-only accounts show none; `README.md` link if not already reachable -- AC 7.
- [ ] `CHANGELOG.md` — one plain line under `## Unreleased` with issue #82 link -- AC 7.
- [ ] Check `test/package-contents.test.ts`/manifest tests still pass; fix tests only where the manifest additions require it.

## Verification

- `npx vitest run test/quota.test.ts`
- `npm run ci`
- Live (when reachable): a focused read with the real key (never print it) proving a snapshot comes back; otherwise record as not run.
