---
title: 'A finished batch always reaches a ready PR; an idle draft is resumed, never rebuilt'
type: 'bugfix'
ticket: 21
created: '2026-10-27'
status: built
baseline_revision: '9444917dfacb416fc77db28fa06faa04dd7e3310'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment'] # run in-session by the build worker: no subagents were available
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/implement.md', '{project-root}/docs/agents/identity.md']
warnings: ['oversized']
deferred:
  - summary: >-
      The Stop hook (and two allow rules for `scripts/batch-pending.sh`) are not in `.claude/settings.json`: the owner adds them.
    evidence: |-
      The auto-mode permission classifier refused the edit of `.claude/settings.json` (hooks and permissions), and an agent may not
      grant itself either. The script, its tests, and the exact snippet (`docs/issues.md`, "Routine setup (owner)") are done; until the
      owner applies it, item (a) rests on the Run checklist and the routine prompt, which are prose.
    location: >-
      .claude/settings.json
    severity: medium
  - summary: >-
      The shared marker file may let a Stop hook nudge a worker session that finishes normally while a batch is claimed.
    evidence: |-
      The marker is one file in /tmp for the whole container; the hook counts blocks across sessions. Unverified: whether
      dev-orchestrator workers are separate sessions that load the project hook (here they are Agent-tool subagents, which fire
      SubagentStop, not Stop). A cloud run with the hook enabled would settle it. Bounded: at most three blocks, then the marker goes.
    location: >-
      scripts/batch-pending.sh
    severity: medium (unverified)
  - summary: >-
      The routine's own prompt cannot be changed by an agent; the owner pastes the text from `docs/issues.md`.
    evidence: |-
      The routine "Triage issues" is created and edited only in the claude.ai UI (MEMORY.md, ticket 3.9). The recommended prompt is in
      `docs/issues.md`, "Routine setup (owner)".
    location: >-
      docs/issues.md
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Batch PR #41 (issues #35-#40): the run built and closed all six tickets, then ended without the "Open the pull request" steps. The next run called the idle draft interrupted and set out to close it and rebuild everything (a chained relay call was refused by the permission check, which alone saved the work). The owner finished #41 by hand; the `ready_for_review` Batch merge run did not merge it; ticket 10 was closed done although its plan said blocked, review not run.

**Approach:** (a) the run cannot end between "tickets done" and "ready PR"; (b) an idle draft with built tickets is resumed on the run's own session branch, never closed or rebuilt; (c) the relay is called alone; (d) Batch merge waits for a final state on a ready or CI trigger; (e) a plan that says blocked or review not run is never closed as done. Deterministic guards first, prompt text second.

## Boundaries & Constraints

**Always:** the owner's single approval per issue; the relay and `Batch merge` keep their guards and the app identity; no proxy bypass; CI never pushes to `main`; a run pushes only its session branch (no force-push, no rebase of a pushed branch).

**Never:** add `status:approved`; edit `AGENTS.md`, `tickets.toml`, ticket files, or run logs; let an agent merge; close an idle draft that holds built tickets unless a new branch already carries its head.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Relay close of a draft with built plans | PR files include a plan at `done` or `built` at head | `pr_close` refused, nothing patched | exit 1, names the plan |
| Same, carried on | another open `claude/` PR by the app contains the draft's head | closed | — |
| Draft with no built plan | plans in progress or none | closed as before | — |
| Ready trigger, state not final | `mergeable_state` `unknown` or stale `draft`, `check` missing or running, status `pending` | re-read until final or the bound; merges when clean and green | skipped with "after N re-reads" |
| Final but not clean | `blocked`, `behind`, `dirty`, red check | skipped at once | exit 0 |
| Plan says blocked / review not run | `plan-gate` on the plan | exit 1 with the reason | ticket not closed done; issue blocked |
| Run claimed a batch and tries to end | marker set, no `clear` | stop hook blocks up to 3 times with the reason | marker removed after 3, or 12 h |

</intent-contract>

## Code Map

- `scripts/agent-write.mjs` -- `pr_close`: plans at `done`/`built` among the PR files refuse unless another open app `claude/` PR contains the head (`compare` ahead/identical); tests in `test/agent-write.test.ts`.
- `scripts/batch-merge.mjs` -- per-PR loop re-reads until the state and checks are final (run-wide budget `BATCH_MERGE_WAIT_MS` / `BATCH_MERGE_POLL_MS`); `test/batch-merge.test.ts`.
- `scripts/plan-gate.mjs`, `test/plan-gate.test.ts` -- (e), new; `_bmad/custom/dev-orchestrator.toml` `persistent_facts` runs it before `mark done`.
- `scripts/batch-pending.sh`, `test/batch-pending.test.ts` -- (a): marker + stop-hook script (logic in the script; the hook wiring in `.claude/settings.json` is the owner's, see Auto Run Result).
- `scripts/plan-gate.mjs --changed <base>`, `scripts/ci-check.sh`, `.github/workflows/ci.yml` (`fetch-depth: 0`) -- (e) backstop: CI is red when a branch adds or changes a plan that claims done/built and fails the gate.
- `test/agent-flow-docs.test.ts` -- (a)(c) doc contracts: relay shape, checklist, hook and settings pins.
- `docs/agents/implement.md` (checklist, resume, gate, relay alone), `triage.md`, `identity.md`, `docs/issues.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md` -- procedure and record.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/plan-gate.mjs` + test + orchestrator fact -- (e)
- [x] `scripts/agent-write.mjs` + test -- (b) relay guard
- [x] `scripts/batch-merge.mjs` + test + workflow comment -- (d)
- [x] `scripts/batch-pending.sh` + test -- (a); `.claude/settings.json` wiring left to the owner (deferred)
- [x] docs, doc-contract test, MEMORY -- (a)(b)(c)(e)

**Acceptance Criteria:**
- Given a draft batch idle over 2 hours whose branch holds `done` plans, when a run starts, then it merges that branch into its session branch, opens its own draft, closes the old one, builds only the tickets not done, and ends with a ready PR.
- Given the same draft and a `pr_close` for it with no new branch carrying it, then the relay refuses.
- Given a run that claimed a batch and has no ready PR, when it tries to stop and the owner has enabled the Stop hook, then the hook blocks it with the reason (the script is tested; enabling is the owner's).
- Given a `ready_for_review` run before GitHub has settled the PR, when the state turns clean and green inside the bound, then the PR is merged in that run.

## Implementation Notes

Subagents are unavailable to this worker (no Agent tool): implemented and reviewed in-session; the four thorough lenses were run by hand by the same session, not as independent context-free reviewers.

Decisions:
- Resume merges the old branch into the session branch; the relay guard `checkBuiltWork` and the Built (resumed) path are as in Design Notes.
- A gate failure blocks the issue and reverts its commits (the standard Block path): unreviewed code does not ride a batch that merges on green. CI adds the same gate on changed plans.
- `.claude/settings.json` was not edited: the auto-mode classifier refused the first attempt (a Stop hook and allow rules are permission and hook configuration), so the wiring is a snippet for the owner (`docs/issues.md`). Not worked around.
- `batch-merge` waits only where a state can still change; `dirty`, `behind`, and red checks are skipped at once. `BATCH_MERGE_UNKNOWN_DELAY_MS` is replaced by `BATCH_MERGE_WAIT_MS` / `BATCH_MERGE_POLL_MS`.
- No CHANGELOG line: internal (CI, the agent flow, tests, docs of the agents).

## Plan Change Log

## Review Triage Log

### 2026-10-27 — Review pass (in-session; blind-hunter floor N = 10: min(floor(sqrt(142) + 1), 10))
- verdicts: 20 findings — high 1, medium 5, low 11, false 2, maybe-false 1
- findings:
  - `[high]` `[patch]` first full `npm run ci` exited 1: the marker test wrote the hook input to a script that had already exited (unhandled EPIPE) — error handler on stdin; three reruns clean, full CI green.
  - `[medium]` `[patch]` `plan-gate` flagged a run whose `review` is `none` (asked for) because its text said skipped — `none` now skips the text check; test added.
  - `[medium]` `[patch]` the Built (resumed) path did not say how to find an issue's tickets — now from its `<!-- issue-impl -->` comment and `tickets.py find`.
  - `[medium]` `[patch]` a plan moved to a new name evaded `plan-gate --changed` and the resume command (rename excluded by `--diff-filter=AM`) — `--no-renames`; test added.
  - `[low]` `[patch]` `dev-orchestrator` with an empty scope after a resume — the doc says to skip to "Afterwards".
  - `[low]` `[patch]` `batch-merge` waited the whole budget on a PR that was already red while another run was still going — a failed run makes the answer final; test added.
  - `[maybe-false]` `[defer]` the marker is one file in /tmp, so a worker session that loads the hook could be nudged up to three times — what would settle it: a cloud run with the hook enabled (workers here are subagents, which fire SubagentStop); if true, medium.
  - `[low]` `[reject]` the relay guard ignores non-ticket `plan-<slug>.md` files — the agent flow builds tickets only, and ticket plans are always `*-plan.md`.
  - `[low]` `[reject]` the re-read budget is shared, so a second batch PR may get no re-read — one batch PR is open at a time by design; the next trigger retries.
  - `[low]` `[reject]` `BATCH_MERGE_POLL_MS=0` turns off re-reads silently — a test knob; the default is 15000.
  - `[low]` `[reject]` `compare` of a deleted or force-pushed carrier gives 404, reported as failed, not refused — fails closed either way; the list stops and nothing is closed.
  - `[low]` `[reject]` a plan over 1 MB has no `content` in the contents API and is refused — plans are a few kB, and refusing is the safe side.
  - `[false]` a plan saved with CRLF would not parse — `field` and the frontmatter regex tolerate `\r` (test `CRLF` added to prove it).
  - `[false]` two Batch merge runs (ready and CI) race and one waits 5 minutes while the other is dropped — GitHub keeps one pending run per group, the surviving run re-reads everything, and the merge call carries the head sha, so nothing merges twice or unchecked.
  - `[low]` `[reject]` the CI gate fails when a branch touches an old plan that predates `review` — only plans the branch adds or changes; the four such plans are in `epic-cursor-cli` and nobody edits them; the fix is a line in that plan.
  - `[medium]` `[defer]` the Run checklist and the orchestrator's use of the done gate are prose — only the relay guard, the CI plan gate, and the (owner-enabled) stop hook are code; see deferred items 1 and 3.
  - `[low]` `[reject]` the doc-contract tests are source-text pins and do not run behavior — kept as tripwires for wording a run follows; each script behind them has its own runtime tests.
  - `[low]` `[reject]` no end-to-end test of the resume procedure (git merge, relay order, real GitHub) — the relay order and guard are tested in one list (`pr_create` then `pr_close`), the merge is plain git; the live check is listed as not run.
  - `[medium]` `[defer]` (a) wants the routine prompt to say the run ends only after the PR steps — only the owner can edit the routine; text given in `docs/issues.md`.
  - `[low]` `[reject]` (b) "closed only after merging its useful commits is not possible" could mean a nothing-built draft is also closed at once — implemented as merge first, close only on a conflict with nothing built; the ticket's wording allows this reading.

### 2026-10-27 — Independent review of 9444917..HEAD (coordinator), all patched
- verdicts: 9 findings — high 2, medium 3, low 4
- findings:
  - `[high]` `[patch]` the one-dispatch retire could never succeed: `pr_close` re-read the PR, whose `updated_at` the `comment` and `pr_edit` before it had refreshed, so the idle check refused — every `pr_close` target (idle, author, title, built plans) is now read and checked in `prepare` before any operation is applied; at the close only the carrier (made by the earlier `pr_create`) and an unchanged head are checked. Tests: `RETIRE_IN_ONE_DISPATCH` (the stub bumps `updated_at` after a write), a list refused whole when the pre-apply read is not idle, a changed head refused; mutation (idle re-check at the close) fails them.
  - `[high]` `[patch]` plan-gate permanently failed a ticket blocked once and finished later: it read the first `## Auto Run Result` — now the last section whose heading starts with it, and in it the latest status line. Tests `SECTIONS` (two sections, and a block then a finished status in one section).
  - `[medium]` `[patch]` false red CI on a PR that edits or renames a plan already done on `main`: `--changed` now uses rename detection, skips a plan finished at the merge base (same path or rename source) that keeps its status, and subtracts the problems a finished base already had; an unfinished base is judged in full. Tests `HISTORY`, `BECOMES_FINISHED`.
  - `[medium]` `[patch]` over-broad phrases: `Blocking condition: none`, "Edge-case lens review skipped (diff too small); blind review ran", and "a follow-up review is still owed for ..." now pass; the gate trips on a sentence-level "Review not run/skipped", `no review ran`, `Status: blocked` as the latest status, or a real blocking condition. Tests in `NO_FALSE_POSITIVES` and `BACKLOG_CLASH`.
  - `[low]` `[patch]` the docs gave two actions for a resumed plan at `done` that fails the gate — one now: block that issue for the owner with the printed reason (Before the batch 2.3, Built (resumed), Existing ticket); pinned in `agent-flow-docs`.
  - `[low]` `[patch]` tests that did not test what they claimed: the `/pulls` mock returns the carrier only after the `POST` (`@created` answers), plan contents are asserted at `?ref=<head sha>`, the unused `contentsKey` is gone.
  - `[low]` `[patch]` the Batch merge wait counted re-reads: now one `Date.now()` deadline (300 s default, under the 10-minute job timeout), a protected-file batch is skipped before waiting, and a PR with no check run at all waits only `BATCH_MERGE_NO_CHECKS_MS` (60 s). Tests `DEADLINE`, `PROTECTED_FIRST`, `NO_CHECKS`.
  - `[low]` `[patch]` the resume steps used `FETCH_HEAD` and `origin/<head>`: one ref, `git fetch origin <head>:refs/remotes/origin/<head>` then `origin/<head>`; pinned.
  - `[low]` `[patch]` "step 5" in Open the pull request step 1 pointed at the wrong step: now "step 3"; pinned.

## Design Notes

- Resume merges the old branch into the session branch (`git merge --no-edit origin/<old>`): a run pushes only its session branch, so the old branch cannot be continued in place. Fast-forward when `main` did not move, a merge commit when it did; never a rebase or force-push. A conflict aborts: no built ticket on the old branch means close and rebuild as before, else report for the owner.
- The old draft is closed only after the new draft exists (same dispatch, in order); the relay checks at apply time that the new head contains the old one.
- Why `batch-merge` missed #41, from the script: after `ready_for_review` GitHub can still answer `mergeable_state: draft` (or `unknown`) for a moment. Only `unknown` was re-read (3 times, 10 s); `draft` skipped at once, and CI had completed earlier while the PR was a draft. The manual dispatch a minute later saw `clean`.
- A failing gate blocks the issue and reverts its commits (unreviewed code does not merge on green); the owner re-approves to rebuild with review.

## Verification

**Commands:**
- `npx vitest run test/plan-gate.test.ts test/agent-write.test.ts test/batch-merge.test.ts test/batch-pending.test.ts test/agent-flow-docs.test.ts test/agent-relay.test.ts` -- expected: all pass
- `node scripts/plan-gate.mjs --changed origin/main` -- expected: exit 0
- `npm run ci` -- expected: "All checks passed."

**Manual checks:**
- Live (not run here): the next batch run ends with a ready PR merged by the bot; a simulated idle draft with done tickets is resumed, not closed.

## Auto Run Result

**Summary:** (a) `docs/agents/implement.md` has a nine-item Run checklist that the run re-reads after `dev-orchestrator`, and `scripts/batch-pending.sh` (marker plus a stop-hook command, tested) that blocks the session from ending between the batch claim and the ready PR. (b) An idle `Issue batch (in progress)` draft is resumed: its branch is merged into the run's own session branch, built tickets are kept, only the rest is built, and the old draft is closed in the dispatch that opens the new one; the relay's `pr_close` now refuses a draft that holds a `done`/`built` plan unless another open batch PR of the app contains its head. (c) The relay is called alone, stated in `implement.md`, `triage.md`, `identity.md`, and pinned by a doc test. (d) `scripts/batch-merge.mjs` re-reads (run-wide budget about 5 minutes) while the PR state or checks are not final, so a `ready_for_review` run merges a PR that GitHub has not settled yet. (e) `scripts/plan-gate.mjs` refuses to call a ticket finished when its plan carries a blocked status or admits the review never happened; the orchestrator and the run call it, and `npm run ci` runs it on the plans a branch changes, so such a batch is red.

**Files changed:** `scripts/{plan-gate.mjs,batch-pending.sh,agent-write.mjs,batch-merge.mjs,ci-check.sh}`, `.github/workflows/{ci.yml,batch-merge.yml}` (a `fetch-depth: 0` and a comment), `_bmad/custom/dev-orchestrator.toml`, `docs/agents/{implement,triage,identity}.md`, `docs/issues.md`, `issue-flow.md`, `epic-distribution.md`, `MEMORY.md`; tests `test/{plan-gate,batch-pending,agent-flow-docs,agent-write,batch-merge}.test.ts`.

**Review:** 20 findings from four lenses run in-session; 6 patched (1 high, 3 medium, 2 low), 3 deferred (medium; one unverified), 11 rejected or false with reasons in the triage log.

**Follow-up review recommended: true.** The unverified risk: the four lenses were run by the build session itself, not by independent context-free reviewers; the code worth a second, independent read is `checkBuiltWork` (`scripts/agent-write.mjs`) and the re-read loop in `scripts/batch-merge.mjs`. Patched: high 1 (a test defect), medium 3, low 2.

**Verification:** `npm run ci` passed (typecheck, 48 test files, build, package checks, install smoke, the plan gate step); mutation checks: removing the relay guard, the carrier exception, the `draft` state, or the pending-check rule each fails a test.

**Not run:** any live check (a routine run with the checklist, a resumed idle draft through the real relay, the stop hook in a cloud session, the `Batch merge` wait on a runner); these need a real GitHub run.

**Residual risks:** the stop hook is not enabled until the owner applies the snippet in `docs/issues.md`; the routine prompt is the owner's to edit; `Batch merge` still merges nothing for a batch that changes a protected file (this one does), so the owner merges this change.

## Auto Run Result (independent review fixes)

- Status: built. Nine findings of the coordinator's independent review are fixed, each with a test (see the triage log): the relay checks every `pr_close` target before applying any operation; `plan-gate` reads the last result section and its latest status, uses narrow sentence-level phrases, and in `--changed` flags only what a branch makes newly true; Batch merge waits on a clock deadline, skips a protected batch first, and bounds the no-check-runs wait; the resume docs use one ref and one action.
- Follow-up review recommended: true (two high patches, a follow-up pass rule). The unverified risk: the new `prepare`/`requireCarried` split in `scripts/agent-write.mjs` and the `--changed` rename/base logic in `scripts/plan-gate.mjs` were written after the independent review and have had no independent re-read; each is pinned by tests that fail without it.
- Verification: focused vitest files and `npm run ci`; the six done plans on `main` that fail the gate when named directly are not red under `--changed`.
- Still unverified live: a routine run with the checklist, a resumed draft through the real relay, the stop hook, the Batch merge wait on a runner.
