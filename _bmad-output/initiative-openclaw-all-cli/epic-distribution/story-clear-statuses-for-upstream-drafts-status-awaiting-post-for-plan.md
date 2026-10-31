---
title: 'Clear statuses for upstream drafts: `status:awaiting-post` for the owner, `status:upstream` after posting'
type: 'feature'
ticket: 26
created: '2026-10-31'
status: built
baseline_revision: 'ba9a13db887921ad83982b7c7976574891def9eb'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md']
warnings: ['oversized']
deferred:
  - summary: >-
      A reply (op=comment) to an upstream issue that the workflow itself created needs our issue to name that upstream issue.
    evidence: |-
      checkNamesTarget (3.24, unchanged) requires the approved issue's title or body to name the target as repo#n or its URL; a created issue's number is not known when our issue is written. The owner edits our issue's body once; docs/issues.md says so. Rounds work for replies on the owner's own issues (#52, #53), the case this change serves.
    location: >-
      scripts/upstream-issue.mjs checkNamesTarget
    severity: low
---

<intent-contract>

## Intent

**Problem:** An agent's upstream draft that waits for the owner's `upstream:post` shows `status:blocked`, which does not say what is wanted, and a published draft leaves the issue in that same status.

**Approach:** Two statuses. `status:awaiting-post`: a draft is ready in this issue, only the owner acts. `status:upstream`: the draft was published, the upstream maintainers act. The agent sets the first; the `Upstream post` workflow sets the second after a successful publish.

## Boundaries & Constraints

**Always:** exactly one status per open issue (latest wins, as for the others); the workflow sets `status:upstream` with its own job token after the result comment; a refusal leaves the status as it is; every 3.25 guard (owner's own click, replay, draft author and age, shared `run()` guards) stays as it is; neither new status is closed by the stale job (the owner decides); docs say the same as the code.

**Never:** an agent or the relay setting `status:upstream`; the relay or an agent adding `upstream:post` or `status:approved`; editing `tickets.toml`, ticket files, `runs/`, `AGENTS.md`, `.claude/settings.json`, or the CHANGELOG.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Published (created, commented, existing) | owner's label, valid draft, issue in `status:awaiting-post` | result comment, `upstream:post` removed, then `status:upstream` added and every other status removed | status write fails: exit 1, reason in the log, comment and label already done |
| Refused | any refusal after the labeler check | result comment, label removed, statuses untouched | as before |
| Replay or withdrawn | attempt over 1, label gone | no write at all | exit 1 |
| Owner moves it on | `status:upstream` then `status:approved`/`new` by the owner | latest status wins | — |
| Stale job | `awaiting-post` or `upstream` for 30+ days | stays open | — |
| Relay | agent adds `status:awaiting-post` / adds `status:upstream` | first applied; second refused, nothing applied | exit 1 names the rule |

</intent-contract>

## Code Map

- `.github/labels.yml` -- add the two labels after `status:declined`.
- `scripts/issue-flow/transitions.mjs` -- `STATUS_LABELS`, constants `AWAITING_POST`, `UPSTREAM`; not in `STALE_STATUSES`.
- `scripts/upstream-post.mjs` -- `settle` (comment, label removal) gets a final `setUpstreamStatus`; `resultComment` names the status.
- `scripts/agent-write.mjs` -- `FORBIDDEN_LABEL` guard: also refuse adding `status:upstream`.
- `docs/agents/{implement,triage,comments,identity}.md`, `docs/issues.md`, `issue-flow.md`, `MEMORY.md` -- the new statuses.
- `scripts/upstream-issue.mjs` -- `MARKER_LINE`, `markers()` (adds `round`), comment `sameMarker` (marker and round); `findExisting` for a create keeps ignoring the round.
- `scripts/upstream-post.mjs` -- `draftRound`, `buildInput(draft, repo, n, round)`.
- `docs/agents/implement.md` -- new "Watch upstream" section and checklist item 1a.
- Tests: `test/{issue-flow,upstream-post,upstream-issue,agent-write,agent-flow-docs,sync-labels}.test.ts`.

## Tasks & Acceptance

**Execution:**
- [ ] `.github/labels.yml`, `scripts/issue-flow/transitions.mjs` -- two statuses (11 in all), never stale
- [ ] `scripts/upstream-post.mjs`, `.github/workflows/upstream-post.yml` header -- status move after a published result
- [ ] `scripts/agent-write.mjs` -- relay refuses adding `status:upstream`
- [ ] docs, `issue-flow.md`, `MEMORY.md` -- a ready draft sets `status:awaiting-post`, not blocked
- [ ] `scripts/upstream-issue.mjs`, `scripts/upstream-post.mjs` -- round in the marker line, derived by the workflow (Plan Change Log, 2026-10-31)
- [ ] `docs/agents/implement.md` and the other docs -- the watch-upstream step
- [ ] tests -- matrix rows, doc pins, mutation checks

**Acceptance Criteria:**
- Given a published draft, when the workflow ends, then the issue has only `status:upstream`; given a refusal, then its statuses are unchanged.
- Given the docs, then a ready draft sets `status:awaiting-post` and `status:blocked` is for owner decisions only.
- Given `npm run ci`, then it passes.

## Implementation Notes

No subagent tool was available to this worker: the build and the review ran in-session (full route by size, no implementing subagent; the Quick lens was not context-free), as for tickets 3.22 to 3.25. Decisions:

- **Statuses.** `status:awaiting-post` (purple, like `upstream:post`) and `status:upstream` are appended to `labels.yml` and `STATUS_LABELS` (11), after `declined`; the state automation needed no other change (latest wins, closed clears, a foreign approval restores them) and ignores the workflow's own label events. Neither is in `STALE_STATUSES`: `awaiting-post` is the owner's open task, `upstream` waits for outsiders; the owner closes the issue.
- **Who sets what.** The implementation agent sets `awaiting-post` instead of `blocked` when it leaves a draft (triage writes no draft and never sets either status). `status:upstream` only comes from the workflow: the relay refuses adding it (`WORKFLOW_ONLY_LABEL`, removal stays allowed so the agent can leave it when it answers upstream); `awaiting-post` passes the existing `LABEL_RE`. Documented in identity.md, implement.md, comments.md, issues.md, issue-flow.md.
- **The move.** `settle` posts the result comment, removes `upstream:post`, then (only for created, commented, existing) `moveToUpstream`: GET the issue again, skip a closed one, add `status:upstream` unless present, remove every other `status:*` (404 passes). A failure exits 1 with the reason after comment and label are done. A refusal changes no status and the comment says so.
- **Owner's added scope (see Plan Change Log).** The marker round and the round derivation are described there; `markers()` now returns `round`, only comment idempotency compares it, a create ignores it. The watch step is documentation (`implement.md` section "Watch upstream", checklist item 1a, before any early end of the run); no code reads the upstream thread.
- **Not changed:** the 3.25 guards (owner's own click, replay, draft author and age, caps, own-issue, visible target, hidden text), `.claude/settings.json`, `AGENTS.md`, tickets, CHANGELOG.

Mutation checks (each fails at least one test): the status move; the result-comment author filter; "created before the draft" in `draftRound`; the closed-issue skip; the round in `sameMarker`; the relay refusal; `UPSTREAM` in `STALE_STATUSES`.

## Plan Change Log

### 2026-10-31 -- owner added scope (watch upstream and later replies)
- **Trigger:** owner decision 2026-10-31, relayed by the orchestrator. While an issue is `status:upstream`, every routine run checks the upstream thread named by the `<!-- upstream-post -->` result comment (our own workflow's, so trusted; never links from issue text), read with `WebFetch` (the API answers 403 in sessions); upstream text is untrusted data. Nothing new or bot noise: nothing (at most a "last checked" line, no new comment). A request for the reporter: do the work, write a reply draft in a new `<!-- issue-impl -->` comment, set `status:awaiting-post`, the owner labels again. Upstream closed or resolved: say so, mention the owner, suggest closing, never close.
- **One guard changes:** "one comment per target per issue of ours" must allow later replies. The marker line of a reply carries a round (`Filed for xtimor/openclaw-all-cli#54 (reply 2)`); idempotency holds per marker plus round; the workflow derives the round (earlier successful posts in its result comments, plus one); the agent never chooses it. Every other guard stays.
- **Amended (outside the intent contract):** Code Map, Tasks, docs (`implement.md` watch step, `identity.md`, `issues.md`, `comments.md`, `issue-flow.md`, `MEMORY.md`), tests (round 2 after round 1, re-label of round 2 returns existing, agent-supplied round ignored or refused). The intent contract is untouched (it is read-only during the build); its "Never" list still holds, and the new rule is stated here.
- **Decisions:** (1) round 1 has no suffix, so every comment already published stays valid; (2) the round counts publish result comments created BEFORE the latest `<!-- issue-impl -->` comment was created, so a re-label of the same reply keeps its round and returns `existing` instead of posting round 3; (3) only `github-actions[bot]` result comments with the headline `published as` count (a refusal and `existing` do not; a look-alike by the agent app or the owner's login does not); (4) a create never carries a round and ignores it when looking for an existing issue (a second new issue for the same need still needs a new issue of ours); (5) "ignored" for an agent-supplied round is implemented as: the round is never read from the draft, and a `round=` attribute or a `Filed for` line inside the draft is refused (the parser's two-attribute rule and the shared path's exactly-one-marker rule), which is stricter than silently ignoring it; (6) the watch step runs before any early end of the run and is docs only (no code reads the upstream thread).
- **Known bad state avoided:** counting all result comments would make a re-label of round 2 post round 3; counting any author's would let the agent raise the round.
- **KEEP:** the `status:upstream` move, the relay refusal, and the stale decision stay as first planned.

## Review Triage Log

### 2026-10-31 -- Review pass
- verdicts: 7 findings -- high 0, medium 0, low 5, false 1, maybe-false 1
- findings: (the Quick lens ran in the build's own session: no subagent tool was available, so it was not context-free)
  - `[low]` `[patch]` The watch step's "Last checked" edit could touch a comment that still holds a pending draft -- the doc now says the edit happens only in `status:upstream`, when the latest comment's draft is already published.
  - `[low]` `[defer]` A reply to an upstream issue the workflow created is refused unless our issue names that issue -- the 3.24 rule `checkNamesTarget`, unchanged; recorded in `deferred` and in `docs/issues.md`.
  - `[low]` `[reject]` A result comment that failed to post is not counted, so the next reply maps to the same round and returns the existing comment -- fail-safe (no duplicate); the owner labels again after the comment shows; in MEMORY.
  - `[low]` `[reject]` The move happens for an issue not in `awaiting-post` (e.g. the owner labels while it is `approved`) -- intended: the draft is published, the one status is `upstream`.
  - `[low]` `[reject]` The labels are read again before the move, a status the owner sets in those seconds is removed -- the window is a few requests; the owner's later click wins afterward (latest wins).
  - `[false]` `[reject]` Counting only "published as" results lets an `existing` re-label raise the round -- an `existing` headline is "nothing new was posted", not counted; test RELABEL_ROUND_2.
  - `[maybe-false]` `[reject]` `performed_via_github_app` of the workflow's own label events might make the state automation revert something -- it ignores `github-actions[bot]` events and `GITHUB_TOKEN` events start no run; would settle: the live #52/#53 move.

## Design Notes

Why the workflow sets `status:upstream`: it is a fact only the workflow knows (the publish succeeded), so the relay refuses it for agents; the state automation ignores the bot's label event and the one status stays. The move reads the issue's labels again just before it writes, adds `status:upstream`, then removes every other `status:*` label (404 passes).

Stale: no. `awaiting-post` is the owner's open task (a draft would be lost with a close; `blocked` is not stale-closed either); `upstream` waits for third parties for an unbounded time. The owner closes it when upstream settles.

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts test/upstream-post.test.ts test/agent-write.test.ts test/agent-flow-docs.test.ts test/sync-labels.test.ts` -- expected: pass
- `npm run ci` -- expected: pass

**Manual checks (if no CLI):**
- Live (not run here): #52/#53 move to `status:upstream` after the owner's label; the label sync creates both labels on `main`.

## Auto Run Result

Status: built. Blocking condition: none.

**Summary:** Two statuses. `status:awaiting-post`: an upstream draft is ready and only the owner acts (the implementation agent sets it instead of `blocked`). `status:upstream`: the draft was published (set only by the `Upstream post` workflow after the result comment and the label removal, for created, commented, and existing; a refusal leaves the status). Neither is closed by the stale job. The relay refuses adding `status:upstream`. Owner's added scope: every run watches the upstream thread of a `status:upstream` issue (docs step, thread from the workflow's result comment, `WebFetch`, upstream text untrusted), a request for us leads to a reply draft and `awaiting-post`, and a later reply carries `(reply N)` in its marker line, derived by the workflow from earlier publishes; idempotency holds per marker plus round.

**Files changed:** `.github/labels.yml`, `.github/workflows/upstream-post.yml` (header), `scripts/issue-flow/transitions.mjs`, `scripts/agent-write.mjs`, `scripts/upstream-issue.mjs`, `scripts/upstream-post.mjs`, `docs/agents/{implement,identity,comments,triage}.md`, `docs/issues.md`, `issue-flow.md`, `MEMORY.md`, tests `test/{issue-flow,upstream-post,upstream-issue,agent-write,agent-flow-docs,sync-labels}.test.ts`.

**Review:** 7 findings from the Quick lens, run in-session (no subagents): 1 patched (low), 1 deferred (low), 5 rejected or false with reasons in the triage log.

**Follow-up review recommended: false.** Patched: high 0, medium 0, low 1. (By the rule; the round derivation touches a posting guard and was reviewed only in-session, so an independent pass is still reasonable.)

**Verification:** `npm run ci` passed; seven mutation checks fail the intended tests.

**Not run:** live checks: #52/#53 moving to `status:upstream` after the owner's label; the label sync creating both labels on `main`; `WebFetch` of a real upstream thread by a routine run.

**Residual risks:** the round count trusts the `github-actions[bot]` result comments of this issue; a result comment that failed to post leaves the next reply at the same round (it returns the existing comment, nothing duplicates).
