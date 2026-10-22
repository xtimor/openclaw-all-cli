---
title: 'Implementation run on the owner''s approval'
type: 'feature'
ticket: '9'
created: '2026-10-22'
status: 'in-review'
baseline_revision: 'f4e702a8d96f49edc4a1a13929f3a835e6cfc8df'
route: 'oneshot'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Owner-approved issues wait for a person to build them.

**Approach:** An agent-neutral prompt `docs/agents/implement.md` builds the owner-approved issues through the BMAD flow, unattended, in batches (at most 6 or ~3 hours per run, oldest first; each issue its own ticket and plan; one PR per batch with a `Fixes #N` / `Refs #N` line per issue; failures go to `blocked` and the batch goes on). It runs in the owner's single routine right after triage (`docs/agents/triage.md` hands over). It verifies each approval's actor from the issue events, never approves, merges, tags, or touches secrets, pushes only its session branch. `docs/issues.md`, `issue-flow.md`, the epic, and `MEMORY.md` describe it.

</intent-contract>

## Implementation Notes

Oneshot: two prompt files and docs. Owner decisions 2026-10-22: one routine for both agents; batches.

## Plan Change Log

## Review Triage Log

## Verification

- Dry run through the routine's prompt over the 7 approved issues: picks the batch, names paths, writes nothing.
- Real run: one PR with `Fixes` lines, issues in `in-review`, CI green.
