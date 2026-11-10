---
title: 'Update instructions say a running Gateway is refreshed by plugins update, which current OpenClaw refuses'
type: 'bugfix'
ticket: '25'
created: '2026-11-10'
status: done
baseline_revision: 'fb1debf51743a73921787f72ab749b44c0d364f9'
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
---

<intent-contract>

## Intent

**Problem:** `README.md` (Update) and `docs/setup.md` (Install from npm) say a running local Gateway is refreshed by `openclaw plugins update`. Current OpenClaw refuses `plugins update` while the Gateway runs, so a user who follows the text fails.

**Approach:** Both docs give two paths: with the Gateway running, reinstall with `openclaw plugins install openclaw-all-cli --accept-capabilities --force`; or stop the Gateway through its service owner (`openclaw gateway stop`, or the Gateway container for Docker Compose), run `openclaw plugins update openclaw-all-cli`, and start it again. Both say OpenClaw 2026.10.3 still accepts `plugins update` with the Gateway running. Add one `## Unreleased` changelog line with issue #80. Docs and changelog only; test first.

</intent-contract>

## Implementation Notes

Oneshot: docs, one test file, one changelog line; well under 100 lines. Test first (the ticket's reproduction test, plus pins for the other acceptance criteria), confirm it fails on the old docs, then fix the docs.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/docs-update-instructions.test.ts -t "Gateway"` -- expected: passes (fails before the docs change)
- `npm run ci` -- expected: passes

## Auto Run Result

Status: in-review (review pending: this worker had no way to launch review subagents, so step 4 was not run; the orchestrator runs the `quick` review).

- Summary: README Update and docs/setup.md Install from npm now give two paths (reinstall with `--force` while the Gateway runs; or stop it via its service owner, `plugins update`, start it) and say 2026.10.3 still accepts `plugins update` with the Gateway running. `## Unreleased` has one Fixed line with issue #80.
- Files changed: `test/docs-update-instructions.test.ts` (ticket reproduction test plus pins for both docs and the changelog), `README.md`, `docs/setup.md`, `CHANGELOG.md`, this plan.
- Test first: the new test failed 6 of 6 on the old docs, passes 6 of 6 after the fix.
- Verification: `npm run ci` passed ("All checks passed", install smoke `status=loaded`). Live Cursor check: not run (no `cursor-agent` login; docs-only change).
- Review: not run. Patches 0, deferred 0, rejected 0. Follow-up review recommended: false.
- Residual risk: the "2026.10.3 still accepts `plugins update`" claim and the refusal on current OpenClaw come from the ticket; not re-probed here.

## Auto Run Result (review pass 1)

Status: built.

- Review: quick, run by the orchestrator in its own session (the build worker had no subagents). It read the whole diff against the intent contract: both docs give the two paths and the 2026.10.3 note, the false claim is gone, the changelog line links #80, no protected file changed, the test file holds the ticket's reproduction test plus pins. Findings: none. Patches 0, deferred 0. Follow-up review recommended: false.
- Verification: `npm run ci` passed after the build (rerun before the pull request). Live Cursor check: not run (no `cursor-agent` login; docs-only change).
