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
      L5 (narrowed by the re-review's M1): for an owner-only label (approved, rework) whose labeled event never shows after 4 reads, the state automation now applies nothing; for any other status it still treats the handled event as the newest.
    evidence: |-
      Not judging an owner-only label without its event cannot let a stranger's click stand; the cost is that a real owner click lost to a long lag is neither confirmed nor reverted until the next label event or run. The other statuses cannot grant anything, so they keep the old behavior.
    location: >-
      scripts/issue-flow/transitions.mjs latestLabeled
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

### 2026-10-31 -- independent review (opus) and the owner's decision
- Triggering findings: M2 (a rework issue with no own-click approval in its history was skipped silently; the owner decided that the owner's own click on `status:rework` is itself the authorization, exactly like an own-click approval, so no earlier approval is required), M3 (`Batch merge` could merge a batch pull request whose issue the owner had just sent back), M4 (a resumed rework was found by `Issue: #N` alone, which also matches the tickets of earlier rounds), L1, L2, L3, L4, L8.
- Amended (supersedes the Always clause "the owner's earlier own-click `status:approved` must exist, newer than the last close or reopen" of the intent contract and the Implementation Notes decision on the earlier approval; the contract text itself is read-only and stays as written): Rework item 1 has no approval check; an unverifiable click, a missing earlier result, or a missing owner comment gives `status:blocked` ("add status:rework again by your own click"), never a silent skip; `batch-merge.mjs` holds a batch pull request while any linked issue is in `status:rework`, so a rework fix's answer and `status:in-review` go out before `pr_edit`/`pr_ready`; a resumed rework is found only by `Issue: #N` and `Rework of <ref>` on tickets the resumed draft adds; an owner comment edited after creation counts only if its GraphQL `editor` is an owner; the answer comment is posted before the status (safest: the answer is posted and the issue stays in `rework`, and the next run finishes the status named in the answer); checklist items 2 and 9 and the Rework section carry the no-commit exception; the events list is read again (4 reads) when the handled label's event is missing; the revert comments say the issue keeps its status (or `status:todo`); the workflow comment and the upstream-post status line name `status:rework`.
- Owner follow-up (same day): `scripts/upstream-issue.mjs` `checkApproved` also accepts an owner's own-click `status:rework` in the issue's history, the same proof as an approval (owner in `ISSUE_FLOW_OWNERS`, `User`, no `performed_via_github_app`); every other guard is unchanged. This keeps the authorization decision consistent: a never-approved issue that the owner sent back can end in a draft that the `Upstream post` workflow will publish. `identity.md`, `implement.md`, and `issues.md` say so. (My first report named this gap; the Code Map note "`checkApproved` ... approval still holds" is superseded.)
- Known-bad states avoided: a silent skip of the owner's click; a merge racing a send-back; a rework build attributed to an earlier round; an instruction edited by someone else; a lost answer or a lost status after a failed dispatch. KEEP: the owner-only revert, the relay refusal, never stale, triage skip, the no-claim decision.

### 2026-10-31 -- re-review of 97746b8..HEAD
- Triggering finding H1 (blocker): the hold added for M3 left a green ready batch open; every later run stopped at Before-the-batch step 2 ("green, waiting for Batch merge"), so the rework and all other approved work stalled. Amended: a "Held (rework)" class in Merging and in step 2; the run resumes a held ready batch like an idle draft and retires it in the same dispatch; the relay `pr_close` accepts a ready batch only when it is held for rework and another open batch PR of the app contains its head. Superseded: the Fix text "a ready one is waited for as always, and the issue is taken after it merged" (Rework item 4) and the plan's earlier statement that `pr_close` is for drafts only.
- Also: M1 the L4 re-read condition (latest label event must be `labeled`; owner-only labels with none apply nothing), M2 the relay `merge` op bypassed the hold, M3 the half-done rule could undo a fresh send-back, L1 edits after the click are data, L3 removing the label sends the issue to `status:todo`, L4 an answered in-review fix gets no second comment.
- Known-bad states avoided: a stalled pipeline behind a held batch; a stranger's re-add judged by the owner's older click; a merge through the relay while the owner sent the issue back; the old status re-applied after a fresh send-back; an edit after the click acted on. KEEP: the hold itself, the no-claim rule, the answer-first order, the own-click authorization.

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

### 2026-10-31 -- Independent review (opus) of the first build, fixed in a follow-up
- verdicts: 10 findings for this ticket -- high 0, medium 3, low 6, false 0, maybe-false 0 (one low deferred)
- findings:
  - `[medium]` `[patch]` M2 authorization: the first build skipped a rework issue without an own-click approval; per the owner's decision the own click is the authorization -- patched in implement.md, issues.md, issue-flow.md, the label description, with pins (`rework` item 1 asks the owner to click again, never skips).
  - `[medium]` `[patch]` M3 a batch could merge while its issue was sent back -- patched: `scripts/batch-merge.mjs` `checkNotSentBack` (Fixes/Closes/Resolves/Refs links, unreadable issue holds, 404 does not), tests in `test/batch-merge.test.ts`; the docs give the owner's moves (label before the merge; reopen then label after it); a rework fix's status goes out before `pr_ready`.
  - `[medium]` `[patch]` M4 a resumed rework was found by `Issue: #N` only -- patched: both notes, on tickets the resumed draft adds; pinned.
  - `[low]` `[patch]` L1 edited owner comments -- patched in docs (GraphQL `editor`; unreadable is data); pinned.
  - `[low]` `[patch]` L2 partial failure -- patched: comment first, then status; the next run finishes the status named in the answer.
  - `[low]` `[patch]` L3 checklist items 2 and 9 -- patched with the no-commit exception; housekeeping commits still need the batch.
  - `[low]` `[patch]` L4 events lag -- patched in `apply.mjs` (4 reads, `ISSUE_FLOW_EVENT_DELAY_MS`), tests with a lagging list.
  - `[low]` `[patch]` L8 the revert comments said the previous status was "restored" even when it was kept -- patched for both.
  - `[low]` `[defer]` L5 fail open on a missing event after the retries -- deferred by the owner's decision (recorded in `deferred`).
  - `[low]` `[patch]` Owner follow-up: `checkApproved` refused an issue sent back with `status:rework` that never had `status:approved`, so the new-draft outcome could not publish -- patched: it accepts the owner's own-click `status:rework` too (app-made, non-owner, bot, and unlabeled events refused); tests in `test/upstream-issue.test.ts`, doc pin in `test/agent-flow-docs.test.ts`.
  - Nits patched: the `ISSUE_FLOW_OWNERS` comment in `.github/workflows/issue-flow.yml`; the `Upstream post` status line.
- Mutation checks (owner follow-up): 3 mutations, all killed: `checkApproved` ignoring rework; accepting a rework by any actor; accepting a rework made through an app.
- Mutation checks (follow-up): 17 mutations, all killed: batch-merge never reading linked issues, holding only `Fixes`, ignoring an unreadable issue, holding on any label; events never re-read, re-read when shown; the revert comment saying "restored"; 10 doc pins (earlier approval back, silent skip, edited comments, status before comment, no half-done recovery, `Issue:` note only, status after `pr_ready`, checklist exception, Merging section hold).

### 2026-10-31 -- Re-review of 97746b8..HEAD, fixed in a follow-up
- verdicts: 7 findings -- high 1, medium 2, low 4, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` H1 a held ready batch deadlocked the pipeline -- patched (see the Plan Change Log): docs in implement.md (Merging "Held (rework)", step 2, Rework item 4, Open the pull request step 5), identity.md, issues.md; relay `pr_close` (`checkClosableHeld`, `closing` keeps `draft`, apply-time recheck, carrier always required); tests in `test/agent-write.test.ts` (closed with a carrier; the full retire dispatch; refused without a hold, without a carrier, for another author, branch, fork, title, closed; an unreadable issue; the label removed after the check; a ready/draft flip), doc pins.
  - `[medium]` `[patch]` M1 the re-read looked only for any earlier `labeled` event, so a stranger's re-add after the agent removed the label was judged by the owner's older click -- patched: `latestEventIsLabeled`, 4 reads, then nothing applied for an owner-only label (a non-owner-only status still proceeds); tests with the review's scenario (owner rework 10:00, agent's blocked 11:00, agent unlabels rework, the re-add lags), including never shown.
  - `[medium]` `[patch]` M2 the relay `merge` op bypassed the hold -- patched: `checkNotSentBack` is shared and called there (an unreadable issue refuses); tests.
  - `[low]` `[patch]` M3 half-done rule could re-apply an old status after a fresh send-back -- patched in the docs (the latest own-click label must be older than the answer, else ask for a comment); pinned.
  - `[low]` `[patch]` L1 an edit after the latest own-click rework label is data whoever the editor (the editor check stays) -- patched; pinned.
  - `[low]` `[patch]` L3 removing the label by hand gives `status:todo`; cancel by setting the wanted status -- documented (implement.md, issues.md); pinned.
  - `[low]` `[patch]` L4 an in-review answer already posted before `pr_ready` gets no second comment -- documented; pinned.
- Mutation checks (follow-up): 18 mutations, all killed: the rework hold dropped from the ready close; no carrier for a held batch; no apply-time recheck; a ready/draft flip allowed; another title and another author closable; relay merge ignoring the hold; an unreadable linked issue ignored; the old any-earlier-event re-read; an owner-only label with no event applied; every status label skipped when no event (found a gap: added `NO_EVENT_OTHER_STATUS`); 8 doc pins.

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts test/agent-write.test.ts test/sync-labels.test.ts test/agent-flow-docs.test.ts` -- pass
- `npm run ci` -- pass

## Auto Run Result

Status: built.

Summary: `status:rework` exists (label, `STATUS_LABELS`, `REWORK`, `OWNER_ONLY_STATUSES`), counts only as the owner's own click (the state automation reverts a non-owner's or an app's, with its own comment and once-key; the relay refuses adding it), is never stale, and triage skips it. The implementation agent's procedure is the new `## Rework` section of `docs/agents/implement.md`: picked first, instructions are only the owner's own comments after its latest impl comment, three endings (fix through the batch, new draft in `awaiting-post`, question in `blocked`). Docs: implement.md, triage.md, issues.md (states table, "Send it back"), comments.md (examples), identity.md, issue-flow.md, MEMORY, CHANGELOG.

Review: quick, run in this session (no subagent tool in this worker). 7 findings: 2 medium patched (doc gaps in the run procedure), 4 low deferred, 1 false. Follow-up review recommended: true. Patched counts by verdict: medium 2, high 0. The unverified risk: the Rework procedure is prompt-following in a scheduled agent run (item 2 reads comment authors by REST, item 3 keeps the status, item 4 chooses the ending); only the code half (revert, relay, stale, triage scope text) is tested, and no run has followed the new section yet.

Second follow-up (2026-10-31): the re-review's H1 (blocker), M1, M2, M3, and L1, L3, L4 are fixed (Plan Change Log, third triage entry); L5 is narrowed (an owner-only label whose event never shows now applies nothing). The relay now closes a ready batch, held for rework only; this path has run only against the stub, so a follow-up review stays recommended.

Follow-up (2026-10-31): the independent review's M2, M3, M4, L1 to L4, L8, and the nits are fixed (Plan Change Log, second triage entry); L5 is deferred. Follow-up review recommended: true: the Rework procedure is still prompt-following (the GraphQL editor read, the comment-first order and its recovery, the no-claim rule have not been followed by a real run), and the `Batch merge` hold has only run against the stub.

Verification: the four touched test files, then `npm run ci` (plan gate, typecheck, 1659 unit tests, build, package allowlist, pack, install smoke): all passed.

Residual risks: not run live: the owner sending a draft back and the next run posting a corrected draft in `awaiting-post` without triage or a new approval; the label sync creating `status:rework` on `main`.
