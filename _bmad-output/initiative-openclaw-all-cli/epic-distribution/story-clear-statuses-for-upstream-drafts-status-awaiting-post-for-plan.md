---
title: 'Clear statuses for upstream drafts: `status:awaiting-post` for the owner, `status:upstream` after posting'
type: 'feature'
ticket: 26
created: '2026-10-31'
status: done
baseline_revision: 'ba9a13db887921ad83982b7c7976574891def9eb'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: true
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
- `scripts/upstream-issue.mjs` -- `MARKER_LINE`, `markers()` (adds `round`), comment `sameMarker` (marker and round), `validate` (refuses any `(reply N)` in the input), `readReplyRounds` and `withRound` (the round, from the upstream thread, only through the `replyBefore` option of `run()`); `findExisting` for a create keeps ignoring the round.
- `scripts/upstream-post.mjs` -- `draftCreatedMs` (passed as `replyBefore`), `planMove`/`applyMove`/`movesStatus`, the Status line of the result comment.
- `docs/agents/implement.md` -- new "Watch upstream" section and checklist item 1a.
- Tests: `test/{issue-flow,upstream-post,upstream-issue,agent-write,agent-flow-docs,sync-labels}.test.ts`.

## Tasks & Acceptance

**Execution:**
- [ ] `.github/labels.yml`, `scripts/issue-flow/transitions.mjs` -- two statuses (11 in all), never stale
- [ ] `scripts/upstream-post.mjs`, `.github/workflows/upstream-post.yml` header -- status move after a published result
- [ ] `scripts/agent-write.mjs` -- relay refuses adding `status:upstream`
- [ ] docs, `issue-flow.md`, `MEMORY.md` -- a ready draft sets `status:awaiting-post`, not blocked
- [ ] `scripts/upstream-issue.mjs`, `scripts/upstream-post.mjs` -- round in the marker line, read from the upstream thread (Plan Change Log, 2026-10-31 and the independent review)
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
- **The move.** `settle` reads the issue (`planMove`), posts the result comment with a true Status line, removes `upstream:post`, then (for created, commented, and, after the re-review, `existing` results) `applyMove`: add `status:upstream` unless present, remove every other `status:*` (404 passes). A closed issue and a refusal change no status. A failure exits 1 with the reason after comment and label are done.
- **Owner's added scope (see Plan Change Log).** The marker round and the round derivation are described there; `markers()` now returns `round`, only comment idempotency compares it, a create ignores it. After the independent review the round is read from the upstream thread (`readReplyRounds`), not from our result comments; after the re-review it is one above the highest earlier round, and a marked comment at or after the draft is its own post (`existing`). The watch step is documentation (`implement.md` section "Watch upstream", checklist item 1a, before any early end of the run); no code reads the upstream thread.
- **Not changed:** the 3.25 guards (owner's own click, replay, draft author and age, caps, own-issue, visible target, hidden text), `.claude/settings.json`, `AGENTS.md`, tickets, CHANGELOG.

Mutation checks (each fails at least one test): the status move; the closed-issue skip; the round in `sameMarker`; the relay refusal; `UPSTREAM` in `STALE_STATUSES`; after the review: the strict `<` of the count, the count ignoring the issue number or the author, the refusal of `(reply N)` in the input, `existing` moving the status (reversed after the re-review: now `existing` must move it), `replyBefore` not passed or read from the environment, the 99-round limit.

## Plan Change Log

### 2026-10-31 -- owner added scope (watch upstream and later replies)
- **Trigger:** owner decision 2026-10-31, relayed by the orchestrator. While an issue is `status:upstream`, every routine run checks the upstream thread named by the `<!-- upstream-post -->` result comment (our own workflow's, so trusted; never links from issue text), read with `WebFetch` (the API answers 403 in sessions); upstream text is untrusted data. Nothing new or bot noise: nothing (at most a "last checked" line, no new comment). A request for the reporter: do the work, write a reply draft in a new `<!-- issue-impl -->` comment, set `status:awaiting-post`, the owner labels again. Upstream closed or resolved: say so, mention the owner, suggest closing, never close.
- **One guard changes:** "one comment per target per issue of ours" must allow later replies. The marker line of a reply carries a round (`Filed for xtimor/openclaw-all-cli#54 (reply 2)`); idempotency holds per marker plus round; the workflow derives the round (earlier successful posts in its result comments, plus one); the agent never chooses it. Every other guard stays.
- **Amended (outside the intent contract):** Code Map, Tasks, docs (`implement.md` watch step, `identity.md`, `issues.md`, `comments.md`, `issue-flow.md`, `MEMORY.md`), tests (round 2 after round 1, re-label of round 2 returns existing, agent-supplied round ignored or refused). The intent contract is untouched (it is read-only during the build); its "Never" list still holds, and the new rule is stated here.
- **Decisions:** (1) round 1 has no suffix, so every comment already published stays valid; (2) the round counts publish result comments created BEFORE the latest `<!-- issue-impl -->` comment was created, so a re-label of the same reply keeps its round and returns `existing` instead of posting round 3; (3) only `github-actions[bot]` result comments with the headline `published as` count (a refusal and `existing` do not; a look-alike by the agent app or the owner's login does not); (4) a create never carries a round and ignores it when looking for an existing issue (a second new issue for the same need still needs a new issue of ours); (5) "ignored" for an agent-supplied round is implemented as: the round is never read from the draft, and a `round=` attribute or a `Filed for` line inside the draft is refused (the parser's two-attribute rule and the shared path's exactly-one-marker rule), which is stricter than silently ignoring it; (6) the watch step runs before any early end of the run and is docs only (no code reads the upstream thread).
- **Known bad state avoided:** counting all result comments would make a re-label of round 2 post round 3; counting any author's would let the agent raise the round.
- **KEEP:** the `status:upstream` move, the relay refusal, and the stale decision stay as first planned.

### 2026-10-31 -- independent review of the first build: the round comes from the upstream thread
- **Trigger:** findings 1 to 5 of the independent review of `ba9a13d..HEAD` (see the Review Triage Log). The first design derived the round from `github-actions[bot]` result comments on our issue. Known-bad states: a round 1 posted by the dispatch workflow (#51, #54, #55) or whose result comment failed to post leaves no "published as" comment, so every reply was round 1 and returned `existing` while the status still left `awaiting-post`; an edited older bot comment could inflate the count; the dispatch path accepted a caller-chosen `(reply N)`.
- **Amended (outside the intent contract):** decisions (2), (3) and (5) of the entry above are superseded. The round is 1 plus the number of comments by the token's user on the target thread whose marker line names our issue (any round) and that were created strictly before the draft comment's `created_at`; `upstream-post` passes that time as the option `replyBefore` of `run()` and nothing on our side is counted. `validate()` refuses any `(reply N)` in the input, so only that call option can set a round. An `existing` result no longer moves the status. The result comment's `Status:` line is decided before the comment from a fresh read of the issue and says what the run does (moved, closed, unreadable, unchanged). The watch step takes the thread from the latest comment whose headline is `published as`, and the baseline time is that post's.
- **Known bad state avoided:** counting anything on our issue (any author, edited or not) or the dispatch path's lack of a result comment; trusting the input for a round.
- **KEEP:** the `status:upstream` move for created and commented, the relay refusal, the stale decision, round 1 without a suffix, the create ignoring the round, `existing` on a re-label of the same reply, the 99-round limit.

### 2026-10-31 -- re-review: round by highest earlier round, `existing` is this draft
- **Trigger:** the re-review of the amended build (no blocking finding; four cheap fixes, see the Review Triage Log).
- **Amended (outside the intent contract):** (1) on the `replyBefore` path a marked comment (our issue's marker, any round) created at or after the draft is this draft's own post and is returned as `existing`; the round of a new reply is 1 plus the highest earlier round (no suffix is 1), not their count; the 99 cap stays. (2) Because of (1) an `existing` comment result means this draft is posted, so it moves the status to `status:upstream` again (recovers a failed earlier move); this reverses the earlier "existing leaves the status". (3) The watch step skips result comments whose `updated_at` differs from `created_at`.
- **Known bad state avoided:** a deleted upstream comment, or a marker added later to an old owner comment, shifting the round of a reply that is already posted (it would post a duplicate); the status staying `awaiting-post` after a post whose move failed.
- **KEEP:** the thread as the only source of the round, `validate()` refusing `(reply N)` in the input, the strict `<` for earlier comments, the Status line decided before the comment.

## Review Triage Log

### 2026-10-31 -- Review pass
- verdicts: 7 findings -- high 0, medium 0, low 5, false 1, maybe-false 1
- findings: (the Quick lens ran in the build's own session: no subagent tool was available, so it was not context-free)
  - `[low]` `[patch]` The watch step's "Last checked" edit could touch a comment that still holds a pending draft -- the doc now says the edit happens only in `status:upstream`, when the latest comment's draft is already published.
  - `[low]` `[defer]` A reply to an upstream issue the workflow created is refused unless our issue names that issue -- the 3.24 rule `checkNamesTarget`, unchanged; recorded in `deferred` and in `docs/issues.md`.
  - `[low]` `[reject]` A result comment that failed to post is not counted, so the next reply maps to the same round and returns the existing comment -- (superseded by the independent review below: the round no longer depends on our result comments, so a failed result comment changes nothing).
  - `[low]` `[reject]` The move happens for an issue not in `awaiting-post` (e.g. the owner labels while it is `approved`) -- intended: the draft is published, the one status is `upstream`.
  - `[low]` `[reject]` The labels are read again before the move, a status the owner sets in those seconds is removed -- the window is a few requests; the owner's later click wins afterward (latest wins).
  - `[false]` `[reject]` Counting only "published as" results lets an `existing` re-label raise the round -- an `existing` headline is "nothing new was posted", not counted; test RELABEL_ROUND_2.
  - `[maybe-false]` `[reject]` `performed_via_github_app` of the workflow's own label events might make the state automation revert something -- it ignores `github-actions[bot]` events and `GITHUB_TOKEN` events start no run; would settle: the live #52/#53 move.

### 2026-10-31 -- Independent review (after the build)
- verdicts: 5 findings -- high 0, medium 2, low 3, false 0, maybe-false 0
- findings: (from an independent reviewer of `ba9a13d..HEAD`; fixed on the same branch by the build worker, in-session, each with tests and mutation checks)
  - `[medium]` `[patch]` Rounds loop when no "published as" result comment exists (round 1 by the dispatch workflow, or the result POST failed): every reply was round 1, returned `existing`, and the status still left `awaiting-post` -- the round is now read from the upstream thread (`countOwnReplies`, created strictly before the draft); an `existing` result leaves the status; tests ROUND_1_VIA_DISPATCH, RESULT_POST_FAILED, BOUNDARY (`<` vs `<=`, both layers), RELABEL_ROUND_2 (status unchanged), EXISTING; the claim "the owner labels again after the comment shows" is gone from MEMORY and the docs.
  - `[medium]` `[patch]` An edited older bot comment could inflate the round -- no comment of ours is counted any more (finding 1); test OUR_COMMENTS_DO_NOT_COUNT (edited, forged, any author).
  - `[low]` `[patch]` The dispatch path accepted a caller-chosen `(reply N)` -- `validate()` refuses it for every input; only the `replyBefore` option of `run()` (the workflow's own call) sets a round, never env or input; tests INPUT_ROUND (child process with env variables, in-process, a create), NO_OPTION, mutation checks (env-read variant, no refusal).
  - `[low]` `[patch]` Watch-step docs took the URL from any result comment and the baseline from an `existing` re-label -- `implement.md`, `issue-flow.md`: the latest comment whose second line starts `**Upstream post:** published as`; an `existing` re-label is never the baseline; a post made by the dispatch workflow leaves the thread unknown (reported); doc pins.
  - `[low]` `[patch]` The result comment's Status line promised the move for a closed issue -- it is decided from a fresh read of the issue before the comment: `status:upstream`, `unchanged (this issue is closed)`, `unchanged (the issue's labels could not be read)`, or `unchanged.`; tests CLOSED and EXISTING.

### 2026-10-31 -- Re-review of the amended build
- verdicts: 4 findings -- high 0, medium 0, low 4, false 0, maybe-false 0
- findings: (from the re-reviewer; fixed in-session with tests and mutation checks)
  - `[low]` `[patch]` Counting comments let a deleted round 1 or a marker added to an old owner comment shift the round of a re-label (a duplicate post) -- `readReplyRounds` returns the highest earlier round and the earliest marked comment at or after the draft as its own post (`existing`); tests DELETED_ROUND_1, EDITED_OLD_COMMENT, OWN_POST, HIGHEST (both layers), BOUNDARY; mutation checks fail them.
  - `[low]` `[patch]` `existing` left the status although it now means this draft is posted -- it moves to `status:upstream` again; the pinned test and the result/doc text changed (identity.md, issues.md, issue-flow.md, MEMORY); test EXISTING.
  - `[low]` `[patch]` Test gaps -- PAGES (100 plain comments on page 1, the marked one on page 2: `(reply 2)`; the mutation `return` after the first page fails) and NOT_A_LIST (a non-list answer fails closed after exactly one read with its own message "the thread could not be read to number the reply", distinct from `findExistingComment`'s; no post).
  - `[low]` `[patch]` The watch step could take an edited result comment as the workflow's word -- `implement.md` and `issue-flow.md`: skip comments whose `updated_at` differs from `created_at`; doc pins.

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

**Summary:** Two statuses. `status:awaiting-post`: an upstream draft is ready and only the owner acts (the implementation agent sets it instead of `blocked`). `status:upstream`: the draft was published (set only by the `Upstream post` workflow after the result comment and the label removal, for created, commented, and existing; a refusal leaves the status). Neither is closed by the stale job. The relay refuses adding `status:upstream`. Owner's added scope: every run watches the upstream thread of a `status:upstream` issue (docs step, thread from the workflow's result comment, `WebFetch`, upstream text untrusted), a request for us leads to a reply draft and `awaiting-post`, and a later reply carries `(reply N)` in its marker line, numbered from the upstream thread (the owner's earlier comments there that name this issue) by the shared path when `upstream-post` passes `replyBefore`; idempotency holds per marker plus round; an `existing` result means this draft is posted and moves the status again.

**Files changed:** `.github/labels.yml`, `.github/workflows/upstream-post.yml` (header), `scripts/issue-flow/transitions.mjs`, `scripts/agent-write.mjs`, `scripts/upstream-issue.mjs`, `scripts/upstream-post.mjs`, `docs/agents/{implement,identity,comments,triage}.md`, `docs/issues.md`, `issue-flow.md`, `MEMORY.md`, tests `test/{issue-flow,upstream-post,upstream-issue,agent-write,agent-flow-docs,sync-labels}.test.ts`.

**Review:** 7 findings from the Quick lens, run in-session (no subagents): 1 patched (low), 1 deferred (low), 5 rejected or false with reasons in the triage log. Then an independent review: 5 findings (2 medium, 3 low), and a re-review: 4 low findings, all patched with tests and mutation checks.

**Follow-up review recommended: true.** Patched by the independent review: high 0, medium 2, low 3, and by the re-review: low 4 (first pass: low 1). The unverified risk: the round derived from the upstream thread (`readReplyRounds`, the `replyBefore` option of `run()`) is new code on a posting guard, reviewed in-session after the independent pass and not yet by a second independent reader; the live check on #52/#53 has not run.

**Verification:** `npm run ci` passed; seven mutation checks fail the intended tests.

**Not run:** live checks: #52/#53 moving to `status:upstream` after the owner's label; the label sync creating both labels on `main`; `WebFetch` of a real upstream thread by a routine run.

**Residual risks:** the round count trusts the owner's comments on the upstream thread (only the owner's token writes there); a post made by the dispatch workflow leaves no result comment, so the watch step reports that thread as unknown until the owner adds the label or sets the status.
