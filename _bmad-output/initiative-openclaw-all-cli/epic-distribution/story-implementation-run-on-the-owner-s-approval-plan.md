---
title: 'Implementation run on the owner''s approval'
type: 'feature'
ticket: '9'
created: '2026-10-22'
status: 'built'
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

- 2026-10-22, user: build the batch with `dev-orchestrator` instead of calling `bmad-build-auto` per ticket. `docs/agents/implement.md` creates the tickets first, then runs `dev-orchestrator` over them in the session; `_bmad/custom/dev-orchestrator.toml` sets `blocked_policy = "continue"` so a blocked ticket does not stop the batch.

## Review Triage Log

### 2026-10-22 — Review pass 1
- verdicts: 28 findings — high 6, medium 14, low 8; all patched by rewriting `docs/agents/implement.md` and aligning `issue-flow.md`, `docs/issues.md`, and the epic, except: owner review comments on the batch PR are handled by an agent session the owner asks (not the routine) — `[defer]`, noted in `docs/issues.md`.
- high: self-approval on failure (never `approved`; `blocked` instead); stranded `in-progress` (label just before each build; recovery of interrupted issues after 6 h); `bmad-correct-course` cannot run unattended as written (batch mode, approval deferred to the owner's merge as a `Decision:`, tickets via `bmad-ticket`); protected files and workflow secrets (protected list → blocked); scope open to post-approval edits (scope = main triage comment + body at approval; edited after approval → blocked); PR body keywords closing unrelated issues (keywords only on per-issue lines, no issue text).
- medium: planned and blocked-retry paths; `dev-orchestrator` unfit (not used; fresh subagent per build); branch-mismatch brief; exact invocation `ticket <ref>`; review depth; blocked order (commit plan and patch first); CI before done (ticket stays `built`, marked `done` after merge in the next batch); live checks; missing triage safety rules; branch handling; colliding batches (one open batch PR at a time); double pick (re-read labels); existing-ticket readiness (`tickets.py find`).
- low: approval-check fallback and case; GitHub CI and label wait (set `in-review` directly, owner merges only green); time limit measurement; context (subagents); issue-flow/epic not updated for batches; bundling side effect documented; full `tickets.py` command; early end with no approved issues.

### 2026-10-22 — Review pass 2
- verdicts: 9 findings — high 3, medium 5, low 1; all patched.
- high: builds in a subagent cannot start `bmad-build-auto`'s own subagents (builds now run in the session itself; MEMORY lesson); a block after a built plan lost the plan and reason (revert first, then `mark blocked`, commit); the body-edit check had no API (scope is the main triage comment; the body only where it agrees).
- medium: retry left the tree dirty (commit the `mark draft`); existing-ticket path lacked a ticket link and status checks (ticket named in the `<!-- issue-impl -->` comment; `blocked` → retry, `built`/`in-review`/`done`/`dropped` → block); course correction never committed or applied its document edits (apply, create tickets, commit); overlapping runs (draft batch PR opened at the first commit); protected list missed files the run executes (`scripts/`, `_bmad/`, `.claude/`, `.agents/`, `package.json` scripts).
- low: ticket lifecycle (housekeeping marks `done`/`dropped` and ships even without builds; `issue-flow.md` aligned; no `dev-orchestrator` left).
- Review limit (2 passes) reached; no escalation: pass 2's highs were mechanical and are patched; the first live run is the remaining proof.

## Auto Run Result

- Summary: `docs/agents/implement.md` builds owner-approved issues in batches after triage in the owner's single routine: approval verified from issue events, protected files and strategic choices block, one draft batch PR claims the run, BMAD build per ticket in the session, blocked issues recorded, housekeeping of ticket states, no self-approval, merge, or secrets.
- Verification: two review passes; the live run on issues #8–#14 (approved by the owner) is the acceptance check, after merge.

## Verification

- Dry run through the routine's prompt over the 7 approved issues: picks the batch, names paths, writes nothing.
- Real run: one PR with `Fixes` lines, issues in `in-review`, CI green.
