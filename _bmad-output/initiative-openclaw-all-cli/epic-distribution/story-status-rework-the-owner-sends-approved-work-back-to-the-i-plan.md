---
title: '`status:rework`: the owner sends approved work back to the implementation agent without new triage or approval'
type: 'feature'
ticket: 28
created: '2026-10-31'
status: built
baseline_revision: '242c4c4fbc6f3f17a67f848cc6b392259e414ca1'
route: 'oneshot'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['in-session']
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/implement.md']
warnings: []
deferred:
  - summary: >-
      A post that is already published upstream cannot be edited, so a rework of it posts the corrected text as the next reply on the thread.
    evidence: |-
      The Upstream post workflow and scripts/upstream-issue.mjs create or comment only (never edit, by design of 3.23-3.25). The rework docs say so to the owner and the agent.
    location: >-
      docs/agents/implement.md Rework (New draft)
    severity: low
  - summary: >-
      The issue keeps status:rework while the run works, so the status does not show "in progress".
    evidence: |-
      Chosen on purpose: a claim comment would move the instruction baseline past the owner's comments and a stopped run would lose them. The batch draft pull request shows the activity.
    location: >-
      docs/agents/implement.md Rework item 3
    severity: low
  - summary: >-
      Other ways to send work back remain: re-approving an issue in blocked or awaiting-post, closing a batch pull request (issues go to blocked, then re-approve).
    evidence: |-
      They restart through status:approved and are unchanged. docs/issues.md and issue-flow.md now point the awaiting-post row at status:rework; the others are the owner's call.
    location: >-
      docs/issues.md States, issue-flow.md Transitions
    severity: low
  - summary: >-
      "The owner's own comment" is judged from the comment's user type and performed_via_github_app; a REST answer that omits the field would read as a person's comment.
    evidence: |-
      Issue comments carry performed_via_github_app in the REST API today (the event check for status:rework itself is also done by the state automation). Not verifiable offline.
    location: >-
      docs/agents/implement.md Rework item 2
    severity: low (unverified)
---

<intent-contract>

## Intent

**Problem:** When the owner disagrees with an agent's result (a draft in `status:awaiting-post`, a fix in `status:in-review`, an answer in `status:blocked`, a post in `status:upstream`) the only way back is `status:todo`, which restarts triage and needs a new approval, although the approval still holds.

**Approach:** A new status `status:rework`, counted only as the owner's own click exactly like `status:approved` (reverted otherwise, refused by the relay), never stale, skipped by triage. The implementation agent picks it up before new approvals and takes as instructions only the owner's own comments after its latest `<!-- issue-impl -->` comment; it ends in a fix through the batch path, a new draft (`status:awaiting-post`), or a question (`status:blocked`).

## Boundaries & Constraints

**Always:** the approval is not asked again (the owner's earlier own-click `status:approved` must exist, newer than the last close or reopen); other comments and the issue text stay data; protected files and the other rules of implement.md still bind; the relay and the state automation each enforce the owner-only rule on their own.

**Never:** an agent adds `status:rework` (relay refuses); the stale job touches it; triage decides on it; a new triage or approval is required for it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OWNER_CLICK | `status:rework` labeled by an owner, own click | stays; the other status goes (latest wins) | none |
| STRANGER | labeled by a non-owner | removed, previous status stays or is restored, one comment (once per event) | none |
| VIA_APP | labeled by an owner through a GitHub App | same as STRANGER | none |
| BOTH_OWNER_ONLY | a stranger's `approved` and `rework` on one issue | both removed, one comment each | none |
| NO_EVENT | `status:rework` on the issue, no event readable | stays (as for `approved`) | none |
| STALE | open `status:rework` issue, any age | never closed | none |
| RELAY | `labels` op adding `status:rework` (any list) | whole list refused, nothing applied | `status:rework is the owner's to set` |
| RELAY_REMOVE | `labels` op removing `status:rework` | allowed | none |
| TRIAGE | issue in `status:rework` | not triaged (docs) | none |

</intent-contract>

## Code Map

- `.github/labels.yml` -- new label last in the status block (order = `STATUS_LABELS`).
- `scripts/issue-flow/transitions.mjs` -- `STATUS_LABELS` (12), `REWORK`, `OWNER_ONLY_STATUSES`, `needsTimeline`, `reconcile`, `replacedBefore`, `reworkComment`; `STALE_STATUSES` stays.
- `scripts/agent-write.mjs` -- `FORBIDDEN_LABEL` becomes a list of owner-only labels; header comment.
- `docs/agents/implement.md`, `triage.md`, `comments.md`, `identity.md`, `docs/issues.md`, `epic-distribution/issue-flow.md`, `MEMORY.md`, `CHANGELOG.md`.
- `test/issue-flow.test.ts`, `test/agent-write.test.ts`, `test/sync-labels.test.ts` (counts), `test/agent-flow-docs.test.ts` (doc pins).
- Not changed: `scripts/upstream-post.mjs` (its move removes every other `status:*`, rework included), `scripts/upstream-issue.mjs` (`checkApproved` reads the whole history for the owner's approval, which still holds), `apply.mjs`.

## Tasks & Acceptance

**Execution:**
- [ ] `.github/labels.yml`, `scripts/issue-flow/transitions.mjs` -- status, owner-only revert for both, comment text
- [ ] `scripts/agent-write.mjs` -- relay refuses adding it
- [ ] docs (list above) -- rework flow for the owner and the agents
- [ ] tests and doc pins, then mutation checks of the guards (revert, relay refusal, never stale, triage skip, doc pins)

**Acceptance Criteria:**
- Given an open issue with `status:rework` labeled by a non-owner or through an app, when the state automation settles it, then the label is removed, the previous status is kept or restored, and one comment says so.
- Given an agent's relay list adding `status:rework`, then the whole list is refused.
- Given any age, then the stale job never closes a `status:rework` issue.
- Given implement.md and triage.md, then implement.md picks `status:rework` issues first, takes only the owner's own comments after its latest impl comment as instructions, and names the three endings; triage.md skips the status.

## Implementation Notes

Route is `oneshot`, pinned: no subagent tool in this worker; the caller asked for an in-session build and review.

Decisions:
- While a rework is being built the issue stays `status:rework` (no claim to `status:in-progress`, no claim comment): a claim comment would move the "latest `<!-- issue-impl -->` comment" baseline past the owner's instructions, and an interrupted run would lose them. Every outcome sets another status (latest wins removes it): `status:in-review` with the pull request, `status:awaiting-post`, `status:blocked`.
- The earlier approval must still hold: the owner's own-click `status:approved` newer than the issue's last close and reopen (the rule of a carried-over approval). Without one, or without an earlier `<!-- issue-impl -->` comment, or without an owner comment after it, the run asks the owner (`status:blocked`) and never builds.
- A corrected text for a post that is already published cannot edit it: the workflow posts it as the next reply on the thread (3.26 rounds). The comment says so.
- The relay allows removing `status:rework` (as for `status:approved`).

## Plan Change Log

## Review Triage Log

### 2026-10-31 -- Review pass (quick, in this session: the worker has no subagent tool and the caller asked for an in-session review)
- verdicts: 7 findings -- high 0, medium 2, low 4, false 1, maybe-false 0
- findings:
  - `[medium]` `[patch]` A run whose only rework issues end as a new draft or a question builds nothing, yet the Run checklist demanded a draft batch pull request and a ready one -- patched: the Rework section says there is no commit and no batch, the run ends after Watch upstream and the report says so (pinned in `test/agent-flow-docs.test.ts`).
  - `[medium]` `[patch]` On a resumed idle draft the Built (resumed) path said the issue "stays in-progress" and found tickets through the claim comment, which a rework issue never gets -- patched: a rework issue keeps `status:rework` there too and its tickets are found by their `Issue: #N` note (pinned).
  - `[low]` `[defer]` A published post cannot be edited upstream, so the corrected text is posted as the next reply -- documented; deferred as a limit of the upstream workflow.
  - `[low]` `[defer]` The issue shows `status:rework` while the run works (no claim) -- chosen on purpose, recorded in Implementation Notes.
  - `[low]` `[defer]` Other ways to send work back remain (re-approval, closing the batch pull request); owner's call.
  - `[low]` `[defer]` The owner-comment check depends on `performed_via_github_app` being present on REST comments (unverified).
  - `[false]` `[reject]` "The relay lets an agent remove `status:rework`, so it could clear an owner's request unanswered" -- removing is allowed for `status:approved` as well; the label is replaced by any outcome anyway (latest wins), and the agent's only way to leave a rework issue is one of the three outcomes by the docs.
- Mutation checks (each applied alone, tests run, change reverted): 26 mutations, all killed: rework dropped from `OWNER_ONLY_STATUSES`; the app-made-click check removed (also rework-only); the actor check removed (also rework-only); `needsTimeline` without rework; restore may return an owner-only status; restore anchored on the latest reverted label (found a gap: added the earliest-label test); the rework once-key equal to the approval's; no revert comment; rework made stale; `STATUS_LABELS` without it; the relay accepting it; the relay refusing its removal; the label file without it; and 11 doc-pin mutations (rework first, list step, instruction author, baseline, app-made comments, question and draft outcomes, triage skip, triage scope, Send it back, identity.md).

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts test/agent-write.test.ts test/sync-labels.test.ts test/agent-flow-docs.test.ts` -- pass
- `npm run ci` -- pass

## Auto Run Result

Status: built.

Summary: `status:rework` exists (label, `STATUS_LABELS`, `REWORK`, `OWNER_ONLY_STATUSES`), counts only as the owner's own click (the state automation reverts a non-owner's or an app's, with its own comment and once-key; the relay refuses adding it), is never stale, and triage skips it. The implementation agent's procedure is the new `## Rework` section of `docs/agents/implement.md`: picked first, instructions are only the owner's own comments after its latest impl comment, three endings (fix through the batch, new draft in `awaiting-post`, question in `blocked`). Docs: implement.md, triage.md, issues.md (states table, "Send it back"), comments.md (examples), identity.md, issue-flow.md, MEMORY, CHANGELOG.

Review: quick, run in this session (no subagent tool in this worker). 7 findings: 2 medium patched (doc gaps in the run procedure), 4 low deferred, 1 false. Follow-up review recommended: true. Patched counts by verdict: medium 2, high 0. The unverified risk: the Rework procedure is prompt-following in a scheduled agent run (item 2 reads comment authors by REST, item 3 keeps the status, item 4 chooses the ending); only the code half (revert, relay, stale, triage scope text) is tested, and no run has followed the new section yet.

Verification: the four touched test files, then `npm run ci` (plan gate, typecheck, 1659 unit tests, build, package allowlist, pack, install smoke): all passed.

Residual risks: not run live: the owner sending a draft back and the next run posting a corrected draft in `awaiting-post` without triage or a new approval; the label sync creating `status:rework` on `main`.
