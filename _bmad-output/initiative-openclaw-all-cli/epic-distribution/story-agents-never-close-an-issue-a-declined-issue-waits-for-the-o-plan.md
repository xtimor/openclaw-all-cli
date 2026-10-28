---
title: 'Agents never close an issue; a declined issue waits for the owner or times out'
type: 'feature'
ticket: 22
created: '2026-10-28'
status: done
baseline_revision: '13e6bcc4b8cc2894766929dcba499c8185183dcf'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** On 2026-10-28 triage closed bug #45 as not planned on its own. The owner decided that agents never close an issue quietly; the triage reject, duplicate, done-ticket, and implementation-stop paths and the relay `close` op all allow it.

**Approach:** A new `status:declined` (reason and evidence, owner mentioned, issue stays open). The daily job closes a declined issue untouched for 30 days, like `needs-info`. Agents lose every close path except a security report, and the relay enforces that.

## Boundaries & Constraints

**Always:** an agent that cannot or will not fix an issue asks the author (`status:needs-info`) or sets `status:declined`; the owner closes it or moves its status; a security report is closed at once with a pointer to `SECURITY.md` and no detail; the stale job closes, never deletes; latest status wins as for the others.

**Never:** an agent close of any other issue; changing the approval rules, the batch flow, or `tickets.toml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Declined 31 days | open, `status:declined` labeled 31 days ago | comment mentioning author and owner, status removed, closed not planned | no readable event: last update counts |
| Declined 29 days | same, 29 days | stays open | — |
| Declined, author replies | comment by the author | no status change (the owner decides) | — |
| Owner moves it | `status:declined` replaced by `status:new` / `approved` | normal settle; latest status wins | — |
| Relay close, security | `comment` with the exact security text, then `close` `not_planned`, same issue | applied | — |
| Relay close, anything else | no such comment before it, another reason, or another issue | whole list refused, nothing applied | exit 1 names the rule |

</intent-contract>

## Code Map

- `.github/labels.yml` -- add `status:declined`; `test/issue-flow.test.ts` "STATUS_LABELS" reads it.
- `scripts/issue-flow/transitions.mjs` -- `STATUS_LABELS`, `staleIssues`, `onStale`, `needsInfoSince`, `staleComment`; add `DECLINED`, a stale-status list, `statusSince`, `declinedStaleComment(login, owners)`.
- `scripts/issue-flow/apply.mjs` -- `runStale` lists `needs-info` and `declined`, reads the label time per issue, passes `owners` (env `ISSUE_FLOW_OWNERS`) to `decide`.
- `.github/workflows/issue-flow.yml` -- step name only (owners already in `env`).
- `scripts/agent-write.mjs` -- `validate` (cross-operation check) for `close`; export `SECURITY_CLOSE_COMMENT`; `handlers.close` unchanged.
- `docs/agents/{triage,implement,identity,comments}.md`, `docs/issues.md`, `issue-flow.md`, `MEMORY.md`, `CHANGELOG.md` -- the new rule.
- Tests: `test/issue-flow.test.ts`, `test/agent-write.test.ts`, `test/agent-flow-docs.test.ts`.

## Tasks & Acceptance

**Execution:**
- [ ] `.github/labels.yml`, `scripts/issue-flow/*`, workflow step name -- `status:declined` is a status; the stale job covers it -- latest status wins, owner moves work as for others
- [ ] `scripts/agent-write.mjs` -- `close` only after the exact `SECURITY_CLOSE_COMMENT` comment on the same issue in the same list, reason `not_planned` -- the guard is pure validation, no extra request, and the text itself holds no detail
- [ ] `docs/**`, `issue-flow.md`, `MEMORY.md`, `CHANGELOG.md` -- triage reject, duplicate, done-ticket and implementation-stop paths end in `status:declined` or `needs-info`; the security comment appears verbatim in `triage.md`
- [ ] tests -- the matrix rows, a doc test that the two agent docs have no close path but the security report

**Acceptance Criteria:**
- Given a declined issue labeled 30 or more days ago, when the daily job runs, then it is closed as not planned with a comment mentioning the author and the owner; at 29 days it stays open.
- Given a relay list with a `close` that lacks the exact security comment before it, when the relay validates it, then the list is refused and nothing is sent.
- Given `triage.md` and `implement.md`, when read, then the only close they allow is the security report.

## Implementation Notes

No subagent tool was available to this worker, so the build was done in-session (full route by size, no implementing subagent). Files: `.github/labels.yml` (`status:declined`), `scripts/issue-flow/{transitions,apply}.mjs` (`DECLINED`, `STALE_STATUSES`, `staleStatus`, `statusSince`, `declinedStaleComment`; `runStale` lists both labels, dedupes, reads `ISSUE_FLOW_OWNERS`), `.github/workflows/issue-flow.yml` (step name), `scripts/agent-write.mjs` (`SECURITY_CLOSE_COMMENT`, close guard in `validate`), docs, `MEMORY.md`, `CHANGELOG.md`, tests. Decisions: the relay keeps `close` only for a security report; the guard is the exact pointer comment on the same issue earlier in the same list plus reason `not_planned` (pure validation); an author's reply leaves a declined issue as it is; an issue with both stale labels is handled as `needs-info`. Mutation checks: guard off, `declined` removed from `STALE_STATUSES`, and a close path added to `triage.md` each fail a test.

## Plan Change Log

## Review Triage Log

### 2026-10-28 -- Review pass
- verdicts: 5 findings -- high 0, medium 0, low 3, false 1, maybe-false 1
- findings: (the Quick lens ran in the build's own session: no subagent tool was available)
  - `[low]` `[patch]` An issue carrying both stale labels was not covered by a test -- added `decide`-level behavior test in `runStale` (listed once, needs-info comment, one close).
  - `[low]` `[reject]` The guard proves the pointer wording, not that the issue is a vulnerability, and the relay-off path has no relay guard -- the ticket's design (a marker for the case); a stronger proof needs an issue read or a label, which adds a request and a hide step; recorded in Design Notes and MEMORY.
  - `[low]` `[reject]` The doc test's filter passes any line with "owner" or "pull request" -- it pins the known paths; a stricter parse is brittle, the guard in the relay is the real enforcement.
  - `[false]` `[reject]` An author's reply should move a declined issue to `new` like `needs-info` -- the ticket says the owner adds information and moves it; `onComment` is unchanged and a test pins the no-op.
  - `[maybe-false]` `[reject]` `status:declined` may not exist when the relay adds it before the label sync runs -- would settle: a live add of an unknown label; low if true (GitHub creates a label on add, and the sync creates it after merge).

## Design Notes

Choices (mine, per the ticket): the relay keeps `close` only for the security case. The guard cannot know an issue is a security report, so the marker is the agent's own fixed comment: the list must post the exact `SECURITY_CLOSE_COMMENT` on that issue before the `close`. It is pure validation (no label, no read of issue text), it forces the pointer-only wording the rule asks for (no detail can ride along), and the public text shows why the issue was closed, so a misuse is visible and the owner reopens. It does not prove the issue is a vulnerability; that stays the agent's judgment, reviewable in the open.

## Verification

**Commands:**
- `npx vitest run test/issue-flow.test.ts test/agent-write.test.ts test/agent-flow-docs.test.ts` -- expected: pass
- `npm run ci` -- expected: pass

**Manual checks (if no CLI):**
- Live (not run here): the next triage run that rejects an issue labels it `status:declined` and leaves it open; the label sync creates the label on `main`.

## Auto Run Result

Status: built. Blocking condition: none.

**Summary:** `status:declined` is a status (label file, state automation, 9 states). The daily job closes a `needs-info` or `declined` issue 30 days after its latest status label; a declined close mentions the author and the owners. `triage.md`, `implement.md`, `identity.md`, `comments.md`, `issues.md`, and `issue-flow.md` send every reject, duplicate, done-ticket, and cannot-build path to `needs-info`, `declined`, or `blocked`, never a close. The relay `close` op now allows only a security report: reason `not_planned`, and the same list must post the exact `SECURITY_CLOSE_COMMENT` on that issue before it; any other close refuses the whole list.

**Files changed:** `.github/labels.yml`, `.github/workflows/issue-flow.yml`, `scripts/issue-flow/{transitions,apply}.mjs`, `scripts/agent-write.mjs`, `docs/agents/{triage,implement,identity,comments}.md`, `docs/issues.md`, `issue-flow.md`, `MEMORY.md`, `CHANGELOG.md`; tests `test/{issue-flow,agent-write,agent-flow-docs,sync-labels}.test.ts`.

**Review:** 5 findings from the Quick lens, run in-session (no subagents were available): 1 patched (low), 0 deferred, 4 rejected or false with reasons in the triage log.

**Follow-up review recommended: false.** Patched: high 0, medium 0, low 1.

**Verification:** `npm run ci` passed (typecheck, tests, build, package checks, install smoke, plan gate); three mutation checks fail the intended tests.

**Not run:** live checks: the next triage run that declines an issue; the label sync on `main`; a real stale run on a declined issue.

**Residual risks:** the relay cannot tell a vulnerability from a pretext (an agent can post the pointer on any issue, in public, and the owner reopens); with the relay off the rule is documentation only.
