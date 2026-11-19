---
title: 'A transient Cursor throttle is reported as a spent plan quota'
type: 'bugfix'
ticket: 30
created: '2026-11-19'
status: 'in-review'
baseline_revision: '4746a143dee0b027b4e603e4f476ffc683b1685b'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'thorough'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
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
