---
title: 'All cursor-cli models report the same 128k context window'
type: 'bugfix'
ticket: 'bug-cursor-cli-models-all-report-the-same-128k-context-window'
created: '2026-10-22'
status: built
baseline_revision: '3c130f34009aaf27c9723cf4bb54e57bf673cd2a'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every `cursor-cli/*` catalog row is published with no `contextWindow`, so OpenClaw shows and budgets compaction by its 128k default for every model.

**Approach:** The Cursor adapter derives a window per row and the core carries it through `CliModel` and `CatalogRow` into the published model definition. Order: the row's own `context=` value (`256k`, `1m`), else a small per-family table of windows seen in Cursor's own listing, else none (the field is omitted; the host default stays).

## Boundaries & Constraints

**Always:** Core stays CLI-agnostic (AD-2): the `context` parameter name, its `k`/`m` spelling, and the family table live only in `src/adapters/cursor/`. `k` is 1 000 and `m` is 1 000 000 (the smaller reading, so compaction never comes late). A window is a positive finite integer or absent.

**Never:** Guess a window for an unknown id (Auto, `composer-*`, `gemini-*`, and anything else unlisted stay unset); change names, ids, or turn behavior; set `contextTokens`/`maxTokens`; run Cursor live.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Own parameter | `grok-4.7[context=256k,...]`, `x[context=1m]` | 256000, 1000000 | none |
| Family, no parameter | `grok-4.7[reasoning_effort=high]`, `claude-opus-5-5[effort=low]` | the family window (256000, 300000) | none |
| Own wins | `grok-4.7[context=1m]` | 1000000, not the family's | none |
| Unknown | `default[]`, `composer-2.5[fast=true]`, `gemini-3.1-pro[]` | no `contextWindow` field | none |
| Unparsable | `x[context=max]`, `x[context=0]`, `x[context=]` | family window if known, else none | ignored, no throw |

</intent-contract>

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/cursor/models.ts` -- `contextWindow` on `buildCursorCatalog` rows: parse `context`, family table fallback -- AC1
- [ ] `src/core/ports.ts`, `catalog.ts`, `synthetic-auth.ts` -- carry `contextWindow` to the published definition (omit when absent) -- AC1
- [ ] `src/adapters/cursor/models.test.ts`, `index.test.ts`, `src/core/catalog.test.ts`, `test/backend.test.ts` -- matrix rows; a test that fails without the fix -- AC2
- [ ] `docs/providers/cursor.md`, parity matrix P1 -- what the window is, where it comes from, what stays unset -- docs rule

**Acceptance Criteria:**
- Given a listing with rows that have a `context=` parameter and rows without, when the rows are built, then a row with the parameter carries it, a row of a family in the table carries the family window, and an unknown row carries none, also in the published model definition.
- Given the test suite, when it runs, then those cases fail on the old code and pass on the fix.

## Implementation Notes

Route: oneshot, about 60 lines of production code. This worker cannot launch subagents, so it plans and reviews in the main session (`lenses_ran` stays empty). Family table values are only ones seen in the repo's recorded Cursor listing (cursor-agent 2026.10.16 `session/new`, `src/adapters/cursor/models.test.ts` REAL): `grok-4.7` 256k, `claude-opus-5-5` 300k, `claude-opus-5` 300k. Windows of `composer-*`, `gemini-*`, and Auto are not in any repo source or the listing, so they stay unset. Effort siblings share every non-effort parameter (`context` included), so the effort swap never changes the window. AC3 (no change needed) does not hold: the row builder returns no window field (read in code, `toModelDefinition`).

## Plan Change Log

## Review Triage Log

### 2026-10-22 - Review pass
- verdicts: 3 findings - high 0, medium 0, low 2, false 1, maybe-false 0
- findings:
  - `[low]` `[reject]` `k` read as 1 000 while Cursor may mean 1 024 (`256k` = 262 144): off by 2.3% in the safe direction (compaction earlier, never later); the fix needs a fact only a live Cursor gives; documented as the smaller reading.
  - `[low]` `[reject]` The family table can go stale if Cursor changes a family's default window: affects only rows with no `context=` value, three families, each value seen in the recorded listing; the ticket's AC1 asks for exactly this fallback, and an own `context=` always wins.
  - `[false]` `[reject]` An effort-variant swap could change the window: `idForEffort` requires equal non-effort parameters, `context` included (`fixedParams`), so a swap never crosses windows; a row without `context` cannot swap to one with it.
- Note: the Quick lens is a subagent; this worker cannot launch one, so the pass is the worker's own read of the diff and the plan's criteria (`lenses_ran` empty). AC1 and AC2 checked against diff and tests: met. AC3 (no change needed) does not hold: the old rows carry no window.

## Verification

**Commands:**
- `npm run ci` -- expected: passes

## Auto Run Result

**Summary:** Each `cursor-cli` catalog row now carries a `contextWindow` when one is known. The Cursor adapter takes the ID's `context=` value (`256k` is 256 000, `1m` is 1 000 000), else a small family table (`grok-4.7` 256k, `claude-opus-5-5` and `claude-opus-5` 300k, the only windows in the recorded Cursor listing), else none. `CliModel`, `CatalogRow`, and the published model definition carry it, and the key is omitted when unknown, so the host default (128k) shows only for Auto, `composer-*`, `gemini-*`, and other unlisted models. The window is attached to the model row, so the effort choice (earlier ticket, variants in `models.ts`) does not change it: siblings share `context`.

**Files changed:**
- `src/adapters/cursor/models.ts` - window parsing, family table, `contextWindow` on built rows.
- `src/core/ports.ts`, `src/core/catalog.ts`, `src/core/synthetic-auth.ts` - `contextWindow` through `CliModel`, `CatalogRow`, and the published definition.
- Tests: `src/adapters/cursor/models.test.ts`, `src/adapters/cursor/index.test.ts`, `src/core/catalog.test.ts`, `test/backend.test.ts` (six failed on the old code, pass now).
- Docs: `docs/providers/cursor.md` (Context window section, P1 row), parity matrix P1 row, `MEMORY.md`.

**Review:** patches applied 0; deferred 0; rejected 2 low (k=1000 reading; family table staleness) and 1 false (effort swap changing the window), reasons in the triage log. Independent Quick lens not run (no subagent available).

**Verification:** `npm run ci` passed. Isolated OpenClaw 2026.10.3 (copied state, packed plugin, fake agent as `command`, `gateway call models.list`): `fake-slow[context=1m,...]` showed `contextWindow` 1000000, rows with no window showed the host's 128000. Live Cursor check not run (no login): the owner compares `openclaw models list --all` on a gateway with a login.

**Residual risks:** Cursor's `256k` may mean 262 144 (the smaller reading is used); the family table follows what Cursor's listing gave on 2026.10.16.
