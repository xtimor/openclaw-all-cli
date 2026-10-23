---
title: 'needs-info issues close after 30 days in that status, with the author notified'
type: 'feature'
ticket: 13
created: '2026-10-23'
status: 'in-progress'
baseline_revision: '15fa8d8af552e3535a96637d3a3e57707a5b3177'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
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

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."
