---
title: 'The upstream workflow can also comment on the owner''s own OpenClaw issues'
type: 'feature'
ticket: 24
created: '2026-10-29'
status: done
baseline_revision: '6d6dc33afaa757f38304a9f6e1c32d1869e90acf'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/identity.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Several of the owner's open `openclaw/openclaw` issues wait for a repro or retest from us (#172969, #173057, #173060 are stale and close about 2026-11-02; also #180927, #173058). Agents can reproduce them, but the upstream workflow (ticket 3.23) only creates issues.

**Approach:** One more operation in `scripts/upstream-issue.mjs` and the `Upstream issue` workflow: `{op: "comment", issue: <number>, body}` posts one comment on an existing issue in `openclaw/openclaw`; create stays the default. `scripts/upstream-issue.sh` takes the same file shape. Docs and MEMORY follow.

## Boundaries & Constraints

**Always:** every 3.23 guard (owner dispatcher and triggering actor, attempt 1, main only, size limits, exactly one `Filed for xtimor/openclaw-all-cli#<n>` line whose issue is owner-approved, allow-list in code, token only through `env`, no token/body in any output). New guards: the target issue exists, is not a pull request, and its author is the token's user; idempotent (a comment by the token's user on that issue that already carries the same `Filed for` line is returned, not repeated); a cap of 5 comments per 24 hours across the target. Never close, label, or edit.

**Never:** a second write kind (no PATCH, PUT, DELETE, no label, no reopen); another repository; a comment on someone else's issue or on a pull request; change an `agent-write.mjs` guard; edit `.claude/settings.json`, `AGENTS.md`, `tickets.toml`, or run logs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Comment | own issue, approved marker, no earlier comment, under the cap | one POST of the body; `commented <url>#issuecomment-<id>` | No error expected |
| Repeat | a comment by the token's user with the same marker line is there | no POST; `existing <url>#issuecomment-<id>`, also at the cap | exit 0 |
| Not own | author is another user, unknown, or a pull request | refused, nothing posted | exit 1 |
| Missing | issue is 404/410, answer unreadable, number differs | refused or failed, nothing posted | exit 1 |
| Approval | marker issue not owner-approved, missing, or two markers | refused before anything upstream | exit 1 |
| Cap | 5 comments by the user in 24 hours on their issues | refused, nothing posted | exit 1 |
| Shape | other op, mixed fields, bad or huge issue number | refused, no request | exit 1 |
| API | list or POST fails, 403 echoing the token | failure with status only, token `[redacted]` | exit 1 |

</intent-contract>

## Code Map

- `scripts/upstream-issue.mjs` -- `validate` per op (`KEYS`); `readUser`, `checkTarget`, `findExistingComment`, `countRecentComments`, `postComment`, `runComment`; the create path unchanged. Reuses `checkApproved`, `markers`, `makeClient`, `WriteError`.
- `scripts/upstream-issue.sh` -- `RESULT_RE` takes `commented` and an optional `#issuecomment-<id>`; header text.
- `.github/workflows/upstream-issue.yml` -- comments and the input description only (permissions, env, steps unchanged).
- `test/upstream-issue.test.ts`, `test/upstream-issue-sh.test.ts`, `test/agent-flow-docs.test.ts` -- the matrix, mutation targets, doc pins.
- `docs/agents/identity.md` (Comments), `docs/agents/implement.md` (Upstream follow-up), `docs/issues.md`, `MEMORY.md`.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/upstream-issue.mjs` -- add the comment operation and its guards -- the ticket
- [x] `scripts/upstream-issue.sh`, workflow comments -- accept and describe the new result line
- [x] tests -- one block per matrix row, mutation checks
- [x] docs and MEMORY -- file shape, guards, how an approved follow-up issue ends

**Acceptance Criteria:**
- Given an owner-approved issue of ours and the owner's own upstream issue, when the workflow runs a comment file, then one comment is posted and its URL printed; the same file again returns that comment.
- Given any refused input or guard, then no write request is sent and no stream holds the token.
- Given `npm run ci`, then it passes.

## Implementation Notes

No subagent tool was available to this worker, so the build and the four review lenses ran in-session (full route by size, no implementing subagent), as for ticket 3.23. Decisions:

- The cap ("5 per 24 hours across the target") is counted on the token user's own issues in the target that were updated in the last 24 hours (`GET /issues?creator=&since=`, then each one's `/comments?since=`), because the repository-wide comment list cannot be filtered by user and the target is a busy repository. Those are the only issues this operation can reach, so every comment it posts is counted; the owner's hand-written comments on their own issues count too, those elsewhere do not. At most 60 requests; more refuses.
- Idempotency is one comment per marker per target issue (the ticket's rule). A second note on the same target needs its own approved issue of ours.
- A closed target issue still gets the comment (a stale report that closed); a locked one fails with GitHub's 403.
- How an approved follow-up issue ends (the ticket left it open): no ticket, no code; one comment through this operation; a plain batch-PR line with the URL and none of `Fixes`/`Closes`/`Resolves`/`Refs`; `status:blocked` awaiting the owner, who closes it (agents never close).
- Result words `commented|existing`; the URL carries `#issuecomment-<id>`, built from numbers, not from GitHub's `html_url`.

Mutation checks (each fails at least one test): author check removed, pull-request check removed, cap 5 to 50, idempotency removed, approval removed, marker equality removed, user filter removed from the existing-comment search and from the cap count, missing-issue refusal removed.

## Plan Change Log

## Review Triage Log

### 2026-10-29 -- Review pass
- verdicts: 13 findings -- high 0, medium 0, low 9, false 4, maybe-false 0
- findings: (all four lenses -- blind hunter, edge-case hunter, verification gap, intent alignment -- ran in the build's own session: no subagent tool was available, so none was context-free)
  - `[low]` `[patch]` No test says what a closed or locked target issue does -- tests added: closed is commented, locked fails with the 403 and writes once.
  - `[low]` `[patch]` The cap test did not pin `since` on the comment lists -- an assertion added (a missing `since` would count every old comment).
  - `[low]` `[reject]` `findExisting` builds `{login}` around `readUser` only to keep its signature -- harmless; the exported function keeps its 3.23 shape.
  - `[low]` `[reject]` `runComment` takes a context object of eight members -- one caller; splitting `run` further would only move code.
  - `[low]` `[reject]` The cap counts the owner's hand-written comments on their own issues and misses ones elsewhere -- by design (the workflow can reach only the user's own issues), recorded in MEMORY and identity.md.
  - `[low]` `[reject]` One comment per marker per target blocks a second note on the same target -- the ticket's rule; the docs say a second note needs its own approved issue.
  - `[false]` `[reject]` Commenting needs the target's author to equal `/user`, so a bot token could comment on its own issues -- intended; the token's user is the owner's account.
  - `[false]` `[reject]` The issue-list `since` filter could hide a recent comment -- a comment bumps the issue's `updated_at`, and the comment is read with its own `since` and `created_at` check.
  - `[false]` `[reject]` A transferred issue (301) could send the comment to another repository -- `redirect: "error"` fails the request; the issue's number is also compared.
  - `[false]` `[reject]` `op: "create"` widens the accepted shapes -- it is the default spelled out; a create still takes only create fields (tested).
  - `[low]` `[reject]` More than 1000 comments on the target, or more than 60 requests for the cap, refuses -- fail closed on purpose; the owner's stale reports do not come close.
  - `[low]` `[reject]` Real-runner behavior of the `since` filters and of an unreadable annotation is not verified here -- documented REST behavior; failure mode is exit 1 with an idempotent retry.
  - `[low]` `[reject]` The live run is not done -- the ticket's verify says the first follow-up issue posts through it; recorded as not run.

### 2026-10-29 -- Independent security review (after the build)
- verdicts: 3 findings -- high 0, medium 1, low 2, false 0, maybe-false 0
- findings: (from an independent reviewer of `6d6dc33..HEAD`; fixed on the same branch by the build worker, in-session; the review found nothing blocking)
  - `[medium]` `[patch]` One approved issue of ours allowed a comment on every one of the owner's upstream issues, up to the cap -- `checkApproved` now returns the issue it fetched, and `checkNamesTarget` refuses, before anything upstream (an existing comment included), unless its title or body names the target as `openclaw/openclaw#<n>` or `https://github.com/openclaw/openclaw/issues/<n>`: case-insensitive, number matched exactly (`#1729` and `#1729690` do not match `#172969`), not preceded by a word, `.`, `/`, or `-` character. Tests: the "must name the target" block; mutation checks (check removed, number boundary removed, prefix guard removed, URL form removed) each fail a test. The stub's default issue 45 now names `#172969` and `#173057`. Docs: `identity.md`, `implement.md`, `MEMORY.md`.
  - `[low]` `[patch]` A comment refused for its actors, attempt, or shape said "nothing created" -- `asksForComment` peeks at `op` before any check, so every refusal of a comment input says "nothing posted"; a create (and an unparsable input or another op) still says "nothing created". Test `WORDING`; the mutation (always "created") fails 6 tests.
  - `[low]` `[patch]` The second half of the cap test ("the count spans pages ... stops reading at the cap") reused answers of the first half -- it now starts from a fresh `answers` map.

## Design Notes

Why count on the user's own issues: GitHub has no per-user comment filter, search lags minutes, and the repository-wide comment list of a busy repository is too large; the set of issues this operation can touch is exactly the user's own, so counting there is complete for the cap's purpose. Why `existing` wins over the cap: a retry after a lost answer must return the posted comment, not fail.

## Verification

**Commands:**
- `npx vitest run test/upstream-issue.test.ts test/upstream-issue-sh.test.ts test/agent-flow-docs.test.ts` -- expected: pass
- `npm run ci` -- expected: pass

**Manual checks (if no CLI):**
- Live (not run here): the first upstream follow-up issue (one of #172969, #173057, #173060, #180927, #173058) posts its comment through the workflow.

## Auto Run Result

Status: built. Blocking condition: none.

**Summary:** The `Upstream issue` workflow and `scripts/upstream-issue.mjs` take `{"op": "comment", "issue": <n>, "body": "...\nFiled for xtimor/openclaw-all-cli#<m>"}` (create stays the default). It posts one comment on an issue of `openclaw/openclaw` that the token's user opened, after the 3.23 guards (owner dispatcher and triggering actor, attempt 1, main only, limits, exactly one marker line whose issue is owner-approved) and the new ones: the target exists and is not a pull request, a comment with the same marker line is returned instead of repeated, and a sixth comment in 24 hours is refused. Its only write is `POST /issues/<n>/comments`. `scripts/upstream-issue.sh` takes the same file and prints the comment URL.

**Files changed:** `scripts/upstream-issue.mjs`, `scripts/upstream-issue.sh`, `.github/workflows/upstream-issue.yml` (comments and input description), `test/upstream-issue.test.ts`, `test/upstream-issue-sh.test.ts`, `test/agent-flow-docs.test.ts`, `docs/agents/identity.md`, `docs/agents/implement.md`, `docs/issues.md`, `MEMORY.md`, this plan.

**Review:** 13 findings from four lenses run in-session (no subagents available): 2 patched (low), 0 deferred, 11 rejected or false with reasons in the triage log. The independent security review added 3 findings (1 medium, 2 low), all patched: the approved issue must name the target, comment refusals say "nothing posted", the cap test starts from fresh answers.

**Follow-up review recommended: false.** Patched: high 0, medium 0, low 2.

**Verification:** `npm run ci` passed (plan gate, typecheck, unit tests, build, package checks, install smoke); `test/upstream-issue.test.ts` (52), `test/upstream-issue-sh.test.ts` (11), and the doc pins pass; nine mutation checks fail the intended tests.

**Not run:** the live comment on a real upstream issue (needs the secret and an approved issue of ours); the real-runner behavior of the `since` filters of the issue and comment lists (REST documentation only).

**Residual risks:** the cap sees only comments on the token user's own issues; one comment per marker per target issue; an approved issue is approved "at some point" (a later label removal does not stop a dispatch); the events API can lag right after the owner labels the issue (dispatch again).
