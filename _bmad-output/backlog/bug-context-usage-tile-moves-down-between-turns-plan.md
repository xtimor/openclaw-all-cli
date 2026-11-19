---
title: 'Context usage tile moves down between turns'
type: 'bugfix'
ticket: '28'
created: '2026-11-19'
status: built
baseline_revision: '4a9fed1fd1cd8e85f3ce663bc9a7584f8e129a45'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      With no known context ceiling, boundTurnUsage runs neither the issue #40 nor the issue #97
      guard at all.
    evidence: |-
      `boundTurnUsage` returns at its first line when `ceiling === undefined`. Pre-existing (true
      for issue #40's original fix too), not newly introduced by ticket 28. Unverified: how often a
      session actually runs with no known ceiling in practice.
    location: >-
      src/core/usage.ts:19 (boundTurnUsage)
    severity: low
  - summary: >-
      The remembered high can pin the context tile to an inflated, tool-heavy-turn reading for the
      rest of a warm process, withholding a later turn's more accurate (lower) reading until restart.
    evidence: |-
      Deliberate tradeoff from the plan's "Why not a 4th option" section (monotonicity over
      per-turn accuracy; test/host-contract.test.ts pins that a single plausible turn must still
      read as a real context size), already described in docs/providers/cursor.md. Unverified: how
      long a warm process typically stays alive after a tool-heavy turn in practice.
    location: >-
      src/core/live-entry.ts (highestAcceptedContextReading), src/core/execute.ts
    severity: low
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
- `npx vitest run src/core/usage.test.ts -t "boundTurnUsage lets the reported contextReading fall between turns within the ceiling, with nothing marking it as a per-turn sum"` -- expected: passes (confirmed it fails on the pre-fix code, via `git stash` of the fix files, with `AssertionError: expected undefined to be true`; renamed by the review pass from "...reported total fall..." to "...reported contextReading fall..." to match the corrected comparison).
- `npm test` -- expected: all pass. Result: 2041 passed, 71 skipped (skipped = live tests, no `OPENCLAW_ALL_CLI_LIVE`; counts after the review pass's two added tests).
- `npm run typecheck` -- expected: clean. Result: clean.
- `npm run ci` -- expected: `All checks passed.` (isolated Node 24 + OpenClaw setup, npm ci, plan gate, typecheck, unit tests, build, package-contents test, `npm pack --dry-run`, install smoke check). Result: passed.
- `npm run test:live` -- **not run**: not named by the ticket's Verify line, and this fix is pure turn-usage arithmetic with no live-only path; a real Cursor login exists on this host (`cursor-agent` binary present) but running the full live suite is outside this ticket's scope.

## Auto Run Result

Status: built

**Summary of implemented change:** `boundTurnUsage` (`src/core/usage.ts`) takes an optional third
argument, the highest `contextReading` (`input + cacheRead + cacheWrite`, the number OpenClaw's
tile actually shows — not raw `total`, which also carries `output`) already accepted for the
session; a new reading below it is now withheld (`contextUnknown`) the same way an above-the-ceiling
one already was, so the Control UI's context-usage tile can no longer fall just because a turn made
fewer model requests than the one before it. Every existing 2-argument call site is unaffected.
`execute.ts` tracks the running high on the per-process `LiveEntry` (new
`highestAcceptedContextReading` field, resets on a process restart) and threads it into the call.
The review pass found the first build's comparison used raw `total` instead of `contextReading`,
which does not actually guarantee the tile's own displayed number is monotonic; patched.

**Files changed:**
- `src/core/usage.ts` -- new exported `contextReading()` helper; `boundTurnUsage` gains the
  `previousReading` parameter (compared against `contextReading`, not raw `total`) and the
  fall-below check.
- `src/core/live-entry.ts` -- new `LiveEntry.highestAcceptedContextReading` field.
- `src/core/execute.ts` -- reads/updates that field (via `contextReading`) around the
  `boundTurnUsage` call.
- `src/core/usage.test.ts` -- merged and adapted the ticket's regression test, direct cases for the
  new parameter and for `contextReading`, and a dedicated case for the review's finding (output
  changing independently of the context reading).
- `src/core/execute.test.ts` -- one end-to-end test for the `LiveEntry` wiring across two
  warm-process turns, plus two more from the review pass (fresh process does not inherit the high;
  a withheld turn does not raise it).
- `docs/providers/cursor.md` -- "The context tile" paragraph and the matching "Known limits"
  bullet updated (review pass: clarified the remembered high is the `contextReading`, not `total`).
- `CHANGELOG.md` -- one line under `## Unreleased` (review pass: corrected "per the chat" to "per
  warm process", matching the actual per-process reset).
- `MEMORY.md` -- one entry under the issue #40 line, recording the design choice, the review's
  correction, and the deferred no-known-ceiling gap.
- `_bmad-output/backlog/bug-context-usage-tile-moves-down-between-turns-plan.md` -- this plan (new).

**Review findings breakdown:** 5 findings from the Quick lens (1 high, 1 medium, 3 low). Patched: 3
(the high-severity `total`-vs-`contextReading` mismatch; the `CHANGELOG.md` wording; the missing
reset/withheld-high test coverage). Deferred: 2 (no-known-ceiling gap; the inflated-high tradeoff —
both pre-existing to the design, not caused by sloppy implementation). None rejected. Full detail
in the `## Review Triage Log` entry below.

**Follow-up review recommendation:** `true` — the high-severity finding was patched this pass, so by
policy a second pass is warranted. Specific unverified risk to check: that the corrected
`contextReading`-based comparison (replacing the original `total`-based one) is itself free of a
similar mismatch, and that the two new reset/withheld-high tests in `execute.test.ts` actually
exercise distinct `LiveEntry` instances as intended.

**Verification performed:** see `## Verification` above, re-run after patching: the ticket's named
regression test passes (renamed to match `contextReading` wording); `npx vitest run
src/core/usage.test.ts src/core/execute.test.ts` -- 191 passed; full `npm test` -- 2041 passed, 71
skipped (live-only); `npm run typecheck` -- clean; full `npm run ci` -- `All checks passed.` (one
failure surfaced mid-patch and was fixed: `test/import-boundary.test.ts`'s AD-2 check refused a
`docs/providers/cursor.md` file reference inside a `src/core/` doc comment as naming a CLI by name;
reworded to drop it). `npm run test:live` was not run (not required by the ticket's Verify line; no
live-only path in this change; a real Cursor login exists on this host but running the full live
suite is outside this ticket's scope).

**Residual risks:** The two deferred items above (both low, both pre-existing tradeoffs of the
design rather than new defects). No other residual risk known from implementation, the review pass,
or the checks above.

## Review Triage Log

### 2026-11-19 — Follow-up review pass (halted)

Status: blocked
Blocking condition: no subagents

The orchestrator dispatched a follow-up review on the `built` plan (`ticket 28`, quick). Step-01
routed the `built` plan to step-04 as a follow-up pass (`review_loop_iteration` 0). Step-04 calls
for the Quick lens to run as a context-free reviewer subagent. Again, this session has no tool
that can spawn one: `ToolSearch` finds only `SendMessage` and `TaskStop`, and no Agent or Task
tool. As `workflow.md` → Subagents requires, the run halted before it staged the diff or launched
any lens. `lenses_ran` stays empty. There are no findings, no patches, and no deferred items, and
no code changed. `followup_review_recommended` is unchanged (`false`, not computed). The
implementation commit is still `0fac6c5f97057a343e1e8e678070ff2468f11f30`, and it has still not
had an independent review lens pass.

### 2026-11-19 — Review pass (run by the dev-orchestrator at the top level)

Both dispatched build/review workers halted on `no subagents`: a sub-agent spawned by the
orchestrator has no further Agent/Task tool of its own in this harness, so it cannot launch a
"context-free reviewer subagent" for step-04's Quick lens — only the orchestrator's own top-level
session can. The orchestrator independently re-verified the implementation (regression test by
name, full `npm run ci`, both green; commit `0fac6c5`), set the plan to `built` to clear the
environment halt, then ran step-04 itself: set the plan to `in-review`, staged the diff since
`baseline_revision` (excluding the orchestrator's own runs-directory journal, out of scope), and
launched the Quick lens as a single top-level subagent dispatch (the only level that can).

- verdicts: 5 findings — high 1, medium 1, low 3, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` The guard compared raw `total` (which also carries `output`) against the
    previous `total`, not the `input + cacheRead + cacheWrite` reading OpenClaw's tile actually
    shows (`test/host-contract.test.ts`, `deriveSessionTotalTokens`) — so a turn whose `output`
    changed could pass the guard while the tile's own number still fell, defeating AC1 in exactly
    the case it exists for. Verified: turn 1 `{input 1000, cacheRead 90000, output 500, total
    91500}` (tile reading 91 000) then turn 2 `{input 1000, cacheRead 85000, output 6000, total
    92000}` (tile reading 86 000) — `total` rose (91 500 → 92 000, old code accepts it and raises
    the high) while the tile reading fell (91 000 → 86 000). — fixed: added `contextReading()`
    (`input + cacheRead + cacheWrite`, excluding `output`) in `src/core/usage.ts`, compared and
    stored instead of raw `total`; `LiveEntry.highestAcceptedContextTotal` renamed to
    `highestAcceptedContextReading` to match; `execute.ts` updated; new regression test
    `"compares contextReading, not raw total, so a turn whose output changed is judged correctly"`
    in `src/core/usage.test.ts` pins the corrected behavior with these exact numbers; the existing
    `#97` reproduction test and its two `previousTotal`/high-comparison tests updated to use
    `contextReading` values (the old numbers happened to make `total` and `contextReading`
    coincide, which is why they passed either way).
  - `[low]` `[defer]` With no known context ceiling (`contextCeiling` undefined — a model whose
    window is not in the catalog), `boundTurnUsage` returns at its first line and neither the issue
    #40 guard nor the issue #97 guard runs at all, so a reading can still fall in that case. Not
    caused by this change: the same early return, with the same effect, existed before this ticket
    (issue #40's original fix). What would settle it: how often a session actually runs with no
    known ceiling in practice (unverified here).
  - `[low]` `[patch]` `CHANGELOG.md`'s new line said the plugin compares against "the highest one
    already shown for the chat", but the remembered high lives on the per-process `LiveEntry` and
    resets on every process restart (correctly described in `docs/providers/cursor.md`'s own
    wording) — the guarantee holds per warm process, not for the whole chat. — fixed: reworded the
    `CHANGELOG.md` line to say "warm process" and to name the per-restart reset.
  - `[low]` `[defer]` The remembered high can pin the tile to an inflated, tool-heavy-turn reading
    for the rest of a warm process: a later turn's own, more accurate (lower) reading is withheld
    rather than shown, until the process restarts. This is the deliberate tradeoff the plan's own
    "Why not a 4th option" section already names (monotonicity over per-turn accuracy, because
    `test/host-contract.test.ts` pins that a single plausible turn must still read as a real
    context size) — not a defect introduced by a sloppy implementation, and already described in
    `docs/providers/cursor.md` ("a later turn ... can still total less than that" / "resets with
    the process"). What would settle it: how long a warm process typically stays alive after a
    tool-heavy turn in practice (unverified here).
  - `[medium]` `[patch]` No test covered that a fresh `LiveEntry` (a new warm process) does not
    inherit the previous process's high, or that a withheld turn leaves the stored high unchanged
    (both behaviors are claimed in `live-entry.ts`'s doc comment and in the docs, but a future
    change to `execute.ts` could silently break either one without a test catching it). — fixed:
    added `"does not carry a remembered high over to a fresh warm process (issue #97)"` and `"does
    not raise the remembered high from a withheld turn"` to `src/core/execute.test.ts`.

Patches applied directly (oneshot route). Re-ran verification after patching: the ticket's named
regression test (`npx vitest run src/core/usage.test.ts -t "boundTurnUsage lets the reported
contextReading fall between turns within the ceiling, with nothing marking it as a per-turn sum"`)
passes; `npx vitest run src/core/usage.test.ts src/core/execute.test.ts` — 191 passed; full `npm
test` — 2041 passed, 71 skipped (live-only); `npm run typecheck` — clean; full `npm run ci` — `All
checks passed.` (one failure surfaced and was fixed along the way: the first doc-comment wording of
`contextReading` named `docs/providers/cursor.md`, which the AD-2 import-boundary test
(`test/import-boundary.test.ts`) refuses in `src/core/` as naming a CLI by name — reworded to drop
the file reference, keeping the core CLI-agnostic).

`deferred` (2 items, see above): the no-known-ceiling gap, and the inflated-high tradeoff.
