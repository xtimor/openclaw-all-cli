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

### 2026-10-22 — Review pass 1
- verdicts: 28 findings — high 6, medium 14, low 8; all patched by rewriting `docs/agents/implement.md` and aligning `issue-flow.md`, `docs/issues.md`, and the epic, except: owner review comments on the batch PR are handled by an agent session the owner asks (not the routine) — `[defer]`, noted in `docs/issues.md`.
- high: self-approval on failure (never `approved`; `blocked` instead); stranded `in-progress` (label just before each build; recovery of interrupted issues after 6 h); `bmad-correct-course` cannot run unattended as written (batch mode, approval deferred to the owner's merge as a `Decision:`, tickets via `bmad-ticket`); protected files and workflow secrets (protected list → blocked); scope open to post-approval edits (scope = main triage comment + body at approval; edited after approval → blocked); PR body keywords closing unrelated issues (keywords only on per-issue lines, no issue text).
- medium: planned and blocked-retry paths; `dev-orchestrator` unfit (not used; fresh subagent per build); branch-mismatch brief; exact invocation `ticket <ref>`; review depth; blocked order (commit plan and patch first); CI before done (ticket stays `built`, marked `done` after merge in the next batch); live checks; missing triage safety rules; branch handling; colliding batches (one open batch PR at a time); double pick (re-read labels); existing-ticket readiness (`tickets.py find`).
- low: approval-check fallback and case; GitHub CI and label wait (set `in-review` directly, owner merges only green); time limit measurement; context (subagents); issue-flow/epic not updated for batches; bundling side effect documented; full `tickets.py` command; early end with no approved issues.

## Verification

- Dry run through the routine's prompt over the 7 approved issues: picks the batch, names paths, writes nothing.
- Real run: one PR with `Fixes` lines, issues in `in-review`, CI green.
