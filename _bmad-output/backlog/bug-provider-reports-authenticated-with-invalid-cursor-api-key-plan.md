---
title: 'Cursor provider reports authenticated with an invalid or unconfirmed CURSOR_API_KEY'
type: 'bugfix'
ticket: '29'
created: '2026-11-19'
status: done
baseline_revision: 'b7fdefb1bc6218b4d58023565b51dcb276aa591e'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      Concurrent cache misses (e.g. the catalog's background probe and prepareSyntheticAuth racing
      at Gateway start) are not de-duplicated: each runs its own checkKey.
    evidence: |-
      Not a correctness bug (each caller still gets a correct answer); a well-made fix (a shared
      in-flight promise per signature) is more than a direct correction. Unverified: how often this
      race happens and what it costs in practice.
    location: >-
      src/adapters/cursor/auth-probe-cache.ts, src/adapters/cursor/index.ts (probeAuth)
    severity: low
  - summary: >-
      A narrow race: invalidate() during an in-flight checkKey call started before the credential
      changed can have that call's later set() restore a valid verdict right after invalidation.
    evidence: |-
      Verified the window exists by reading the code (no generation guard). Bounded by the cache's
      TTLs and the next real turn's own failure; closing it cleanly needs a generation counter.
      Unverified: whether this has been observed, and how often invalidate() and a fresh checkKey
      call actually overlap in practice.
    location: >-
      src/adapters/cursor/auth-probe-cache.ts, src/adapters/cursor/index.ts (probeAuth)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `probeAuth` (`src/adapters/cursor/index.ts`) reports the Cursor provider as
`available` the instant `CURSOR_API_KEY` is non-empty, without ever validating it with the existing
`checkKey` helper, and `parseStatusOutput` reads cursor-agent 2026.11.11's degraded "Logged in
(unable to fetch user details)" line as a working login. Either way a wrong, expired, or revoked
credential keeps advertising the provider as authenticated, so it is selected for runs and as a
fallback, and every real turn then fails far from its true cause (issue #98).

**Approach:** Validate a present `CURSOR_API_KEY` with `checkKey` (`cursor-agent about`) instead of
trusting its presence, caching the verdict briefly (new `auth-probe-cache.ts`, TTL) so the ongoing
probe pays that cost rarely, and dropping the cache the moment a live turn's reply shows the server
rejected the credential. Tighten `parseStatusOutput`'s regex so a degraded "logged in (...)"
admission reads as `unreadable`, not `available`.

</intent-contract>

## Implementation Notes

Oneshot: validation plus a small TTL cache, confined to `src/adapters/cursor/` (`index.ts`,
`errors.ts`, new `auth-probe-cache.ts`), plus the ticket's merged regression test and the two
pre-existing tests it names in `src/adapters/cursor/index.test.ts` (around the old lines 31 and
52-56), updated to the corrected behavior.

**Done:**
- `src/adapters/cursor/auth-probe-cache.ts` (new) -- `createCursorKeyCheckCache` (keyed on
  command + sha256(key), TTL default 5 minutes, never caches an `unknown` verdict) and the module
  singleton `cursorKeyCheckCache`, mirroring the `usageReader`/`quotaReader` per-process-cache style
  already in `index.ts`.
- `src/adapters/cursor/index.ts` -- `probeAuth`: a present `CURSOR_API_KEY` is now read from the
  cache or validated with `checkKey`; `valid` maps to `available`, `invalid` to `missing` (a key the
  CLI positively refuses is "not a working login," the same status an unclear `status` exit uses),
  `unknown` to `unreadable` (and is never cached, so the next probe tries again). `parseStatusOutput`:
  a "logged in"/"signed in"/"authenticated" line immediately followed by a parenthetical
  "(unable/cannot/could not/failed ...)" now returns `unreadable` before the generic match.
  `completeError`: a resolved `auth`/`auth_permanent` code now also invalidates the cache (AC4),
  covering the one-shot "complete" (connection-check) path.
- `src/adapters/cursor/errors.ts` -- `classifyCursorReplyError` invalidates the same cache when a
  real turn's reply classifies as `auth` or `auth_permanent` (AC4), covering live chat turns.
- `src/adapters/cursor/index.test.ts` -- merged the ticket's two Notes regression tests verbatim
  under a new `describe("issue #98: ...")` block; updated the two pre-existing tests the ticket
  named: the "Logged in (unable to fetch user details)" assertion inside "reads cursor-agent status
  output" now expects `unreadable`; "accepts CURSOR_API_KEY as a login without running the CLI" is
  renamed ("does not accept CURSOR_API_KEY as a login without confirming it works (issue #98)") and
  now expects `unreadable`, since a nonexistent CLI can no longer be used to skip validation. Added
  two more tests for AC3 (a second probe of the same key does not run `about` again) and AC4 (a
  `classifyCursorReplyError` credential rejection forces the next probe to run `about` again), both
  counting real `about` calls through `FAKE_CURSOR_LOG` rather than timing, to avoid flakiness.
- `docs/providers/cursor.md` -- the model-availability table and the P2 parity row now describe the
  key as validated, not merely present, with a new table row for a refused/unconfirmed key.
- `CHANGELOG.md` -- one `### Fixed` line under `## Unreleased` (issue #98).

**Why `missing` for an invalid key, not `unreadable`:** the ticket's Expected line uses `unreadable`
only as an illustration ("not `available` (for example `unreadable`)"), and this adapter already
uses `missing` for "not a working login" (`status` exiting non-zero maps there too); `unreadable`
stays for a verdict the CLI genuinely could not settle either way.

## Verification

**Commands:**
- `npx vitest run src/adapters/cursor/index.test.ts -t "does not report a non-empty CURSOR_API_KEY as available once the CLI itself refuses it"` -- expected: passes. Result: passed.
- `npx vitest run src/adapters/cursor/index.test.ts -t "does not read the CLI's own degraded status line as a working login"` -- expected: passes. Result: passed.
- `npm test` -- expected: all pass. Result: 2045 passed, 71 skipped (skipped = live tests, no `OPENCLAW_ALL_CLI_LIVE`).
- `npm run typecheck` -- expected: clean. Result: clean.
- `npm run ci` -- expected: `All checks passed.` (isolated Node 24 + OpenClaw setup, npm ci, plan gate, typecheck, unit tests, build, package-contents test, `npm pack --dry-run`, install smoke check). Result: passed.
- `npm run test:live` -- **not run**: the ticket's Verify line names only the two `-t` commands above plus `npm test`; this fix needs no live Cursor login to exercise (the fake agent's `FAKE_CURSOR_ABOUT`/`FAKE_CURSOR_LOG` knobs cover every branch), and this host has no `cursor-agent` login.

## Auto Run Result

Status: built

**Summary of implemented change:** a present `CURSOR_API_KEY` is now validated with `cursor-agent
about` (cached per key, invalidated on a credential rejection from any live-turn path) instead of
trusted on presence alone, and a degraded `cursor-agent status` line that admits it could not
confirm the login no longer reads as a working one. Either case now probes as `missing` or
`unreadable`, never `available`. The review pass found and patched two defects that would have
defeated the ticket's own AC3 and AC4 for the realistic case: the cache never held a refused key's
actual verdict on the target CLI version (so every probe re-paid the full cost), and only a
reply-chunk or one-shot-connection-check credential rejection invalidated the cache, not the more
common case of a chat turn refused when its session starts.

**Files changed:**
- `src/adapters/cursor/auth-probe-cache.ts` (new) -- the TTL verdict cache; review pass: keyed per
  signature in a `Map` instead of one shared slot (different agents' keys no longer evict each
  other), and an `unknown` verdict is now cached too, with its own short TTL, instead of never.
- `src/adapters/cursor/index.ts` -- `probeAuth` validates a present key; `parseStatusOutput` no
  longer reads a degraded line as `available`; review pass: `completeError` and `open()`'s own
  `.catch` both route through a new shared `invalidateKeyCacheIfAuthRefusal`, so a chat turn refused
  at session start (a plain `server_error` from `handshake.ts`, which stays CLI-agnostic) also drops
  the cache, not only the one-shot connection check.
- `src/adapters/cursor/errors.ts` -- `classifyCursorReplyError` invalidates the cache on a credential
  rejection from a live turn's reply chunk (both the action-phrase and the coded-error branch).
- `src/adapters/cursor/auth-probe-cache.test.ts` (new, review pass) -- TTL expiry, the `unknown`
  verdict's own shorter TTL, per-signature isolation, and `invalidate` clearing every signature.
- `src/adapters/cursor/index.test.ts` -- the ticket's regression test merged, the two pre-existing
  tests updated, two new cache tests added; review pass: one more test for the session-start
  invalidation path.
- `src/adapters/cursor/errors.test.ts` -- review pass: coverage for the two previously-untested
  invalidation branches ("please sign in to continue", "check your settings to continue").
- `docs/providers/cursor.md` -- model-availability table and P2 parity row updated; review pass:
  the "Key check" section now names the ongoing probe's cost and TTLs.
- `CHANGELOG.md` -- one line under `## Unreleased`.
- `_bmad-output/backlog/bug-provider-reports-authenticated-with-invalid-cursor-api-key-plan.md` -- this plan (new).

**Review findings breakdown:** 4 lenses (Blind Hunter, Edge Case Hunter, Verification Gap, Intent
Alignment) ran at the top level (environment limitation: a dispatched build/review worker cannot
itself spawn a context-free reviewer subagent in this harness, confirmed on ticket 28; the
orchestrator ran the lenses and the triage directly). Many overlapping findings across the four
lenses, grouped by root cause: 2 high, 2 medium, 3 low (2 deferred, 1 a plan-hygiene fix with no
code change), 1 rejected. Patched: the `unknown`-never-cached gap (high), the missing session-start
invalidation path (high), the single-slot multi-key thrashing (medium), and the two untested
invalidation branches (medium). Deferred: concurrent-probe de-duplication, and a narrow
invalidate-during-in-flight-checkKey race (both low, both pre-existing to the chosen design, both
needing more than a direct correction to close well). Rejected: `classifyCursorReplyError` gaining a
side effect (a legitimate design critique, no demonstrated harm). Full detail in the `## Review
Triage Log` entry below.

**Follow-up review recommendation:** `true` -- two high-severity findings were patched this pass.
Specific unverified risk to check: the corrected per-signature `Map` cache and the new `open()`-catch
invalidation path have not themselves had an independent review pass, and the two deferred items
(concurrent-probe races, the invalidate-during-in-flight race) remain acknowledged but unfixed.

**Verification performed:** see `## Verification` above, re-run after patching: the ticket's two
named regression tests still pass; `npx vitest run src/adapters/cursor/index.test.ts
src/adapters/cursor/errors.test.ts src/adapters/cursor/auth-probe-cache.test.ts` -- 111 passed; full
`npm test` -- 2053 passed, 71 skipped (live-only); `npm run typecheck` -- clean; full `npm run ci` --
`All checks passed.`. `npm run test:live` was not run (not required by the ticket's Verify line; no
live-only path in this change; this host has no `cursor-agent` login).

**Residual risks:** The two deferred items above (both low, both pre-existing tradeoffs rather than
new defects introduced by this change). No other residual risk known from implementation, the review
pass, or the checks above.

## Review Triage Log

### 2026-11-19 — Review pass (four thorough lenses, run by the dev-orchestrator at the top level)

Both dispatched build and review workers halted on `no subagents` (same environment limitation
confirmed on ticket 28: a sub-agent spawned by the orchestrator has no further Agent/Task tool of
its own in this harness, so it cannot launch a context-free reviewer subagent for step-04's
thorough-review lenses). The orchestrator independently re-verified the implementation (both named
regression tests, full `npm run ci`, both green; commit `e47d958`), set the plan to `built` to clear
the environment halt, then ran step-04 itself: set the plan to `in-review`, staged the diff since
`baseline_revision` (excluding the orchestrator's own runs-directory journal, out of scope), and
launched all four thorough-review lenses as top-level subagent dispatches in parallel (the only
level that can spawn one here), per `workflow.md`'s own instruction to launch every lens before
reading any of their results.

- verdicts: 9 grouped findings — high 2, medium 2, low 3 (2 deferred, 1 plan-hygiene), false 0,
  maybe-false 0; 1 further finding (a design critique with no demonstrated harm) rejected outright
- findings:
  - `[high]` `[patch]` All four lenses independently found the same defect from different angles:
    cursor-agent 2026.11.11 — the exact CLI version the ticket's intent names — answers `User Email
    Not logged in` for a refused key (`parseAboutOutput` → `unknown`), and the cache's `set()`
    explicitly never stored an `unknown` verdict. So on the real target CLI version, every single
    probe of a refused key re-paid `checkKey`'s full cost (up to two `about` runs, each up to
    `KEY_CHECK_TIMEOUT_MS` = 30s, so up to 60s), not "rarely" as the cache's own doc comment and
    AC3 both claimed. The shipped regression tests used `FAKE_CURSOR_ABOUT: "invalid"` (the older
    CLI's wording, which does get cached as `missing`), so this never showed up in CI. Verified by
    reading `parseAboutOutput`'s own doc comment, which states the 2026.11.11 behavior directly. —
    fixed: `auth-probe-cache.ts`'s `set()` now caches `unknown` too, with its own shorter TTL
    (`unknownTtlMs`, default 30s, vs. 5 minutes for a settled verdict) so a refused key on the real
    target CLI no longer pays the full cost on every probe, while a transient failure (a spawn
    error, a slow first run in a fresh home) is not stuck as long as a settled verdict. New tests in
    `auth-probe-cache.test.ts` pin both TTLs.
  - `[high]` `[patch]` Three lenses (Blind Hunter, Verification Gap, Intent Alignment) independently
    found that AC4's invalidation covered a reply-chunk credential rejection (`classifyCursorReplyError`)
    and the one-shot connection check (`completeError`), but not a chat turn refused when its ACP
    session starts — the most common live-turn shape for a refused key. Verified: `handshake.ts`'s
    `newSession` catch throws `toCliError(error, "server_error", "The CLI could not start a
    session")` with no reclassification (the transport stays CLI-agnostic, AD-2), so that error
    never reaches `classifyCursorReplyError` (reply-text only) or `completeError` (the one-shot path
    only); a revoked key failing a real chat turn at session start left the cache serving a stale
    `valid` for up to 5 minutes. — fixed: factored the detection out of `completeError` into a
    shared `invalidateKeyCacheIfAuthRefusal(error)`, called from both `completeError` and a new
    `.catch` on `AcpSession.open(...)` inside `index.ts`'s `open()` (the adapter layer, which may
    name Cursor specifics; `handshake.ts` itself must not). New regression test in `index.test.ts`
    drives `FAKE_CURSOR_NEW_ERROR` to reproduce the session-start refusal and confirms the cache is
    cleared.
  - `[medium]` `[patch]` Blind Hunter and Edge Case Hunter both found that the cache's single shared
    slot means two agents resolving different `CURSOR_API_KEY` values for the same `cursor-agent`
    command evict each other's cached verdict on every probe, so the module's own claim ("a probe
    checks one key at a time per backend") does not hold once more than one agent is configured.
    Verified: the cache held one `Entry | undefined`, keyed only implicitly by whatever was last
    set. — fixed: the cache now holds a `Map<string, Entry>` keyed by signature, so different keys
    (and commands) no longer evict each other; `invalidate()` still clears every signature (a live
    turn only knows a credential was rejected, not which cached signature it came from). New
    isolation and invalidate-all tests in `auth-probe-cache.test.ts`.
  - `[medium]` `[patch]` Verification Gap found that two of the three invalidation call sites that
    existed in the code (the `ACTION_PHRASES["please sign in to continue"]` and
    `ACTION_PHRASES["check your settings to continue"]` branches in `classifyCursorReplyError`) had
    no test exercising them: deleting either `invalidate()` call would not fail any existing test.
    Verified by reading `errors.ts` and grepping the test files for both phrases (neither appeared).
    — fixed: added `it.each` coverage in `errors.test.ts` asserting the cache drops for both
    phrases.
  - `[low]` `[defer]` Blind Hunter and Edge Case Hunter both found that concurrent cache misses (for
    example the catalog's background probe and `prepareSyntheticAuth` racing at Gateway start) are
    not de-duplicated: each runs its own `checkKey`. Not a correctness bug (each caller still gets a
    correct answer), and a well-made fix (a shared in-flight promise per signature) is more than a
    direct correction for a pass already carrying two high-severity patches. What would settle it:
    how often this race actually happens and what it costs in practice (unverified here).
  - `[low]` `[defer]` Edge Case Hunter found a narrow race: if `invalidate()` runs while an earlier
    `checkKey` call (started before the credential changed) is still in flight, that call's later
    `set()` can restore a `valid` verdict for a key the cache was just told to forget. Verified the
    window exists by reading the code (no generation guard). Bounded by the cache's own TTLs and by
    the next real turn's own failure; closing it cleanly needs a generation counter, which is more
    than a direct correction for a low-likelihood timing coincidence. What would settle it: whether
    this has been observed, and how often `invalidate()` and a fresh `checkKey` call actually
    overlap in practice.
  - `[low]` `[patch]` The committed plan's `## Auto Run Result` had no `## Review Triage Log`
    section boundary, so `scripts/plan-gate.mjs` (which reads to the next `## ` heading) would have
    read the halted pass's stale "Status: blocked" as the plan's latest status once this section was
    finalized — the same structural issue found and fixed on ticket 28. Not a code finding (its fix
    is a plan edit, out of scope for a code patch by the review rules), so it is not part of the
    finding count above; fixed as part of finalizing this plan, not as a triaged finding.
  - `[reject]` Blind Hunter and Edge Case Hunter both named `classifyCursorReplyError` gaining a
    side effect (cache invalidation) as a design smell: a function described elsewhere as a "pure
    text-to-error mapper" now mutates process-wide state. Verified the claim is accurate (it does
    call `cursorKeyCheckCache.invalidate()`), but found no demonstrated harm: the call is idempotent,
    and every test that uses a shared key already uses a unique key per test, so no test depends on
    the absence of this effect. A cleaner home for the invalidation (a turn-end hook rather than
    inside the classifier) is a larger restructuring than this review pass should make for a
    stylistic concern with no failure scenario.

Patches applied directly (oneshot route). Re-ran verification after patching, listed under `## Auto
Run Result` above.

`deferred` (2 items, see above): concurrent-probe de-duplication, and the invalidate-during-in-flight race.
