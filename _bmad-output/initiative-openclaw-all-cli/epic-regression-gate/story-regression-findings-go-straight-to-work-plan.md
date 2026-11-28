---
title: 'Regression findings go straight to work'
type: 'feature'
ticket: '11'
created: '2026-11-28'
status: 'in-progress'
baseline_revision: 'd467522'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
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
- [ ] `.github/labels.yml` + test -- `source:regression`
- [ ] `scripts/regression-beta-issue.mjs` + test -- regression labels
- [ ] `scripts/issue-flow/*` + tests -- trust rule for `source:regression`
- [ ] `docs/agents/implement.md`, `docs/agents/triage.md`, `docs/issues.md`, `issue-flow.md` -- the exception
- [ ] `MEMORY.md` -- the decision

**Acceptance Criteria:**
- Given an issue with a trusted `source:regression`, when triage and the implementation run read the rules, then triage skips it and the run builds it without an approval.
- Given `source:regression` added by an untrusted actor, when the automation runs, then the issue gets no shortcut.
- Given `npm test` and `npm run typecheck`, then both are green.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm test` -- expected: green, with new tests for the label, the beta script and the transitions
- `npm run typecheck` -- expected: clean
