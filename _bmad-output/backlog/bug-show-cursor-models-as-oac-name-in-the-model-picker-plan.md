---
title: 'Show Cursor models as OAC / name in the model picker'
type: 'bugfix'
ticket: '12'
created: '2026-10-26'
status: done
baseline_revision: '7db770ccc976e3f5ea2de9f1f4586420cd81a164'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'auto'
lenses_ran: ['quick (inline, self-run: no subagents in this environment)']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Cursor models look like any other provider's models in the picker (issue #37).

**Approach:** Every catalog row name, the default row included, gets the prefix "OAC / " in `src/core/catalog.ts`. Ids, refs, and aliases stay.

</intent-contract>

## Tasks & Acceptance

- `src/core/catalog.ts` -- exported `ROW_NAME_PREFIX`; `toRow` and `defaultCatalogRow` prefix `name`.
- `src/core/catalog.test.ts`, `src/core/listings.test.ts`, `test/backend.test.ts` -- prefixed names asserted, ids unchanged, every row checked.
- `docs/providers/cursor.md`, `CHANGELOG.md` -- describe the prefix; changelog line links #37.

## Implementation Notes

Oneshot: about 10 lines of code over one source file, mechanical. The prefix is in the core catalog (not the Cursor adapter) because every row is built there, including the fallback default row; it names the plugin, not a CLI.

## Verification

- `npm run ci` -- expected: passes.

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- Own read of the full diff against AC 1-3 (inline, no subagents available). Checked: both row builders (`toRow`, `defaultCatalogRow`) prefix; the fallback rows built from `defaultCatalogRow` too; `id`, ref, alias code untouched (the host key is `id`); docs and changelog updated; no protected file touched.

## Auto Run Result

- Summary: every Cursor catalog row name starts with "OAC / ", ids and refs unchanged.
- Files: `src/core/catalog.ts`, tests above, `docs/providers/cursor.md`, `CHANGELOG.md`.
- Review: inline, no findings; no deferrals. Follow-up review recommended: false.
- Verification: `npm run ci` passed ("All checks passed"). Live Cursor / Control UI model picker check: not run (no Cursor login, no browser).
- Residual risk: how the picker renders the longer names was not seen live.
