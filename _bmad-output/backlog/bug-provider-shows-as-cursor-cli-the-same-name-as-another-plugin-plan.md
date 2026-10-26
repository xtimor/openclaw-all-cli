---
title: 'Provider shows as Cursor-CLI, the same name as another plugin'
type: 'bugfix'
ticket: '11'
created: '2026-10-26'
status: 'built'
baseline_revision: '2b1043535e94831c2b2848bae8ac4b16280647df'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick (inline, self-run: no subagents in this environment)']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The provider reads "Cursor CLI" in the Control UI and CLI lists, like the separate plugin `@jeehou/openclaw-cursor-cli`, so users mix them up (issue #36).

**Approach:** Show "OAC / Cursor-CLI" as the provider label, the `providerAuthChoices` group label, and the `uiHints` root label. Provider id `cursor-cli`, model refs, plugin name, error texts, and method labels stay.

</intent-contract>

## Tasks & Acceptance

- `src/core/ports.ts`, `src/adapters/cursor/index.ts` -- optional `CliAdapter.providerLabel` (falls back to `displayName`); Cursor sets "OAC / Cursor-CLI".
- `src/core/provider-auth.ts`, `src/core/synthetic-auth.ts` -- provider `label` uses `providerLabel ?? displayName`.
- `openclaw.plugin.json` -- both `groupLabel` and `uiHints["cursor-cli"].label` become "OAC / Cursor-CLI".
- `test/provider-auth.test.ts`, `test/manifest-ui-hints.test.ts`, `test/backend.test.ts` -- assert label, group label, hint label, and unchanged id; manifest equals adapter label.
- `docs/setup.md`, `docs/providers/cursor.md`, `CHANGELOG.md` -- group name "OAC / Cursor-CLI"; changelog line with #36.

## Implementation Notes

Oneshot: about 40 lines over 8 files, mechanical. A separate label (not changing `displayName`) keeps "Cursor CLI" in error and log text, where it names the product, not the provider.

## Verification

- `npm run ci` -- expected: passes.

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- Own careful read of the full diff against AC 1-3 (inline, no subagents available). Checked: provider label (both `registerProvider` and the synthetic-auth provider), both `groupLabel`s and the `uiHints` root label are "OAC / Cursor-CLI"; id, `providers`, `groupId`, model refs, plugin name, error and log texts unchanged; fallback to `displayName` tested; docs and changelog updated; no protected file touched.

## Auto Run Result

- Summary: the provider reads "OAC / Cursor-CLI" through a new optional `CliAdapter.providerLabel`; `displayName` still names the product in errors and logs.
- Files: `src/core/ports.ts` (field), `src/adapters/cursor/index.ts` (value), `src/core/provider-auth.ts`, `src/core/synthetic-auth.ts` (label), `openclaw.plugin.json` (labels), `test/provider-auth.test.ts`, `test/backend.test.ts` (tests), `docs/setup.md`, `docs/providers/cursor.md`, `CHANGELOG.md`.
- Review: no findings; no patches, no deferrals.
- Follow-up review recommended: false.
- Verification: `npm run ci` passed ("All checks passed", including the packed install smoke check). Live Cursor / Control UI check of `plugins.list` and `models list` names: not run (no Cursor login).
- Residual risk: the Control UI's rendering of the new label was not seen live.
