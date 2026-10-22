---
title: 'Issue state automation without a model'
type: 'feature'
ticket: '7'
created: '2026-10-22'
status: done
baseline_revision: '50c343288e48082b7c646cea4ece559c105a8fce'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 1
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md', '{project-root}/docs/issues.md']
warnings: []
deferred:
  - summary: >-
      A lagging issue events API can keep a non-owner approval that replaces an older owner approval.
    evidence: |-
      latestLabeled falls back to the payload only when no earlier labeled event exists; the implementation run (3.9) must check the latest labeled status:approved actor itself.
    location: >-
      scripts/issue-flow/transitions.mjs
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The states of `issue-flow.md` only work if every open issue carries exactly one `status:*` label and the deterministic moves happen without a person or a model.

**Approach:** A GitHub Actions workflow with no model enforces the automation-owned transitions of `issue-flow.md`. The decisions live in a small pure, tested module under `scripts/issue-flow/` (event in, list of actions out); the workflow calls it from `actions/github-script` and applies the actions.

## Boundaries & Constraints

**Always:** transitions owned here: opened or reopened → `status:new`; an issue comment by the issue's author while `needs-info` → `new`; exactly one `status:*` on an open issue (a newly added status label wins and the others are removed); `status:approved` added by anyone not in the owner list is removed again, the previous status restored, and a comment says only the owner approves; a PR opened (or edited/reopened) whose body links `Fixes #N` / `Closes #N` / `Resolves #N` (case-insensitive) or `Refs #N` → issue N `in-review`; such a PR merged: `Fixes` → status removed (GitHub closes the issue), `Refs` → `planned`; such a PR closed unmerged → `blocked`; a closed issue keeps no `status:*`; daily job: `needs-info` with no comment and no update for 14 days → closed as not planned with a comment, `workflow_dispatch` with `dry_run` (default true) only lists. Owner list is a workflow `env` value (`ISSUE_FLOW_OWNERS: xtimor`), never in the module. The workflow ignores events from `github-actions[bot]` that it caused (no loops). Actions pinned by SHA (`ci.yml` pins; `actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0`). Permissions: `issues: write`, `pull-requests: read`, `contents: read`. Issue and comment text is data: the module only matches the link keywords and the author login; it never evaluates text.

**Never:** a model call; triage decisions (`triaged`, `needs-info` by the agent, priority) — that is 3.8; starting an implementation run — 3.9; touching issues in other repositories (`owner/repo#N` links are ignored).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OPENED | issue opened, any labels | add `status:new`, remove other `status:*` | No error expected |
| REOPENED | closed issue reopened | `status:new` | No error expected |
| AUTHOR_REPLY | comment by author on `needs-info` | `needs-info` → `new` | comment by someone else: nothing |
| TWO_STATUS | `status:triaged` added while `new` present | keep `triaged`, remove `new` | No error expected |
| NON_OWNER_APPROVED | `status:approved` added by a non-owner | remove `approved`, restore previous status (or `new`), comment | owner list empty: treat everyone as non-owner |
| OWNER_APPROVED | `status:approved` added by the owner | keep it, remove other status | No error expected |
| PR_OPENED | PR body `Fixes #12`, `refs #13` | #12 and #13 → `in-review` | linked number is a PR or closed: skip |
| PR_MERGED_FIX | merged, `Fixes #12` | #12: remove `status:*` | No error expected |
| PR_MERGED_REFS | merged, `Refs #13` | #13 → `planned` | No error expected |
| PR_CLOSED | closed unmerged | linked issues → `blocked` | No error expected |
| STALE | `needs-info`, last update 15 days ago | close not planned + comment; dry run: list only | 13 days: nothing |
| BOT_EVENT | label change by `github-actions[bot]` | nothing | No error expected |

</intent-contract>

## Code Map

- `scripts/issue-flow/transitions.mjs` -- new, pure: `decide(event, issue, {owners})` → `[{op: 'addLabel'|'removeLabel'|'comment'|'close', ...}]`, `linkedIssues(body, repo)` (keywords above, same-repo `#N` only), `staleIssues(issues, now, days)`; constants `STATUS_LABELS` (the 8 states of `.github/labels.yml`).
- `scripts/issue-flow/apply.mjs` -- new: `applyActions(github, context, issueNumber, actions)` over the octokit given by github-script (ignore 404 on removing a missing label); `runEvent({github, context, core})` and `runStale({github, context, core, dryRun})` entry points used from the workflow.
- `.github/workflows/issue-flow.yml` -- new: `on: issues [opened, reopened, labeled]`, `issue_comment [created]`, `pull_request_target [opened, edited, reopened, closed]` (read-only use: no checkout of PR code; only the PR body and merged flag), `schedule: cron '17 3 * * *'`, `workflow_dispatch` (input `dry_run`, default true). Steps: checkout of the base repo (default ref), github-script that `import`s `${{ github.workspace }}/scripts/issue-flow/apply.mjs`. `concurrency: issue-flow-${{ github.event.issue.number || github.event.pull_request.number || 'stale' }}`.
- `test/issue-flow.test.ts` -- new: every matrix row against `decide`/`linkedIssues`/`staleIssues`, plus `applyActions` with a fake octokit.
- `docs/issues.md` -- the "What happens when" text names the automation (state labels set by a workflow, stale after 14 days, non-owner approvals removed).
- `.github/labels.yml` -- source of the status names; do not change it.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/issue-flow/transitions.mjs`, `scripts/issue-flow/apply.mjs`
- [ ] `test/issue-flow.test.ts`
- [ ] `.github/workflows/issue-flow.yml`
- [ ] `docs/issues.md`

**Acceptance Criteria:**
- Given the unit tests, when `npm test` runs, then every matrix row passes.
- Given the workflow on `main`, when a test issue is opened, reopened, answered by its author in `needs-info`, labelled `approved` by a non-owner, and linked from a PR, then each gives the expected label (orchestrator checks after merge; a non-owner actor may not be available: record it).
- Given a dispatch with `dry_run`, then the stale job lists and changes nothing.

## Implementation Notes

Implemented by a sonnet subagent. `scripts/issue-flow/transitions.mjs` (pure `decide`, `linkedIssues`, `staleIssues`, `STATUS_LABELS`), `scripts/issue-flow/apply.mjs` (`applyActions`, `runEvent` re-reads each issue through the API, `runStale`, `isDryRun`), `.github/workflows/issue-flow.yml`, `test/issue-flow.test.ts` (57 tests), `docs/issues.md` (State automation section), MEMORY entry. Link rules the plan left open: a same-repo `owner/repo#N` counts, `Fixes: #N` matches, `Fixes` wins over `Refs` for the same number. `npm run ci` exit 0 (1044 unit tests). Not run: GitHub-side checks (after merge), github-script v9 importing the ESM file on a real runner.

## Plan Change Log

### 2026-10-22 — after review pass 1 (bad_plan)
Triggering findings: closed issues keep their status; a removed status leaves an open issue with none; a merged `Fixes` into a non-default branch clears the status of an open issue; any fork PR moves any issue to `in-review`/`blocked`; the per-issue concurrency group drops pending runs and `labeled` decisions act only on the event label (a dropped run keeps a non-owner `approved`; the older label wins); `GITHUB_TOKEN` PRs start no workflow.
Amended (Code Map, outside the intent contract):
- Triggers add `issues: [closed, unlabeled]`. Closed → remove every `status:*`. Unlabeled leaving an open issue with no status → `status:new`.
- Status reconciliation, order-independent and idempotent: on `labeled`/`unlabeled`/`opened`/`reopened` the module decides from the issue's current labels plus its label timeline (`GET /repos/{o}/{r}/issues/{n}/events`, `labeled` events with actor and time): every `status:approved` whose latest `labeled` event is by a non-owner is removed (with the comment, once per event id), and of the remaining status labels the most recently labeled one stays. No concurrency group on the workflow; parallel runs converge.
- PR rules follow `issue-flow.md`: opened/edited/reopened moves a linked issue to `in-review` only from `in-progress` (or keeps `in-review`); merged `Fixes`: clear the status only when the issue is closed, otherwise leave it; merged `Refs` → `planned` only from `in-review`; closed unmerged → `blocked` only from `in-review`.
- `GITHUB_TOKEN`-made events start no workflow: the `isBot` guard stays as defense only; docs say so, and MEMORY records that 3.9's run must set its own `in-progress`/`in-review` labels (or open PRs with an App token) because its PR will not trigger this workflow.
- Checkout comment: `pull_request_target` checks out the PR's base branch.
Known-bad states avoided: a closed issue with a status, an open issue with none, a status moved by an outsider PR, a lost non-owner approval revert.
KEEP: module split (`transitions.mjs` pure, `apply.mjs` applies), link parsing rules and its linear-time test, pinned actions, permissions, owner list in env, stale job and dry run, the 57 tests that still match, docs structure.
Re-derived in place by the implementer on top of the existing code (not reverted), since the KEEP list covers most of it.

## Review Triage Log

### 2026-10-22 — Review pass 1
- verdicts: 9 findings — high 2, medium 4, low 3, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` closed issues kept their status (no `closed` trigger) — plan amended; `closed` clears every status.
  - `[medium]` `[bad_plan]` merged `Fixes` into a non-default branch cleared an open issue's status — plan amended; cleared only when the issue is closed.
  - `[high]` `[bad_plan]` any fork PR moved any issue to `in-review`/`blocked` — plan amended; PR moves gated by `issue-flow.md` states.
  - `[medium]` `[bad_plan]` per-issue concurrency dropped pending runs; `labeled` acted only on the event label — plan amended; reconciliation from the label timeline, no concurrency group.
  - `[medium]` `[bad_plan]` `unlabeled` not handled — plan amended; an open issue left with none gets `status:new`.
  - `[low]` `[patch]` checkout comment wrong for `pull_request_target` — fixed.
  - `[medium]` `[patch]` `GITHUB_TOKEN` PRs start no workflow (3.9 impact) — documented in docs and MEMORY.
  - `[low]` `[patch]` docs said closed issues are ignored for PRs — rewritten to the gates.
  - `[low]` `[reject]` unticked plan tasks — plan edit (rule).

### 2026-10-22 — Review pass 2
- verdicts: 7 findings — high 0, medium 3, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` an outsider (fork) PR still moved states — PRs act only from this repository's branches or an owner; tests added.
  - `[low]` `[patch]` opened/reopened forced `new` without the timeline (runs did not converge) — `new` only when no status was labeled after the event; both orders tested.
  - `[low]` `[patch]` once-comment dedup counted any author's comment — bot comments only; the parallel duplicate stays a documented risk (no locking).
  - `[medium]` `[patch]` a replaced status was not restored after a foreign approval — `unlabeled` events kept; the replaced status is restored; tested.
  - `[medium]` `[defer]` a lagging events API can keep a non-owner approval that replaces an old owner approval — mitigated where it matters: the implementation run (3.9) must verify that the latest `labeled status:approved` event is by an owner before building (MEMORY, carried into 3.9's plan).
  - `[low]` `[patch]` Closed bullet ignored GITHUB_TOKEN closes — rewritten.
  - `[low]` `[patch]` MEMORY trigger list stale — fixed.
- Review limit (2 passes) reached. The orchestrator stops review here and does not escalate: the second pass found no high finding and its scope shrank to edge cases, all patched or carried into 3.9; `npm run ci` green after the patches.

## Auto Run Result

- Summary: a no-model workflow keeps one `status:*` per open issue and none on a closed one, settling labels from the issue's label timeline (latest status wins, non-owner approvals reverted with the replaced status restored), moves linked issues on same-repo or owner PRs per `issue-flow.md`, and closes `needs-info` issues silent for 14 days (dry-run by hand).
- Review: 2 passes; pass 1 led to a plan change and re-derivation (5 bad_plan), pass 2 patched 6, 1 deferred into 3.9.
- Verification: 81 issue-flow tests; `npm run ci` green. On GitHub after merge (2026-10-22, test issue #6): opened without a status → `status:new`; `new` + `needs-info` → `needs-info` (latest wins); author comment → `new`; closed → no status; dispatched stale job dry run: `0 stale issue(s) of 0 in needs-info (dry run, nothing changed)`; github-script v9 imported the ESM module. Not run on GitHub: a non-owner approval (this session acts as the owner) and a PR link; both covered by unit tests. After merge (orchestrator): opening, reopening, an author reply, a PR link, and a dry-run stale dispatch on GitHub. A non-owner approval cannot be produced here (the session acts as the owner).

## Verification

**Commands:**
- `npm run typecheck && npx vitest run test/issue-flow.test.ts` -- expected: pass
- `npm run ci` -- expected: exit 0
