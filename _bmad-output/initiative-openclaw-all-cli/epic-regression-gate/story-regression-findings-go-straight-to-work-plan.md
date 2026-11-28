---
title: 'Regression findings go straight to work'
type: 'feature'
ticket: '11'
created: '2026-11-28'
status: done
baseline_revision: 'd467522'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** An issue a regression run files (the weekly beta run today, the release loop of ticket 8 later) enters the normal issue flow: triage, then the owner's own-click `status:approved`, so a found regression waits for the owner. The owner decided (2026-11-28) that "if the regression found something, we fix it at once": no triage, no approval.

**Approach:** A `source:regression` label marks such issues. Triage skips them; the implementation run takes them like approved issues, with the own-click approval check replaced by a check that `source:regression` was added by a trusted writer (this repository's workflows, `github-actions[bot]`, or the configured agent identity, never an outside account); the state automation does not revert or demote them; the beta issue script files with `source:regression` and `type:bug`.

## Boundaries & Constraints

**Always:** the own-click rule stays exactly as it is for every other issue (an agent still never adds `status:approved` or `status:rework`); trust is decided from the issue's events (who added `source:regression`), not from the label alone, so an outsider or an agent session labelling an issue `source:regression` gains nothing (the automation removes an untrusted `source:regression`, the same way it reverts an untrusted approval); a regression issue still gets a ticket, a reproduction test, a ledger entry and the normal batch pull request and `Batch merge`; docs and agent rules say the exception in one place each and link it; English.

**Never:** change `src/`; let `source:regression` bypass `Batch merge`'s green-checks rule or the owner's ability to stop a batch; change how `status:rework`, `upstream:post`, or other owner-only labels work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Beta red | `regression-beta.yml` opens an issue | labels `source:regression`, `type:bug`, `regression:beta`, and the status the flow uses for ready-to-build regression issues | idempotent per run as today |
| Trusted label | `source:regression` added by `github-actions[bot]` or the agent identity | triage skips it; the next implementation run builds it without `status:approved` | none |
| Untrusted label | `source:regression` added by an outside account or a Claude session through an app | the automation removes it (or leaves it untrusted), and the issue takes the normal path | named in the run's report |
| Owner stops it | the owner moves it to `status:blocked` or closes the batch | the run respects the owner's state as for any issue | none |

</intent-contract>

## Code Map

- `.github/labels.yml`, `test/sync-labels.test.ts` -- add `source:regression` (the count test needs raising, as in 4.4).
- `scripts/regression-beta-issue.mjs`, `test/regression-beta-issue-script.test.ts` -- today labels `regression:beta` + `status:todo` and no type; change to the regression path.
- `scripts/issue-flow/` (`transitions.mjs` and its callers), `.github/workflows/issue-flow.yml` (`ISSUE_FLOW_OWNERS`), their tests -- where untrusted approvals are reverted; add the `source:regression` trust rule and keep a trusted regression issue in its status.
- `docs/agents/implement.md` (Before the batch steps 5 and 6: listing and approval check), `docs/agents/triage.md` (skip rule, next to the Rework skip), `docs/agents/identity.md` (the agent identity), `docs/issues.md` (labels table and the owner's view), `_bmad-output/initiative-openclaw-all-cli/epic-distribution/issue-flow.md` (the design: one line for the exception).
- `MEMORY.md` -- the decision with its date.

## Tasks & Acceptance

**Execution:**
- [x] `.github/labels.yml` + test -- `source:regression`
- [x] `scripts/regression-beta-issue.mjs` + test -- regression labels
- [x] `scripts/issue-flow/*` + tests -- trust rule for `source:regression`
- [x] `docs/agents/implement.md`, `docs/agents/triage.md`, `docs/issues.md`, `issue-flow.md` -- the exception
- [x] `MEMORY.md` -- the decision

**Acceptance Criteria:**
- Given an issue with a trusted `source:regression`, when triage and the implementation run read the rules, then triage skips it and the run builds it without an approval.
- Given `source:regression` added by an untrusted actor, when the automation runs, then the issue gets no shortcut.
- Given `npm test` and `npm run typecheck`, then both are green.

## Implementation Notes

- Decision: the ready-to-build status of a trusted regression issue is the existing `status:todo`, plus the `source:regression` trust check; no new status. Why: (1) `todo` is the status the state automation itself converges on: it sets `todo` on every opened and reopened issue (`statusOnIssues`), so an issue a future workflow files with the agent app token (whose `opened` event does start `Issue flow`) would be reset to `todo` whatever status it was filed with; a `GITHUB_TOKEN`-made issue starts no run and keeps the labels the script set. (2) `todo` is not owner-only, so `reconcile` never reverts it, and the latest-status rule still lets the owner stop it with any other status. (3) Triage already lists only `todo`, so one skip rule (trusted `source:regression`) keeps it away, and the implementation run lists `todo` + trusted `source:regression` right after rework. `status:approved` was rejected (it would break "approved = the owner's own click", which `Upstream post` and the docs rely on), `status:triaged` and `status:planned` were rejected (an app-opened issue is reset to `todo`, and both mean something else).
- Decision (revised after the security review, see Review Triage Log): trust is bound to the run, not to a login. `github-actions[bot]` is shared by every workflow, and a write collaborator (or a Claude session as the owner) can dispatch `regression-beta.yml --ref <branch>` with a changed script or open a same-repo pull request whose workflow asks for `issues: write`. Trusted only when all hold: author and the label's latest `labeled` actor are `github-actions[bot]` (the only regression writer; the agent app is dropped until ticket 8 needs it, because its token is also held by `batch-merge` and `upstream-post`); the body's exact first line is `<!-- regression-beta run=<id> -->` (`regressionRunRef`; a forced run writes `... forced -->`, which matches nothing); the run (`GET /repos/{o}/{r}/actions/runs/<id>`) has `path` in `REGRESSION_WORKFLOWS` (allow-list, ticket 8 adds the release workflow), `head_branch` `main`, `event` `schedule` or `workflow_dispatch`, `repository` and `head_repository` this repository, a `head_sha` that `compare <sha>...main` calls `identical` or `ahead`, and the issue's `created_at` and the label's time within `run_started_at`..`updated_at` (`regressionRunVerdict`; a run not yet completed is `pending`: nothing decided, only after every static check passed). An unreadable run or compare is untrusted. The agents' check (implement.md) adds an unedited body (GraphQL `lastEditedAt` null).
- Decision: `scripts/issue-flow/transitions.mjs` `regressionLabelActions` (from `onIssues` for opened, reopened, closed, labeled, unlabeled on open issues) removes an untrusted label with one comment (`regressionComment`) and never touches the status; status actions come first. Actors judged: the timeline's latest `labeled` event and, for a handled `labeled source:regression` event, the payload's actor too (an untrusted one wins); no labeled event at all is unproven and removed. `apply.mjs` `readRegressionRun` reads the run and the compare (`issue-flow.yml` now has `actions: read`) only for an open `issues` event on an issue with the label, and passes `{run, onMain}` and `repo` to `decide`; a missing `regression` option counts as unreadable. `needsTimeline` is true for any open issue with the label; the event re-read loop covers a handled `labeled source:regression`.
- Decision: the shortcut ends for good (`regressionShortcutEnded`) at a `labeled status:blocked` or `status:declined` event, or a `closed` event, after the label (and at a handled `labeled` blocked/declined whose event is not listed yet); the automation then removes the label with `regressionEndedComment`, and `onPullRequest` does the same when a batch pull request closed unmerged moves a regression issue to `blocked`. So anyone with triage rights or the relay (which may set `status:todo`) cannot revive an issue the owner stopped. The finer rule the review offered (track every non-writer status change) was not taken: the simplest form is what it named. The agents' check has the same rule (implement.md item 1.4).
- Decision: `scripts/agent-write.mjs` refuses adding `source:regression` (removing is fine), and `scripts/sync-labels.mjs` refuses `renamed_from` on any `source:*` label and on `status:approved`, `status:rework`, `status:upstream`, `upstream:post` (a rename adds the target to every issue of the old label as `github-actions[bot]`). The beta script (`regression-beta-issue.mjs`) comments only on an open issue it opened itself (author `github-actions[bot]`, its marker on the first line, the same forced kind), so a `regression:beta` added to another issue never swallows a new finding; a forced run (`--forced true`, from the workflow's `force_red`) opens its own `forced` issue with `regression:beta` and `status:todo` only.
- Decision: a regression issue has no triage comment, so `docs/agents/implement.md` "Regression issues" sets its scope (the named scenarios green again on the named version, through a plugin change), the reproduction (always `scripts/regression.sh gateway --openclaw <version>`: the tier is never read from the body, the version only as digits and dots with an optional `-beta.N`; the failing scenario is the reproduction test), and the owner hand-off (not red, the tier cannot run, or the fault is in OpenClaw: build nothing and set `status:blocked`; never needs-info or declined). `docs/issues.md` says the same (block).
- Docs say the exception in one place each and link it: `docs/agents/implement.md` "Regression issues" (agent rule, the trust check), `docs/agents/triage.md` Rules "Regression findings" (skip, links implement.md), `docs/issues.md` "Regression findings" paragraph (owner view) plus a State automation bullet, design `issue-flow.md` one line under Other labels. Short pointers elsewhere link these.
- Owner stop: another status wins as on any issue, and `status:blocked`/`status:declined`, a close, or a batch pull request closed unmerged end the shortcut for good; a draft batch only pauses the merge. A run takes the issue only while it is `status:todo` (or in the interrupted set).

## Plan Change Log

- 2026-11-28: added `scripts/agent-write.mjs` + `test/agent-write.test.ts` (relay refuses adding `source:regression`), not in the Code Map: required by the Boundary "an agent session labelling an issue `source:regression` gains nothing", because the relay writes as the agent app, which is a trusted writer.
- 2026-11-28 (security review): added `scripts/sync-labels.mjs` (renamed_from refusal) and the `actions: read` permission of `.github/workflows/issue-flow.yml`; `regression-beta.yml` passes `--forced`.
- 2026-11-28: also updated `docs/agents/identity.md` (relay labels row, the app as a regression writer), `docs/release.md` (weekly beta run labels), `.github/workflows/regression-beta.yml` and `.github/workflows/issue-flow.yml` (header comments only).

## Review Triage Log

Security review after commit 0023219: 7 findings, 7 patched (high 1, medium 2, low 4); `followup_review_recommended: true` because a high was patched.

- HIGH, patched: any `github-actions[bot]` counted as a trusted writer, so a dispatch from another ref or a same-repo pull request's workflow could mint a trusted issue. Trust is now bound to the run named in the issue's first line (`REGRESSION_WORKFLOWS`, `regressionRunVerdict`, `readRegressionRun`, `actions: read`): allowed path, `main`, schedule or dispatch, this repository, a commit on `main`, issue and label inside the run's time; a forced run is marked `forced` and never trusted; an unreadable run is untrusted. Every rejection is tested (`test/issue-flow.test.ts` RUN_REJECTED, runEvent cases; `test/regression-beta-issue-script.test.ts` forced cases). Same check in implement.md item 1.
- MEDIUM, patched: a non-owner could undo the owner's `status:blocked` by adding `status:todo`. A blocked or declined status, a close, or a batch closed unmerged after the label now ends the shortcut for good, in code (`regressionShortcutEnded`, `onPullRequest`) and docs (implement.md item 1.4, issues.md).
- MEDIUM, patched: the agent app login is no longer a regression writer (`isRegressionWriter` is `github-actions[bot]` only; `ISSUE_FLOW_AGENTS` comment, identity.md, issues.md, design doc updated).
- LOW, patched: the tier is never taken from the issue body; always `gateway` plus the validated version (implement.md items 2 and 3).
- LOW, patched: `sync-labels.mjs` refuses `renamed_from` on `source:*` and owner/workflow-only labels, with tests.
- LOW, patched: the beta script comments only on an open issue it opened itself (author, first-line marker, same forced kind); a planted `regression:beta` or marker never swallows a new issue, with tests.
- LOW, patched: docs/issues.md and implement.md agree: the run hands an unfixable or unreproduced regression issue to the owner with `status:blocked`.

## Auto Run Result

- **Summary:** `source:regression` marks an issue that a regression workflow run opened; triage skips it and the implementation run builds it without an owner approval. Trust is bound to the run, not a login: the issue's first line names the run, and the run must be an allow-listed workflow (`regression-beta.yml`) on `main`, by schedule or dispatch, not forced, with the issue created inside the run's window. An untrusted label is removed, the relay refuses to add it, an owner's block, decline or close ends the shortcut for good, and the weekly beta issue files with `source:regression` and `type:bug`.
- **Review:** 7 patched (high 1: any `github-actions[bot]` run on any branch was trusted; medium 2; low 4), 0 deferred, 0 rejected.
- **Follow-up review recommended:** true (a high was patched in a security-sensitive path); the risk: the run-binding check is proven by unit tests with a stubbed API, and runs for real only after merge.
- **Verification:** `npm test` 2145 passed; typecheck clean.
- **Residual risks:** anyone who can push to `main` controls the trusted workflow (needs branch protection); a body edit is caught only by the agents' `lastEditedAt` check; an unreadable run during an edit removes the shortcut (fail-safe).

## Verification

- `npm test`: green, 72 files passed (29 skipped), 2145 tests passed (99 skipped), after the security patches. New tests: `test/issue-flow.test.ts` "source:regression (epic-regression-gate ticket 11)" (writer, marker parsing, needsTimeline, trusted, pending, every run rejection, untrusted actor and author, no label event, latest wins, event lag, ended by block/decline/close/revived todo/closed batch, own-click rule unchanged, five `runEvent` cases with the run and compare reads); `test/agent-write.test.ts` SOURCE_REGRESSION; `test/regression-beta-issue-script.test.ts` labels, body, forced issue, own-issue guard, planted marker, `--forced` usage; `test/sync-labels.test.ts` label count and `renamed_from` refusals.
- `npm run typecheck`: clean.
- `scripts/regression.sh` not run (not needed for this ticket).

**Commands:**
- `npm test` -- expected: green, with new tests for the label, the beta script and the transitions
- `npm run typecheck` -- expected: clean
