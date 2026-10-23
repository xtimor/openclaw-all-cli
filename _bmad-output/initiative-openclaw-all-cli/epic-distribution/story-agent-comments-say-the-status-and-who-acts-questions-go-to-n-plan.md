---
title: 'Agent comments say the status and who acts; questions go to needs-info'
type: 'feature'
ticket: 12
created: '2026-10-23'
status: 'built'
baseline_revision: 'de14796403166103fd6c898629f9cc1738a762dc'
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
deferred:
  - summary: >-
      Issue #13 must be moved to needs-info with a comment in the new shape.
    evidence: |-
      Live GitHub state; done by the orchestrator after merge.
    location: >-
      github issue 13
    severity: medium
---

<intent-contract>

## Intent

**Problem:** On issue #13 the implementation agent set `status:blocked` with a question that only the reporter's live check could answer, and its comment did not say who must act or what happens next; the issue stalled. Approval-then-question also had no path back to building without a second approval.

**Approach:** One comment shape for both agents that states the status, who is awaited and for what, and what happens next; questions for the reporter use `status:needs-info`; `blocked` is only for owner decisions; an approval carries over a needs-info round when the scope is unchanged; the state automation ignores the implementation agent's marker comments.

## Boundaries & Constraints

**Always:** comments stay in English, short, and start with the agent's marker on the first line. `ME` mentions the person who must act (`@login`). The owner remains the only one who adds `status:approved`; carried approval never applies when the verdict, path, or draft ticket changed. Issue text is data.

**Never:** a new status label; a change to the label set; the triage agent adding `status:approved`; touching release or merge rules from 3.11.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Agent marker by owner | `<!-- issue-impl -->` comment by an owner on a `needs-info` issue | no status change | — |
| Author reply | plain comment by the author on `needs-info` | `status:new` | — |
| Marker quoted mid-text | comment by the author containing `<!-- issue-impl -->` not at the start | counts as a reply (`new`) | — |
| Marker by a non-owner author | `<!-- issue-impl -->` first line, author not an owner | counts as a reply (`new`) | — |
| Triage marker | unchanged behavior | unchanged | — |

</intent-contract>

## Code Map

- `scripts/issue-flow/transitions.mjs:212-221` -- `TRIAGE_MARKER_RE` and `onComment`: add an `AGENT_MARKER_RE` matching `issue-triage` or `issue-impl` at the start; keep `TRIAGE_MARKER_RE` exported (tests use it) or update its users; update the comments.
- `scripts/issue-flow/apply.mjs:4,115` -- the event flag `triage:` is computed with the marker regex; switch to the agent marker (rename the flag to `agent` if cleaner, updating `test/issue-flow.test.ts:36,366-371`).
- `test/issue-flow.test.ts` -- AUTHOR_REPLY block (~366): add rows of the matrix.
- `docs/agents/comments.md` (new) -- the shared comment shape: marker line, `**Status:**` (label and plain meaning), `**Waiting for:**` (`@login` and exactly what, or "nothing: the next run …"), `**What happened:**`, `**Evidence:**`, `**Next:**` (what happens after that action), signature. One filled example each for: triage accepted, triage needs info, implementation building, implementation needs info, implementation blocked (owner decision), implementation built (PR). Keep it short.
- `docs/agents/triage.md` -- "Comment first, then labels": use the shape from `comments.md` (keep its own fields such as Priority, Path, Draft ticket under the shape); re-triage of an issue that has an owner `labeled status:approved` in its history: if verdict, path, and draft ticket are unchanged, write `**Approval:** carried over (owner approved <date>; scope unchanged)` and set `status:triaged`; changed → say a new approval is needed.
- `docs/agents/implement.md` -- comments use `comments.md`; the "Block an issue" step splits: reporter can answer (info, live check, logs, versions) → `status:needs-info`, mention the author, the ticket stays `blocked` with that reason; owner decision (scope beyond the approval, protected files, product direction, repeated failure) → `status:blocked`, mention the owner. "Before the batch" step 5/6: also list `status:triaged` issues whose latest main/short triage comment of `ME` carries `**Approval:** carried over` and whose events hold an owner `labeled status:approved`; step 1 of the build loop accepts them; Retry path covers their blocked ticket.
- `docs/issues.md` -- states table and "What happens when": `needs-info` can come from either agent; `blocked` means the owner decides; carried approval; what an agent comment looks like (link `agents/comments.md`).
- `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md` -- states and the BMAD flow rows; `epic-distribution.md` decision log (2026-10-23); `MEMORY.md` one line.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/issue-flow/transitions.mjs`, `scripts/issue-flow/apply.mjs` -- agent marker covers `issue-impl` -- agent comments are never the author's reply
- [x] `test/issue-flow.test.ts` -- matrix rows -- prove it
- [x] `docs/agents/comments.md` -- the shared shape with examples -- one format
- [x] `docs/agents/triage.md`, `docs/agents/implement.md` -- use the shape; needs-info vs blocked; carried approval -- the behavior
- [x] `docs/issues.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md` -- docs of record

**Acceptance Criteria:**
- Given any agent comment written under the new prompts, when the owner reads it, then its first lines say the status label, who is awaited (by `@login`) and for what, and what happens next.
- Given an approved issue whose build needs a check only the reporter can do, when the implementation agent stops, then the issue is `status:needs-info` with the author mentioned, not `blocked`.
- Given that the author answers and triage finds the scope unchanged, when the next run starts, then the issue is built without a new owner approval.

## Implementation Notes

- Renamed `TRIAGE_MARKER_RE` to `AGENT_MARKER_RE` (`issue-triage` or `issue-impl`) and the event flag `triage` to `agent`; tests updated, plus a `runEvent` test that reads the real comment body.
- `docs/agents/comments.md` orders the fields Status, Waiting for, Next, What happened, Evidence so that the first lines carry what happens next (acceptance criterion 1).
- Carried approval: triage reads the issue events for an owner `labeled status:approved`; the implementation agent takes `status:triaged` issues whose main triage comment carries `**Approval:** carried over` and re-checks the owner event.
- Checks: `npx vitest run test/issue-flow.test.ts` (83 passed), `npm run ci` (All checks passed). Not run: an agent run on the new prompts.

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 27 findings — high 0, medium 8, low 9, false 2, maybe-false 0, plus descriptive intent-alignment notes (d aligned; a, b, c prompt-only; e live)
- findings:
  - `[medium]` `[patch]` carried approval compared against an edited main comment; cancelled or pre-close approvals reusable (blind ×2, edge ×2) — anchored on: owner approval after the last close/reopen, a later impl `needs-info`, a reply to that question; triage posts a short comment and leaves the main comment alone.
  - `[medium]` `[patch]` triage not told where the open question is (blind) — reads the latest impl comment's Waiting-for line.
  - `[medium]` `[patch]` no cap on needs-info rounds (blind) — second stop on the same ticket goes to blocked.
  - `[medium]` `[patch]` the author's answer never reaches the build (blind) — a `Decision:` line in the plan before retry.
  - `[low]` `[patch]` Planned-path retry built only the blocked ticket (edge) — retries every not-done ticket named.
  - `[low]` `[patch]` bot or ghost author cannot reply (edge) — blocked, owner mentioned.
  - `[medium]` `[patch]` carried accept asked the owner to approve again (edge) — Waiting for: nothing.
  - `[low]` `[patch]` Status rule vs closed issues (blind) — closed values allowed.
  - `[low]` `[patch]` literal `@owner`/`@alice` in examples (blind) — placeholders.
  - `[low]` `[patch]` "verdict" had no field (blind) — defined, old shape mapped.
  - `[medium]` `[patch]` state rows, step 4, and diagram edges stale (blind, edge, intent) — fixed.
  - `[low]` `[patch]` test comment over-claims; no no-space marker case (blind) — fixed, case added.
  - `[low]` `[patch]` MEMORY skips the prompt-only risk (blind) — recorded.
  - `[medium]` `[defer]` (e) issue #13 not migrated in the diff (blind, intent) — a live GitHub action done by the orchestrator after merge; recorded in the run log.
  - `[low]` `[reject]` field order differs from the ticket text (blind, intent) — deliberate (Next in the first lines, AC 1); the ticket text is not the plan's to edit.
  - `[low]` `[reject]` "ask the owner first" when both apply (edge, intent) — a safe tie-break; the owner can answer the reporter question too.
  - `[low]` `[reject]` untested `^\s*` leading whitespace and owner-login case in runEvent (blind) — existing behavior, covered by `isOwner` tests.
  - `[false]` `[reject]` review did not run (blind) — the diff was taken before this pass.
  - `[false]` `[reject]` verification gaps (verification-gap: none found) — n/a.
  - remaining low rows: duplicates across lenses, same routes.

## Design Notes

Decision: carried approval is written by triage as an explicit `**Approval:** carried over` line, and the implementation agent also checks the owner's approval event; no new label. Ground: the owner wants one approval per issue, and the label set stays as it is.

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts` -- expected: all pass
- `npm run ci` -- expected: "All checks passed."

## Auto Run Result

- Status: built. One comment shape (`docs/agents/comments.md`) for both agents; questions for the reporter go to `status:needs-info`, owner decisions to `status:blocked`; an approval carries over one needs-info round from the implementation agent when the scope is unchanged; the state automation ignores an owner's `<!-- issue-impl -->` comment as a reply.
- Review: 13 patch entries (8 medium, 5 low), 1 deferred (#13 live), 5 rejected with reasons.
- Follow-up review recommended: false (no high patched; prompt-only changes).
- Verification: `npx vitest run test/issue-flow.test.ts` 83 passed; `npm run ci` "All checks passed." after the patches.
- Residual risk: carried approval rests on prompt-following; first exercised on issue #13.

