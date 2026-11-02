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
deferred:
  - summary: >-
      A `needs-info` that waits for the owner is only moved by the owner setting `status:todo`, and its 30-day stale close mentions the author only.
    evidence: |-
      The state automation counts a comment as a reply only from the issue's author (`onComment` in `scripts/issue-flow/transitions.mjs`), and `staleComment(login)` mentions the author. The ticket asks for `needs-info` with `Waiting for: @owner`, so the docs say what the owner does; changing the automation is a protected-file change (`scripts/`) outside this ticket.
    location: >-
      scripts/issue-flow/transitions.mjs onComment, staleComment
    severity: medium
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
- Owner route stays `needs-info` as the ticket says; the docs tell the owner to set `status:todo` after commenting (the automation moves only on the author's reply). Left as a deferred finding for the owner.
- No `CHANGELOG.md` line: agent-flow change only (docs/release.md, Changelog).
- Pins are predicates with one mutation each; the test applies the mutation and requires the pin to fail, and throws if a mutation no longer matches (stale).

Files touched: `docs/agents/{triage,comments,implement}.md`, `docs/issues.md`, `epic-distribution/issue-flow.md`, `MEMORY.md`, `test/agent-flow-docs.test.ts`, this plan.

## Plan Change Log

## Review Triage Log

### 2026-11-02 -- Review pass (quick, in this session: the worker has no subagent tool and the caller asked for an in-session review)
- verdicts: 4 findings -- high 0, medium 1, low 2, false 1, maybe-false 0
- findings:
  - `[medium]` `[defer]` Owner-route `needs-info`: the owner's comment does not move the issue and the stale close mentions only the author (see `deferred`). The docs state the owner's step; an automation change is for the owner to decide.
  - `[low]` `[patch]` `triage.md` step 6.1 said `Waiting for` is the author for needs info only, and `comments.md` said needs-info questions are for the reporter only -- patched: both name the owner's live check.
  - `[low]` `[patch]` The triage rules still said live checks go "into the draft ticket's verify line" and let a long reproduction be decided "with what you have" -- patched: a bug that needs more time is not reproduced and never `triaged`.
  - `[false]` `[reject]` "The implementation run may run untrusted test code from a comment" -- the comment is the agent's own (identity.md definition of yours), the rule tells the run to read it first and rewrite it if it does more than test the plugin offline; the issue text itself is never run.
- Mutation checks: 16 pins, each with one mutation (a phrase removed or inverted); the suite applies each and requires the pin to fail (a stale mutation throws). All 16 killed.

## Verification

**Commands:**
- `npx vitest run test/agent-flow-docs.test.ts` -- all pass
- `npm run ci` -- passes

## Auto Run Result

Status: built.

Summary: triage accepts a bug only when it reproduced it on current `main`; the rules, steps 3 and 5, the comment fields (`Reproduction:`), the draft ticket's verify line, the three not-reproduced routes, the carried-over re-run, the implementation run's handling of the test, and the user and design docs say so.

Files changed: `docs/agents/triage.md` (rules, steps 2 to 5, fields), `docs/agents/comments.md` (rule, accepted example with a Reproduction part, owner-check example), `docs/agents/implement.md` (rule "Reproduction test"), `docs/issues.md` (triaged and needs-info rows, triage and implementation steps), `epic-distribution/issue-flow.md` (states, transitions, triage and implementation text), `MEMORY.md`, `test/agent-flow-docs.test.ts` (16 pins with mutation checks).

Review: quick, run in this session (no subagent tool in this worker). 4 findings: 2 patched, 1 deferred (medium), 1 rejected as false.

Verification: `npx vitest run test/agent-flow-docs.test.ts` (56 tests) and `npm run ci` (plan gate, typecheck, unit tests, build, package allowlist, pack, install smoke): all passed. Live Cursor check: not run (docs-only change; nothing live applies).

Residual risks: not run live: the next bug the routine triages should show a `Reproduction:` part; the routine's prompt is unchanged. The owner-route `needs-info` needs the owner's `status:todo` click (deferred finding).
