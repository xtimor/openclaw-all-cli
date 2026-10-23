---
title: 'needs-info issues close after 30 days in that status, with the author notified'
type: 'feature'
ticket: 13
created: '2026-10-23'
status: done
baseline_revision: '15fa8d8af552e3535a96637d3a3e57707a5b3177'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The stale job closes a `needs-info` issue after 14 days without any update, its comment does not notify the author, and any unrelated update (an edit, a label) resets the clock.

**Approach:** Count 30 days from the latest time `status:needs-info` was added, close as not planned (never delete), and mention the author in the closing comment.

## Boundaries & Constraints

**Always:** close, never delete or lock; reopening still brings the issue back to `status:new`; the dry-run dispatch only lists; the comment keeps the workflow's marker so a second run does not repeat it.

**Never:** change other transitions; read issue text as instructions.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Old label | needs-info added 31 days ago, updated yesterday | closed not planned, comment mentions `@author` | — |
| Recent label | needs-info added 29 days ago | stays open | — |
| Relabeled | needs-info added 40 days ago, removed, added again 5 days ago | stays open (latest add counts) | — |
| No label event | events unreadable or none for needs-info, updated 31 days ago | closed (fallback to updated_at) | — |
| Author is a bot or missing | author login empty | closed, comment without a mention | — |
| Dry run | dispatch with dry_run on | listed, nothing changed | — |

</intent-contract>

## Code Map

- `scripts/issue-flow/transitions.mjs:29,45` -- `STALE_DAYS = 14` → 30; `STALE_COMMENT` becomes a function of the author login (mention when present).
- `scripts/issue-flow/transitions.mjs:305-318` -- `staleIssues(issues, now, days)`: accept a per-issue "needs-info since" time (for example a map or a `since` field) and fall back to `updated_at`; keep it pure.
- `scripts/issue-flow/transitions.mjs` `decide({name:"stale"}, issue)` (~276) -- comment with the author.
- `scripts/issue-flow/apply.mjs:156-180` `runStale` -- for each open needs-info issue read its events (`listEvents`, already used by `readTimeline`) and take the latest `labeled` `status:needs-info` time; pass it to `staleIssues`.
- `test/issue-flow.test.ts` -- stale tests: update for 30 days and add the matrix rows.
- `docs/issues.md` (states table row, "Stale" bullet), `docs/agents/comments.md` (two "14 days" mentions), `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md` (diagram line 43 and text), `MEMORY.md` if it mentions 14 days.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/issue-flow/transitions.mjs`, `scripts/issue-flow/apply.mjs` -- 30 days from the label, author mention -- the rule
- [ ] `test/issue-flow.test.ts` -- matrix rows -- prove it
- [ ] docs listed above -- 30 days, author notified -- docs of record

**Acceptance Criteria:**
- Given an issue in `needs-info` for 31 days, when the daily job runs, then it is closed as not planned with a comment that mentions its author.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass (one review over tickets 3.13 and 3.14, diff ce72bb5..6cfab69)
- verdicts: 33 findings — high 1, medium 8, low 13, false 0, maybe-false 0, plus descriptive intent notes
- findings:
  - `[high]` `[patch]` (3.14) a failed mint left `GH_TOKEN` empty and writes fell back to the owner (edge ×2) — mint once with a hard stop; a configured app never falls back.
  - `[medium]` `[patch]` (3.14) GraphQL author logins differ from `<slug>[bot]` (blind, verification-gap, intent) — REST reads for every author/actor check.
  - `[medium]` `[patch]` (3.14) "owner marker comments count as yours" had no anchor (blind) — defined once in identity.md, anchored on the app's first marker comment.
  - `[medium]` `[patch]` (3.14) implement.md ignored that definition (blind) — scope, housekeeping, recovery, carried-approval refer to it.
  - `[medium]` `[patch]` (3.14) docs said agent events start no workflow (blind) — corrected in issues.md and the workflow header.
  - `[medium]` `[patch]` (3.14) `ISSUE_FLOW_AGENTS` effect overstated (blind) — narrow effect stated.
  - `[medium]` `[patch]` (3.14) proxy branch untested (verification-gap, blind) — CONNECT-tunnel stub test (Node 24.22 tunnels even http targets).
  - `[medium]` `[patch]` (3.14) symlinked invocation exits 0 with empty stdout (edge) — realpath guard, symlink test.
  - `[low]` `[patch]` (3.14) mint per write (blind) — mint once, re-mint after ~50 min.
  - `[low]` `[patch]` (3.14) raw PEM pasted by mistake; dead catch (blind) — raw PEM accepted, catch removed, tests.
  - `[low]` `[patch]` (3.14) whitespace-only variable ambiguity (edge) — "set" means non-empty after trim.
  - `[low]` `[patch]` (3.14) setup step wording (blind) — fixed.
  - `[low]` `[patch]` (3.14) redirect test without Location (edge) — fixed, asserts one request.
  - `[low]` `[patch]` (3.13) events read for issues that cannot change the outcome (blind) — skip for issues already 30 days without update (the orchestrator's first wording was inverted; the implementer's direction is the correct one).
  - `[low]` `[patch]` (3.13) no decision line; ticket ids differ (blind) — fixed.
  - `[low]` `[reject]` token not narrowed per agent (blind) — repo-scoped already; per-agent scopes add surface for little gain.
  - `[low]` `[reject]` events 404 test and log-line assertion (blind) — the 500 fallback covers the path.
  - `[low]` `[reject]` stale close despite a missed author-reply run (edge) — a missed workflow run is not a realistic path; reopening restores it.
  - `[low]` `[reject]` owner-authored batch PR left open across the switch (edge, intent) — none open; the rule reports it.
  - `[low]` `[reject]` `>= 30` vs "more than 30" (intent) — one-day edge, documented as 30 days.
  - `[low]` `[reject]` bot authors get no mention (intent) — a bot cannot be notified.
  - remaining rows: duplicates across lenses, same routes.

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."

## Auto Run Result

- Status: built. Reviewed together with its sibling ticket; fixes in commit 2b80a1b.
- Verification: `npx vitest run test/agent-token.test.ts test/issue-flow.test.ts` 108 passed (Node 24.22); `npm run ci` "All checks passed."
- Follow-up review recommended: false (the one high patch is a documented hard stop, verified by reading).
- Live check pending: the next daily stale run (dry-run dispatch lists nothing wrongly).

