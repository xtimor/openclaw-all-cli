---
title: 'Regression findings go straight to work'
type: 'feature'
ticket: '11'
created: '2026-11-28'
status: 'in-review'
baseline_revision: 'd467522'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
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
- Decision: trust = a regression writer (`github-actions[bot]`, or a login in `ISSUE_FLOW_AGENTS`) opened the issue **and** made the latest `labeled source:regression` event; the agents' check adds (3) no `closed` event after that labeled event, so a closed and reopened regression issue (by the owner, or by an agent through the relay's `reopen`) takes the normal path. An owner's login never counts (own click or through an app): the owner approves instead. The author condition stops the beta script's marker search (plain text anyone can write into an issue) from ever giving a foreign issue the shortcut; the script also re-adds only `regression:beta` on that path, as before.
- Decision: `scripts/issue-flow/transitions.mjs` `regressionLabelActions` (called from `onIssues` for opened, reopened, closed, labeled, unlabeled on open issues) removes an untrusted label with one comment (`regressionComment`, once-key `issue-flow:regression:<event id>`) and never touches the status; status actions come first. Actors judged: the timeline's latest `labeled` event and, for a handled `labeled source:regression` event, the payload's actor too (an untrusted one wins, since a lagging timeline cannot say which is newer); with neither, an `opened` event's actor. No known actor on a writer-opened issue: nothing changes (the agents' own event check decides; an unproven label gets no shortcut). `needsTimeline` is true for any open issue with the label; `apply.mjs` re-reads the events for a handled `labeled source:regression` like for a status, then goes on (the payload actor is known).
- Decision: `scripts/agent-write.mjs` refuses adding `source:regression` (removing is fine). The relay acts as the app, which is a regression writer, so without this any agent session (for example a triage run misled by issue text) could give any issue the shortcut. With it, only a workflow that uses `GITHUB_TOKEN` or the app token directly can set a trusted label; today that is `regression-beta.yml` only.
- Decision: a regression issue has no triage comment, so `docs/agents/implement.md` "Regression issues" sets its scope (the named scenarios green again on the named version, through a plugin change), the reproduction (run the tier at that version on the branch; the failing scenario is the reproduction test), and the owner hand-off (not red, the tier cannot run, or the fault is in OpenClaw: build nothing, Block an issue for the owner; never needs-info, the author is a bot; an upstream draft still needs the owner's approval).
- Docs say the exception in one place each and link it: `docs/agents/implement.md` "Regression issues" (agent rule, the trust check), `docs/agents/triage.md` Rules "Regression findings" (skip, links implement.md), `docs/issues.md` "Regression findings" paragraph (owner view) plus a State automation bullet, design `issue-flow.md` one line under Other labels. Short pointers elsewhere link these.
- Owner stop: unchanged mechanisms (another status wins, closing the issue, draft or closed batch pull request); a run takes the issue only while it is `status:todo` (or in the interrupted set).

## Plan Change Log

- 2026-11-28: added `scripts/agent-write.mjs` + `test/agent-write.test.ts` (relay refuses adding `source:regression`), not in the Code Map: required by the Boundary "an agent session labelling an issue `source:regression` gains nothing", because the relay writes as the agent app, which is a trusted writer.
- 2026-11-28: also updated `docs/agents/identity.md` (relay labels row, the app as a regression writer), `docs/release.md` (weekly beta run labels), `.github/workflows/regression-beta.yml` and `.github/workflows/issue-flow.yml` (header comments only).

## Review Triage Log

## Verification

- `npm test`: green, 72 files passed (29 skipped), 2129 tests passed (99 skipped). New tests: `test/issue-flow.test.ts` "source:regression (epic-regression-gate ticket 11)" (writers, needsTimeline, trusted kept with `todo`, untrusted actor and author removed, latest wins, event lag, unknown actor, closed/comment/bot events, own-click rule unchanged on a regression issue, owner's blocked wins, combined with a stranger's approval, three `runEvent` cases); `test/agent-write.test.ts` SOURCE_REGRESSION; `test/regression-beta-issue-script.test.ts` labels and body; `test/sync-labels.test.ts` label count 19 to 20 names, 22 labels.
- `npm run typecheck`: clean.
- `scripts/regression.sh` not run (not needed for this ticket).

**Commands:**
- `npm test` -- expected: green, with new tests for the label, the beta script and the transitions
- `npm run typecheck` -- expected: clean
