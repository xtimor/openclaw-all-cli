---
title: 'A bug in `status:triaged` is reproduced: triage accepts a bug only with a failing reproduction'
type: 'feature'
ticket: 29
created: '2026-11-02'
status: built
baseline_revision: '72fb186f2fe16c136ce8af4481aa0f6acd3fc8a7'
route: 'oneshot'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['in-session']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/MEMORY.md', '{project-root}/docs/agents/triage.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `status:triaged` on a bug can rest on "explained by code": triage may accept a bug it never reproduced, so the owner approves on a plausible reading and the build has no failing test to turn green.

**Approach:** A bug is accepted only with a reproduction on current `main` (a failing test of the agent's own, or live output): a required `Reproduction:` part in the comment, the test named as the regression test in the draft ticket's verify line, committed with the fix by the implementation run. Not reproduced: `needs-info` to the author, `needs-info` to the owner naming the live check, or `declined` with evidence. Ideas and the security rules are unchanged.

</intent-contract>

## Implementation Notes

Route is `oneshot`, pinned: the work is documents plus doc pins, and this worker has no subagent tool.

Decisions:
- All bug accepts need the reproduction (every path, regressions, carried-over approvals). A carried-over approval re-runs the main comment's test on current `main`; an older main comment without `Reproduction:` is a normal re-triage.
- The implementation run hands the test to the build through the ticket (description of a new ticket, a note on an existing one), because the build reads the ticket and plan, not GitHub, and a red test file committed earlier would break `npm test` for every other ticket of the batch. The build adds it first, sees it fail, fixes, commits it with the fix. A test that already passes on the branch blocks the issue for the owner. An approved older comment without `Reproduction:` builds as before.
- Owner route stays `needs-info` as the ticket says. The first build left it needing the owner's `status:todo` click (deferred); the owner decided to fix it in this ticket (see the Plan Change Log): the state automation now takes an owner's own comment as the reply.
- No `CHANGELOG.md` line: agent-flow change only (docs/release.md, Changelog).
- Pins are predicates with one mutation each; the test applies the mutation and requires the pin to fail, and throws if a mutation no longer matches (stale).

Files touched: `docs/agents/{triage,comments,implement}.md`, `docs/issues.md`, `epic-distribution/issue-flow.md`, `MEMORY.md`, `test/agent-flow-docs.test.ts`, `scripts/issue-flow/{transitions,apply}.mjs`, `test/issue-flow.test.ts`, this plan.

## Plan Change Log

### 2026-11-02 -- owner decision 2026-11-02, via the orchestrator
- Triggering finding: the deferred medium finding of the first review (an owner-awaited `needs-info` is not moved by the owner's comment, and its stale close mentions only the author).
- Amended: scope now includes `scripts/issue-flow/transitions.mjs` `onComment` (on `status:needs-info`, a comment by the author or by an owner as a person, `performed_via_github_app` null, moves the issue to `status:todo`; marker comments of an owner or an agent login still never count; `declined` unchanged), `apply.mjs` (passes `viaApp` from the comment payload), and `staleComment(login, owners)` (mentions the author and the owners). The docs drop "set `status:todo` by hand": the owner just comments.
- Known-bad state avoided: an owner-awaited `needs-info` that only moves on a label click and is stale-closed with no mention of the owner. KEEP: the three routes, the `Reproduction:` part, the pins.

## Review Triage Log

### 2026-11-02 -- Review pass (quick, in this session: the worker has no subagent tool and the caller asked for an in-session review)
- verdicts: 4 findings -- high 0, medium 1, low 2, false 1, maybe-false 0 (the medium was deferred first, then patched on the owner's decision)
- findings:
  - `[medium]` `[patch]` Owner-route `needs-info`: the owner's comment did not move the issue and the stale close mentioned only the author -- first deferred, then patched on the owner's decision (Plan Change Log): `onComment`, `apply.mjs`, `staleComment`, docs, tests.
  - `[low]` `[patch]` `triage.md` step 6.1 said `Waiting for` is the author for needs info only, and `comments.md` said needs-info questions are for the reporter only -- patched: both name the owner's live check.
  - `[low]` `[patch]` The triage rules still said live checks go "into the draft ticket's verify line" and let a long reproduction be decided "with what you have" -- patched: a bug that needs more time is not reproduced and never `triaged`.
  - `[false]` `[reject]` "The implementation run may run untrusted test code from a comment" -- the comment is the agent's own (identity.md definition of yours), the rule tells the run to read it first and rewrite it if it does more than test the plugin offline; the issue text itself is never run.
- Mutation checks: 17 doc pins, each with one mutation (a phrase removed or inverted); the suite applies each and requires the pin to fail (a stale mutation throws). All killed. Code mutations of the owner reply, each applied alone to `transitions.mjs`/`apply.mjs`, tests run, reverted: owner path off; owner path without the app check; any non-app comment counts; marker exclusion removed; stale comment without owners; `viaApp` never passed. All killed by `test/issue-flow.test.ts`.

## Verification

**Commands:**
- `npx vitest run test/agent-flow-docs.test.ts test/issue-flow.test.ts` -- all pass
- `npm run ci` -- passes

## Auto Run Result

Status: built.

Summary: triage accepts a bug only when it reproduced it on current `main`; the rules, steps 3 and 5, the comment fields (`Reproduction:`), the draft ticket's verify line, the three not-reproduced routes, the carried-over re-run, the implementation run's handling of the test, and the user and design docs say so.

Files changed: `docs/agents/triage.md` (rules, steps 2 to 5, fields), `docs/agents/comments.md` (rule, accepted example with a Reproduction part, owner-check example), `docs/agents/implement.md` (rule "Reproduction test"), `docs/issues.md` (triaged and needs-info rows, triage and implementation steps), `epic-distribution/issue-flow.md` (states, transitions, triage and implementation text), `MEMORY.md`, `test/agent-flow-docs.test.ts` (17 pins with mutation checks), `scripts/issue-flow/transitions.mjs` and `apply.mjs` (owner reply on `needs-info`, `staleComment` mentions owners), `test/issue-flow.test.ts`.

Review: quick, run in this session (no subagent tool in this worker). 4 findings: 3 patched (the medium one on the owner's decision), 1 rejected as false. Nothing deferred.

Verification: `npx vitest run test/agent-flow-docs.test.ts test/issue-flow.test.ts` and `npm run ci` (plan gate, typecheck, 1701 unit tests, build, package allowlist, pack, install smoke): all passed. Live Cursor check: not run (docs-only change; nothing live applies).

Residual risks: not run live: the next bug the routine triages should show a `Reproduction:` part; the routine's prompt is unchanged. The owner reply is not verified live: an owner's real comment on a `needs-info` issue should move it to `todo` after the merge.
