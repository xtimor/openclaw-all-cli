---
title: '1M context variants of Cursor models cannot be picked (ticket 17, issue #46)'
type: 'bugfix'
ticket: '17'
created: '2026-10-28'
status: done
baseline_revision: '979250369f6d040cb0c8ea3f24490ba87792046e'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick-inline]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The catalog lists only the Opus 5.5 row the ACP session reports (300k), and the owner cannot pick a 1M variant that `cursor-agent --list-models` sells as "1M".

**Approach:** Run the live probe first (`session/set_model` with 1M IDs). If Cursor accepts a 1M ID, add each 1M variant as its own model; if Cursor refuses it, leave the catalog as is, pin that with tests on the fake `cursor-agent`, and document the refusal, the 300k default, and the changelog line (#46). The window always follows the ID's own `context` value.

</intent-contract>

## Implementation Notes

Route oneshot: the probe decides the scope, and a refused 1M ID means no catalog code, only pinning tests, one comment, docs, and the changelog line (about 80 lines).

**Live probe (AC1), run 2026-10-28, cursor-agent 2026.10.22, `CURSOR_API_KEY`, outside the sandbox, throwaway `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` (the shared `~/.cursor` model was not touched), scratch ACP client in the session scratchpad:**
- `session/new` lists 47 models; Claude rows carry `context=300k` (Opus 5.5, Opus 5, Opus 4.8, Sonnet 5, 5.5, Haiku 5.5, Fable) or `200k`; none carries `1m`.
- `session/set_model` and `session/set_config_option` (`model`) with the listed row's ID and `context=1m` (`claude-opus-5-5[context=1m,effort=medium,fast=false]`): `-32602 Invalid params`, `Invalid model value: ...`. Same for `claude-opus-5[...]`, `claude-opus-4-8[...]`, `claude-sonnet-5-5[...]`, `gpt-5.6-sol[...]`, and for `context=1M`, `1000k`, `1000000`, `500k`, `2m`, `[1m]`, `claude-opus-5-5-1m`, `claude-opus-5-5-medium`, `[context=1m,fast=false]`. The listed `context=300k` ID is accepted (control).
- `cursor-agent --model '<1m id>' acp`: the session starts and reports the 300k row as `currentModelId`; a turn on it answered `OK`. The flag does not select a 1M model over ACP. Whether Cursor still runs 1M behind the 300k label is not known.
- `cursor-agent -p --trust --mode ask --model 'claude-opus-5-5[context=1m,effort=medium,fast=false]' --output-format json`: accepted, one turn answered `OK` (usage: cacheRead 9883, cacheWrite 6599; no cost field). `context=2m`: `Cannot use this model`. `cursor-agent --list-models` shows "Claude Opus 5.5 1M" etc. under CLI-style IDs that ACP rejects (MEMORY, model catalog).
- Billing of a 1M turn: `cursor-agent` prints token counts only; not known. Documented as such.

Result: Cursor refuses 1M IDs over ACP, so AC4 applies (catalog unchanged, docs say refused). AC2 is conditional on acceptance and does not apply; the existing code already satisfies AC3 (the ID's `context` value wins, `1m` is 1,000,000, the ceiling follows the row), now pinned for a 1M row beside a 300k row.

**Files:** `src/adapters/cursor/models.test.ts` (describe "1M variants (issue #46)": no invented 1M row or name, `selectCursorModel`/`resolveCursorModel` undefined for 1M spellings; a listed 1M row keeps earlier names, IDs, and windows, takes its own 1,000,000 window; ceilings 1,000,000 and 300,000), `src/adapters/cursor/index.test.ts` (fake `cursor-agent`: a 1M name or ID it did not list fails `model_not_found`), `src/adapters/cursor/models.ts` (comment only: the family table holds ACP defaults), `docs/providers/cursor.md` (section "1M context variants" with the probe table), `CHANGELOG.md` (line under Unreleased linking #46).

**Mutation check:** with the family window read before the ID's own `context`, 4 tests failed (2 new, 2 old); restored.

**Review without subagents:** this worker session has no tool to start a subagent, so the quick review was done inline by the same session (lens id `quick-inline`), against the diff and the ticket's ACs.

## Plan Change Log

## Review Triage Log

### 2026-10-28 - Review pass
- verdicts: 2 findings - high 0, medium 0, low 1, false 1, maybe-false 0
- findings:
  - `[low]` `[reject]` AC3 says the family table is "never consulted" for an ID that carries a `context` value, but `contextWindowOf` falls back to the family window when the value is not a number (`context=max`) - the bad outcome is real only for an unparsable value that Cursor has not produced in any listing; the fix would add a branch and change documented behavior ("a value that is not a number is ignored"); not worth it.
  - `[false]` `[reject]` The docs promise a 1M row Cursor lists later would be its own model with a 1,000,000 window and ceiling "with no change to the plugin" - checked: `models.test.ts` "uses the window in a listed 1M ID" and "gives a 1M row a 1,000,000 ceiling" run exactly that on a list with a 1M sibling and pass, and the mutation check shows they fail when the ID's value is not read first.

## Verification

**Commands:**
- `npx vitest run src/adapters/cursor` -- expected: pass
- `npm run ci` -- expected: pass

## Auto Run Result

Status: built

**Summary.** Probed Cursor live: ACP refuses every `context=1m` model ID (`Invalid model value`), though `cursor-agent -p --model` accepts one. So the 1M variants cannot be picked through the plugin, and by AC4 the catalog is unchanged. Added tests on the fake `cursor-agent` that pin the 1M behavior (no invented 1M model or ref, a listed 1M row gets its own window and a 1,000,000 ceiling, existing names and refs stay), a docs section with the probe table, and the changelog line linking #46.

**Files changed.** `src/adapters/cursor/models.ts` (comment), `src/adapters/cursor/models.test.ts` and `src/adapters/cursor/index.test.ts` (tests), `docs/providers/cursor.md` (section "1M context variants"), `CHANGELOG.md` (Unreleased line), this plan.

**Review.** Quick, inline (no subagent could be started from this session). Patches applied: 0. Deferred: 0. Rejected: 2 (a low on an unparsable `context` value falling back to the family window; a false on the docs' claim about a later 1M row, which the new tests run).

**Follow-up review recommended:** false (no patch applied).

**Verification.** `npx vitest run src/adapters/cursor` passed (197 tests); `npm run ci` passed ("All checks passed"); mutation check failed 4 tests as expected, restored. Live probe as in Implementation Notes.

**Residual risks.** (1) A 1M turn's billing is not known. (2) Whether `cursor-agent --model '<1m id>' acp` runs a 1M model behind the 300k label is not known; a way to offer 1M through a launch flag was not built (it would be a per-model process argument, outside this ticket). (3) The live ACP refusal is for cursor-agent 2026.10.22 on one account; a newer Cursor may accept it, and the code then needs no change.
