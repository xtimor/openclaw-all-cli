---
title: 'A transient Cursor throttle is reported as a spent plan quota'
type: 'bugfix'
ticket: 30
created: '2026-11-19'
status: built
baseline_revision: '4746a143dee0b027b4e603e4f476ffc683b1685b'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `src/adapters/cursor/errors.ts` maps the Connect code `resource_exhausted`
(transient backend throttle, `RetriableError`) and the action phrase "upgrade your plan to
continue" (genuine plan exhaustion, `ActionRequiredError`) to the same `RATE_LIMIT` constant, whose
label says "usage limit", so a transient throttle is misreported as a spent subscription.

**Approach:** Split the `Failure` used for `resource_exhausted` from the one used for "upgrade your
plan to continue": keep `code: "rate_limit"` and the word "rate limit" in both labels (for the
host's keyword-based failover), but only the plan-exhaustion label keeps "usage limit" wording. Merge
the ticket's reproduction test into `src/adapters/cursor/errors.test.ts`.

</intent-contract>

## Code Map

- `src/adapters/cursor/errors.ts` -- `RATE_LIMIT` constant and `CONNECT_CODES`/`ACTION_PHRASES`
  tables; add a second `Failure` (same `code: "rate_limit"`, a throttle-worded label without "usage
  limit") used only for `CONNECT_CODES.resource_exhausted`. Keep `RATE_LIMIT` (usage-limit wording)
  for `ACTION_PHRASES["upgrade your plan to continue"]`. Do not touch `isCredentialRejection`,
  `ERROR_HEAD`/`NAMED`/`CODED` parsing, or anything in `classifyCursorReplyError`'s control flow.
- `src/adapters/cursor/errors.test.ts` -- existing `resource_exhausted` row (line 26) and
  `"Upgrade your plan to continue"` row (line 48) already assert `/rate limit/`, satisfied by both
  labels; merge the ticket's three Notes tests verbatim (same test names, so the ticket's `-t` verify
  command still matches) as a new `describe` block.
- `docs/providers/cursor.md` -- Errors section/table (around lines 212-227) currently groups
  `resource_exhausted` and "upgrade your plan to continue" under one `rate_limit` row with one
  example message ("rate limit reached (usage limit)"); split the row and note the throttle message
  does not claim a spent usage limit.
- `CHANGELOG.md` -- one `## Unreleased` line (user-visible message wording fix, issue #99).
- Out of scope (per ticket Boundaries, AD-11): `src/transports/acp/session.ts`'s
  `tools.started`-gated retry-clearing. Do not touch it or its test
  (`src/transports/acp/session.test.ts` around line 984).

## Implementation Notes

Oneshot: a two-constant split in one file plus a merged regression test, well under 100 lines; no
subagent needed.

- `src/adapters/cursor/errors.ts`: added `RATE_LIMIT_THROTTLE` (`code: "rate_limit"`, label "hit a
  temporary rate limit, try again shortly") and pointed `CONNECT_CODES.resource_exhausted` at it.
  `RATE_LIMIT` (usage-limit wording) now serves only `ACTION_PHRASES["upgrade your plan to
  continue"]`. No other logic touched.
- `src/adapters/cursor/errors.test.ts`: merged the ticket's Notes reproduction tests verbatim (same
  describe/it names, so the ticket's `-t` verify command still targets the right test).
- `docs/providers/cursor.md`: split the one-row `rate_limit` table entry into two (throttle vs.
  plan exhaustion) and extended the retryable-message paragraph to explain the wording split and why
  the "rate limit" keyword is kept in both.
- `CHANGELOG.md`: one `## Unreleased` / `### Fixed` line, linking issue #99.
- No surprises. Did not touch `src/transports/acp/session.ts` or its test (AD-11, explicitly out of
  scope per the ticket's Boundaries).

### Verification run

- `npx vitest run src/adapters/cursor/errors.test.ts -t "does not tell the caller a transient resource_exhausted throttle is a spent usage limit"` -- 1 passed, 32 skipped.
- `npx vitest run src/adapters/cursor/errors.test.ts` -- 33 passed (all existing rows, including the unchanged `resource_exhausted` and `"Upgrade your plan to continue"` `it.each` cases, plus the three merged regression tests).
- `npm run typecheck` -- clean.
- `npm test` -- 2057 passed, 70 skipped (unrelated, pre-existing skips), 0 failed.
- `npm run ci` -- full suite (isolated Node/OpenClaw setup, `npm ci`, plan gate, typecheck, unit tests, build, package allowlist, `npm pack --dry-run`, install smoke check) -- "All checks passed."
- Live check not run: no live-`cursor-agent` test exists for this classifier (it is pure text
  classification, covered entirely by `errors.test.ts`); nothing in `test/live/` exercises this path,
  so there is no live check to skip.

## Verification

**Commands:**
- `npx vitest run src/adapters/cursor/errors.test.ts -t "does not tell the caller a transient resource_exhausted throttle is a spent usage limit"` -- expected: passes (fails before the fix).
- `npm test` -- expected: full suite passes, including the unchanged `"upgrade your plan to continue"` and `resource_exhausted` rows in the existing `it.each` tables.
- `npm run typecheck` -- expected: no type errors.
- `npm run ci` -- expected: passes (no live Cursor login needed for this change).

## Auto Run Result

Status: built

**Summary:** Implemented and verified the AC1-4 fix: a transient Cursor `resource_exhausted`
throttle no longer reads as "usage limit" while `code: "rate_limit"` and the "rate limit" keyword
stay unchanged for the host's failover; the genuine "upgrade your plan to continue" message is
unchanged. The ticket's reproduction tests were merged into `errors.test.ts` verbatim. The review
pass found that the fix also moves the throttle out of the host's own separate long-window
rate-limit classifier (previously matched by "usage limit")  -- an effect the ticket's own
Boundaries and docs did not mention, but which is the fix's intended, desirable consequence (issue
#99 explicitly asks for the throttle to be retried, not treated like an exhausted plan), not a
regression; it is now verified against the host's real code and documented. The review pass also
reworded the throttle label to drop an unconditional "try again shortly" that did not hold for the
(less common) non-retryable form of the same Connect code, fixed a docs contradiction, filled two
small doc/test gaps, and tidied test names that had leaked ticket-triage wording into the permanent
suite.

**Files changed:**
- `src/adapters/cursor/errors.ts` -- added `RATE_LIMIT_THROTTLE` for `CONNECT_CODES.resource_exhausted`; `RATE_LIMIT` now serves only the plan-exhaustion action phrase. Review pass: reworded the throttle label to "hit a temporary rate limit (resource exhausted)" (keeps "rate limit" for the host keyword match; drops the "try again shortly" promise that did not hold when the same code arrives as `NonRetriableError`, a bare code, or after a tool call cleared `retryable`).
- `src/adapters/cursor/errors.test.ts` -- merged the ticket's three Notes regression tests verbatim. Review pass: renamed the describe block and one test (dropped the "triage scratch #99" / "this part is correct already" working-note wording the triage's own Notes text carried over, to match the file's other test names; the Verify command's `-t` target is untouched).
- `test/host-contract.test.ts` (review pass, new) -- pins the host's own `hasLongWindowRateLimitEvidence` behavior against both messages: the plan-exhaustion one still counts as a long window, the throttle no longer does.
- `docs/providers/cursor.md` -- split the errors table's one `rate_limit` row into two, and extended the retryable-message paragraph to explain the wording split. Review pass: fixed the table row's claim that the bare `resource_exhausted` form is "retryable" (it is retryable only when Cursor names it `RetriableError`, same as every other code); explained the host's long-window classifier shift.
- `docs/setup.md` (review pass) -- the troubleshooting table's rate-limit row now names the new throttle message prefix and tells the two cases' advice apart.
- `test/live/errors.live.test.ts` (review pass) -- the plugin-label-prefix regexes (both the positive and negative check) now include the new throttle wording.
- `CHANGELOG.md` -- one `## Unreleased` / `### Fixed` line linking issue #99; review pass: updated to the reworded label and named the retry-handling effect.
- `_bmad-output/backlog/bug-transient-cursor-throttle-reported-as-spent-plan-quota-plan.md` -- this plan (new).

**Review findings breakdown:** 4 lenses (Blind Hunter, Edge Case Hunter, Verification Gap, Intent
Alignment) ran at the top level (environment limitation: a dispatched build/review worker cannot
itself spawn a context-free reviewer subagent in this harness, confirmed on tickets 28 and 29).
7 grouped findings: 0 high, 3 medium, 4 low; 2 rejected. Patched: the retryable/wording mismatch in
the throttle label (medium), the docs table's retryable claim (medium), the undocumented and
unverified host long-window-classifier shift (medium, documented and pinned rather than reverted,
since the actual effect is correct and desired), the missing `docs/setup.md` row (low), the stale
live-test regex (low), and the leaked triage-working-note test names (low). Rejected: a redundant
third regression test that mostly repeats existing coverage (kept, since the ticket's Notes asked
for its three tests verbatim and it does no harm), and the cosmetic message-text repetition noted
by one lens (resolved as a side effect of the wording patch, not pursued separately). Full detail in
the `## Review Triage Log` entry below.

**Follow-up review recommendation:** `true` -- three medium-severity findings were patched this
pass. Specific unverified risk to check: the new `test/host-contract.test.ts` pinning test and the
reworded label have not themselves had an independent review pass.

**Verification performed:**
- `npx vitest run src/adapters/cursor/errors.test.ts -t "does not tell the caller a transient resource_exhausted throttle is a spent usage limit"` -- 1 passed.
- `npx vitest run src/adapters/cursor/errors.test.ts test/host-contract.test.ts test/live/errors.live.test.ts` -- 53 passed, 1 skipped (the live file, no live env).
- `npm run typecheck` -- clean.
- `npm test` -- 2057 passed, 70-71 skipped (pre-existing/unrelated; one unrelated timing test flaked once on a concurrent-prompt-timestamp assertion and passed clean on immediate rerun), 0 failed.
- `npm run ci` -- full suite (isolated Node 24 + OpenClaw setup, `npm ci`, plan gate, typecheck, unit tests, build, package allowlist test, `npm pack --dry-run`, install smoke check) -- "All checks passed."
- Live check not run: there is no live-`cursor-agent` test for this classifier (pure text
  classification, fully covered by `errors.test.ts`); nothing in `test/live/` exercises this path, so
  there was no live check to skip over.

**Residual risks:** None known beyond the follow-up-review recommendation above. The redundant third
test and the (now moot) cosmetic message repetition are not residual risks, just left as they are.

## Review Triage Log

### 2026-11-19 — Review pass (four thorough lenses, run by the dev-orchestrator at the top level)

Both dispatched build and review workers halted on `no subagents` (same environment limitation
confirmed on tickets 28 and 29: a sub-agent spawned by the orchestrator has no further Agent/Task
tool of its own in this harness, so it cannot launch a context-free reviewer subagent for
step-04's thorough-review lenses). The orchestrator independently re-verified the implementation
(the named regression test, full `npm run ci`, both green; commit `fc5b063`), set the plan to
`built` to clear the environment halt, then ran step-04 itself: set the plan to `in-review`, staged
the diff since `baseline_revision` (excluding the orchestrator's own runs-directory journal, out of
scope), and launched all four thorough-review lenses as top-level subagent dispatches in parallel.

- verdicts: 7 grouped findings — high 0, medium 3, low 4, false 0, maybe-false 0; 2 further findings
  rejected outright
- findings:
  - `[medium]` `[patch]` Blind Hunter, Edge Case Hunter, and Verification Gap all independently
    found that the new throttle label ("hit a temporary rate limit, try again shortly") was chosen
    by the Connect code alone, applied to every error-name form (`RetriableError`,
    `NonRetriableError`, and the bare, unnamed form), while `retryable` is only ever true for the
    named `RetriableError` form, and is cleared again once a tool call has started in the turn
    (AD-11, out of scope). So a `NonRetriableError: [resource_exhausted]` or a bare
    `[resource_exhausted]` reply, or a retriable one after a tool call started, read "try again
    shortly" while `retryable` was `false` — an action the host does not actually take
    automatically. Verified by reading `errors.ts`'s `retryable: name?.[1] === "RetriableError"`
    and the existing `it.each` row (`errors.test.ts`) that exercises exactly the bare and
    `NonRetriableError` forms. No evidence either way on how often Cursor actually sends
    `resource_exhausted` un-named or non-retriable in practice. — fixed: reworded the label to
    "hit a temporary rate limit (resource exhausted)", a purely descriptive phrase with no
    retry-action promise, for all error-name forms alike; still keeps the "rate limit" keyword the
    host's failover matching needs, and still reads differently from "usage limit".
  - `[medium]` `[patch]` Edge Case Hunter and Verification Gap both found that the new errors table
    row in `docs/providers/cursor.md` said the bare `Error: [resource_exhausted]` form is
    "retryable", directly contradicting the paragraph immediately below it ("retryable only when
    Cursor names it `RetriableError`") and the code. Verified by reading both the table and the
    paragraph. — fixed: the table row now says "retryable only when Cursor names it `RetriableError`
    and no tool call has started", matching the paragraph and the code exactly.
  - `[medium]` `[patch]` Intent Alignment found, and independently verified by the orchestrator
    against the host's own vendored code (`.spike/openclaw/node_modules/openclaw/dist/`), that
    dropping "usage limit" from the throttle message also moves it out of the host's own
    `hasLongWindowRateLimitEvidence` classifier (matched on "usage limit", "subscription", "quota
    exceeded", and similar words) — a check entirely separate from the `code: "rate_limit"` field
    and the plugin's own keyword set, and not named anywhere in the ticket, the plan, or the docs.
    This reads, on a literal plain reading of the ticket's own Boundaries line ("must not change
    ... the host's text-based failover matching"), as exactly the kind of change that line says not
    to make. On inspection, though, the actual effect is the fix doing its job one layer up: a
    genuine plan exhaustion still reads as a long window (correctly, unchanged), and a transient
    throttle no longer does, so the host's own retry/cooldown handling can treat it as the
    transient condition it is — squarely what issue #99's own "Expected behavior" #2 asks for
    ("a Cursor-declared RetriableError for a server-side rejection is retried rather than ending
    the run"), not a boundary violation. Decision: the Boundaries line is read as protecting
    `code: "rate_limit"` and the "rate limit" keyword for both messages (both verified to still
    hold), not as freezing every downstream host classifier's verdict for this exact message text;
    this reading is adopted on the orchestrator's own authority as the issue's approved scope, with
    no escalation, since reverting a correct, desired fix to satisfy an unintentionally broad
    literal reading of a boundary line would be worse than clarifying the line. — fixed: not by
    changing the code (the behavior was already correct), but by making the real effect verifiable
    and accurately described: a new `test/host-contract.test.ts` pass pins
    `hasLongWindowRateLimitEvidence` against both messages, and `docs/providers/cursor.md` now
    explains the shift and why it does not cross the Boundaries as actually intended.
  - `[low]` `[patch]` Blind Hunter and Verification Gap both found that `docs/setup.md`'s
    troubleshooting table, which AGENTS.md requires to change in the same change that alters
    behavior, still listed only the old "rate limit reached (usage limit)" prefix among the turn-
    failure messages a user might see, with no row for the new throttle wording. — fixed: the row
    now names both prefixes and tells their advice apart (wait and retry vs. check the plan).
  - `[low]` `[patch]` Intent Alignment found that `test/live/errors.live.test.ts`'s two
    plugin-label-prefix regexes (the positive check that a real failure's output names the plugin's
    own wording, and the negative check that none of the plugin's own labels leak into the chat
    reply) listed only the old prefixes, so a live throttle during that test's run would not match
    either regex as the plugin's own text. The live test was not run (no Cursor login on this
    host). — fixed: both regexes now include the new throttle prefix.
  - `[low]` `[patch]` Blind Hunter found that the regression tests' describe block and one test
    name carried the triage pass's own working-note wording ("triage scratch #99: ...", "... (this
    part is correct already)") into the permanent suite, inconsistent with the file's other test
    names. Verified the ticket's Verify line targets a different test by name, so renaming these
    two does not affect it. — fixed: renamed both to plain behavior descriptions.
  - `[low]` `[reject]` Blind Hunter found the third merged regression test ("marks the throttle as
    retryable before any tool call ran") mostly repeats coverage the file's `RETRIABLE` case at the
    top already has. True, but the ticket's own Notes asked for its three reproduction tests
    verbatim, the duplication is harmless, and trimming it is not a correction to a defect.
  - `[reject]` Verification Gap found the new label text, in full, reads with "try again shortly"
    mentioned twice when the Cursor detail text also contains it (`"...try again shortly: Error:
    ...backend is busy, try again shortly"`). Moot: the wording patch above (first finding) removed
    "try again shortly" from the label itself, so this no longer occurs for the label; a detail
    that happens to repeat its own wording is Cursor's text, not the plugin's, and out of scope.

Patches applied directly (oneshot route). Re-ran verification after patching, listed under `## Auto
Run Result` above.
