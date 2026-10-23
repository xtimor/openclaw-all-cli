---
title: 'Live checks never block a build; approved asset paths may join package files'
type: 'chore'
ticket: 16
created: '2026-10-23'
status: 'built'
baseline_revision: 'e4ffee3b29305a481395cb21cc6916ecda3c3d77'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: ['blind-hunter']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The implementation run blocked #11 for a live Cursor check it could run (the routine has `CURSOR_API_KEY`) and that AGENTS.md says never blocks, and blocked #9 for adding an approved icon path to `package.json` `files`.

**Approach:** Live checks never block (run them when the key is set, else list as not run); additions to `files` named by the approved draft are allowed; docs match.

</intent-contract>

## Implementation Notes

Oneshot: three doc edits under 20 lines (`docs/agents/implement.md` rules "Live checks never block" and the `files` exception, reporter-vs-live wording, PR body wording; `docs/agents/triage.md` live sentence; `docs/issues.md` step 4). Owner decision for #9: a neutral own icon, recorded on the issue.

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass (quick, blind-hunter)
- verdicts: 12 findings — medium 6, low 6
- findings:
  - `[medium]` `[patch]` verify line asked agents to set approved — owner re-approves.
  - `[medium]` `[patch]` `files` exception allowed directories/globs and mismatched paths — exact file paths named by the draft only.
  - `[medium]` `[patch]` no rule for red live tests, unreachable Cursor, time — red = failing check; unreachable/time = not run with reason; ~15 min per issue, focused files only.
  - `[medium]` `[patch]` measurements contradicting the draft — block for the owner with the numbers.
  - `[medium]` `[patch]` needs-info ambiguity — a live Cursor check is never needs-info.
  - `[medium]` `[patch]` key handling — presence check only; no secrets in plan or PR.
  - `[low]` `[patch]` triage line 12 conflict; parenthetical misplaced; issues.md protected wording; setup note for the key; MEMORY line — fixed.
  - `[low]` `[reject]` the #9 icon decision in the ticket text — kept as context; recorded on the issue too.
  - `[low]` `[reject]` a docs consistency test — prose rules; no test harness for prompts.

## Verification

**Commands:**
- `npm run ci` -- expected: "All checks passed."

## Auto Run Result

- Status: built. Review patches applied in the same commit. `npm run ci` green.

