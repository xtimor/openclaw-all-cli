---
title: 'Context usage tile moves down between turns'
type: 'bugfix'
ticket: '28'
created: '2026-11-19'
status: blocked
baseline_revision: '4a9fed1fd1cd8e85f3ce663bc9a7584f8e129a45'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
blocked_at: "2026-11-19"
blocked_reason: "no subagents: step-04's Quick review lens requires launching a context-free reviewer subagent, and this session has no tool to spawn one (only messaging of already-existing agents is available; confirmed via ToolSearch for Task/Agent/Subagent-spawning tools)."
---

<intent-contract>

## Intent

**Problem:** `boundTurnUsage` only drops a turn's `total` when it exceeds the session's context
ceiling; a turn with fewer tool round trips than the previous one still passes its (correctly
smaller, but non-monotonic) sum through, so the context tile falls even though the conversation
only grew.

**Approach:** Give `boundTurnUsage` an optional third argument, the highest `total` already
accepted for this session. When the new turn's `total` is below it, mark `contextUnknown` instead
of reporting the lower number (same transformation the above-ceiling guard already uses). The
2-argument call sites and existing tests are unaffected (no previous total, no new behavior); in
`execute.ts`, track the live process's highest accepted total on its `LiveEntry` (reset when a new
entry opens) and pass it on each call.

</intent-contract>

## Implementation Notes

Oneshot: a pure, backward-compatible parameter addition to one function plus one new field on the
per-process `LiveEntry`, confined to `src/core/usage.ts` and `src/core/execute.ts` (+
`src/core/live-entry.ts` for the field). No existing `boundTurnUsage` call passes a third argument
today, so every existing test keeps its current behavior untouched; only the ticket's own
regression test (merged into `src/core/usage.test.ts`) exercises the new parameter, plus one new
end-to-end test in `src/core/execute.test.ts` for the `LiveEntry` wiring. `docs/providers/cursor.md`
("The context tile" paragraph and the matching "Known limits" bullet) and `CHANGELOG.md` are
updated in the same change (user-visible behavior). `MEMORY.md` gets a short entry recording the
design choice (why per-call state on `LiveEntry`, not a session-interface field).

**Done:**
- `src/core/usage.ts` -- `boundTurnUsage(usage, ceiling, previousTotal?)`: a reading below the
  ceiling but lower than `previousTotal` is now withheld (`contextUnknown`) the same way an
  above-ceiling one is; omitted, behavior is identical to before.
- `src/core/live-entry.ts` -- new optional `LiveEntry.highestAcceptedContextTotal`, the process's
  own running high; unset until the first accepted total, reset by a fresh entry (process restart).
- `src/core/execute.ts` -- the result-record usage call now reads and updates
  `active.highestAcceptedContextTotal` around the `boundTurnUsage` call.
- `src/core/usage.test.ts` -- merged the ticket's reproduction test (same name, as the Notes line
  asks), adapted to the chosen fix (per-call state is explicit, not implicit): turn 2 is called with
  turn 1's accepted total as `previousTotal`, so the originally-contradictory assertions
  (`contextUnknown` undefined for both, yet turn 2's raw total not lower than turn 1's) become
  consistent with what the fix actually does. Added three more direct `boundTurnUsage` cases
  (no `previousTotal`; at/above it; below it). No existing test needed to change: every existing
  call site passes only 2 arguments.
- `src/core/execute.test.ts` -- one new end-to-end test: a tool-heavy turn then a plain follow-up
  turn on the same warm process (`liveSession` + `useResume`), confirming the `LiveEntry` wiring,
  not just the unit-level function.
- `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md` updated (see Intent).

**Why not a 4th option (always withhold, or track history on `CliSession`):** `test/host-contract.test.ts`
("reads the prompt buckets as the context size, and none from usage marked unavailable") pins that a
single plausible in-ceiling turn (`plain`, total 15 314) must still read as a real context size —
withholding every in-ceiling reading would silently break that contract and the context tile would
never show a number. Threading history through the public `CliSession` port would mean touching the
interface and every implementer (the real `AcpSession`, every fake test session) for bookkeeping
that belongs to the execute layer, which already keeps this kind of per-process state on `LiveEntry`
(`freshChat`, `structuredSent`, ...).

## Verification

**Commands:**
- `npx vitest run src/core/usage.test.ts -t "boundTurnUsage lets the reported total fall between turns within the ceiling, with nothing marking it as a per-turn sum"` -- expected: passes (confirmed it fails on the pre-fix code, via `git stash` of the fix files, with `AssertionError: expected undefined to be true`).
- `npm test` -- expected: all pass. Result: 2035 passed, 72 skipped (skipped = live tests, no `OPENCLAW_ALL_CLI_LIVE`).
- `npm run typecheck` -- expected: clean. Result: clean.
- `npm run ci` -- expected: `All checks passed.` (isolated Node 24 + OpenClaw setup, npm ci, plan gate, typecheck, unit tests, build, package-contents test, `npm pack --dry-run`, install smoke check). Result: passed.
- `npm run test:live` -- **not run**: not named by the ticket's Verify line, and this fix is pure turn-usage arithmetic with no live-only path; a real Cursor login exists on this host (`cursor-agent` binary present) but running the full live suite is outside this ticket's scope.

## Auto Run Result

Status: blocked
Blocking condition: no subagents

Implementation is complete and verified; the run halted at step-04 (Review), before the Quick
review lens, which `workflow.md` requires launching as a context-free subagent. This session has
no tool that can spawn a fresh subagent (`ToolSearch` for Task/Agent/Subagent-spawning tools found
none; `ListAgents` shows only pre-existing agents, which `SendMessage` can message but not use as a
context-free reviewer). Per `workflow.md` → Subagents: "Using subagents when instructed is
mandatory. If you cannot, HALT with status `blocked` and blocking condition `no subagents`."

**Summary of implemented change:** `boundTurnUsage` (`src/core/usage.ts`) takes an optional third
argument, the highest turn `total` already accepted for the session; a new reading below it is now
withheld (`contextUnknown`) the same way an above-the-ceiling one already was, so the Control UI's
context-usage tile can no longer fall just because a turn made fewer model requests than the one
before it. Every existing 2-argument call site is unaffected. `execute.ts` tracks the running high
on the per-process `LiveEntry` (new `highestAcceptedContextTotal` field, resets on a process
restart) and threads it into the call.

**Files changed:**
- `src/core/usage.ts` -- `boundTurnUsage` gains the `previousTotal` parameter and the fall-below check.
- `src/core/live-entry.ts` -- new `LiveEntry.highestAcceptedContextTotal` field.
- `src/core/execute.ts` -- reads/updates that field around the `boundTurnUsage` call.
- `src/core/usage.test.ts` -- merged and adapted the ticket's regression test (same test name), plus three direct cases for the new parameter.
- `src/core/execute.test.ts` -- one new end-to-end test for the `LiveEntry` wiring across two warm-process turns.
- `docs/providers/cursor.md` -- "The context tile" paragraph and the matching "Known limits" bullet updated.
- `CHANGELOG.md` -- one line under `## Unreleased`.
- `MEMORY.md` -- one entry under the issue #40 line, recording the design choice and why it isn't on `CliSession`.
- `_bmad-output/backlog/bug-context-usage-tile-moves-down-between-turns-plan.md` -- this plan (new).

**Review findings breakdown:** No review lens ran (see Blocking condition). No findings to report.

**Follow-up review recommendation:** Not computed (review did not run).

**Verification performed:** see `## Verification` above — the ticket's named regression test (confirmed it fails on the pre-fix code and passes on the fix), full `npm test` (2035 passed, 72 skipped live-only), `npm run typecheck` (clean), and the full `npm run ci` (isolated Node 24 + OpenClaw setup, plan gate, typecheck, unit tests, build, package-contents test, pack dry run, install smoke check — all passed). `npm run test:live` was not run (not required by the ticket's Verify line; no live-only path in this change).

**Residual risks:** None known from implementation or the checks above. The code change itself has not had an independent review pass (Quick lens), so a second set of eyes before merge is advisable once a subagent-capable session is available.

