---
title: 'Cursor provider reports authenticated with an invalid or unconfirmed CURSOR_API_KEY'
type: 'bugfix'
ticket: '29'
created: '2026-11-19'
status: blocked
baseline_revision: 'b7fdefb1bc6218b4d58023565b51dcb276aa591e'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
blocked_at: "2026-11-19"
blocked_reason: "no subagents: step-04's thorough review requires launching four context-free reviewer subagents (Blind Hunter, Edge Case Hunter, Verification Gap, Intent Alignment), and this session has no tool to spawn one (confirmed via ToolSearch for Task/Agent/Subagent-spawning tools; only SendMessage/SubagentHandback to already-existing agents is available)."
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

Status: blocked
Blocking condition: no subagents

Implementation is complete and verified; the run halted at step-04 (Review), before any of the four
thorough-review lenses (Blind Hunter, Edge Case Hunter, Verification Gap, Intent Alignment), each of
which `workflow.md` requires launching as a context-free subagent. This session has no tool that can
spawn a fresh subagent (confirmed via `ToolSearch`: no Task/Agent/Subagent-spawning tool is listed or
loadable; `SendMessage`/`SubagentHandback` only reach an already-existing agent, never a fresh
context-free one). Per `workflow.md` -> Subagents: "Using subagents when instructed is mandatory. If
you cannot, HALT with status `blocked` and blocking condition `no subagents`." This mirrors ticket
28's confirmed environment limitation.

**Summary of implemented change:** a present `CURSOR_API_KEY` is now validated with `cursor-agent
about` (cached briefly, invalidated on a credential rejection) instead of trusted on presence alone,
and a degraded `cursor-agent status` line that admits it could not confirm the login no longer reads
as a working one. Either case now probes as `missing` or `unreadable`, never `available`.

**Files changed:**
- `src/adapters/cursor/auth-probe-cache.ts` (new) -- the TTL verdict cache.
- `src/adapters/cursor/index.ts` -- `probeAuth` validates a present key; `parseStatusOutput` no
  longer reads a degraded line as `available`; `completeError` invalidates the cache on a credential
  rejection.
- `src/adapters/cursor/errors.ts` -- `classifyCursorReplyError` invalidates the cache on a credential
  rejection from a live turn.
- `src/adapters/cursor/index.test.ts` -- the ticket's regression test merged, the two pre-existing
  tests updated, two new cache tests added.
- `docs/providers/cursor.md` -- model-availability table and P2 parity row updated.
- `CHANGELOG.md` -- one line under `## Unreleased`.
- `_bmad-output/backlog/bug-provider-reports-authenticated-with-invalid-cursor-api-key-plan.md` -- this plan (new).

**Review findings breakdown:** No review lens ran (see Blocking condition). No findings to report.

**Follow-up review recommendation:** Not computed (review did not run).

**Verification performed:** see `## Verification` above -- both of the ticket's named regression
tests (confirmed they fail on the pre-fix code: the ticket's own Notes section records
`AssertionError: expected 'available' not to be 'available'` for each), full `npm test` (2045
passed, 71 skipped live-only), `npm run typecheck` (clean), and the full `npm run ci` (isolated Node
24 + OpenClaw setup, plan gate, typecheck, unit tests, build, package-contents test, pack dry run,
install smoke check -- all passed). `npm run test:live` was not run (not required by the ticket's
Verify line; no live-only path in this change; this host has no `cursor-agent` login).

**Residual risks:** None known from implementation or the checks above. The code has not had an
independent review pass (the four thorough-review lenses), so a second set of eyes before merge is
advisable once a subagent-capable session is available.
