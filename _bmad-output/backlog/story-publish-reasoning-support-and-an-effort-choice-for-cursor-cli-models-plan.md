---
title: 'Publish reasoning support and an effort choice for cursor-cli models'
type: 'feature'
ticket: 'story-publish-reasoning-support-and-an-effort-choice-for-cursor-cli-models'
created: '2026-10-22'
status: 'built'
baseline_revision: '36019877396d80975447182c8f1b9c3d4d04f8e6'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/MEMORY.md']
warnings: []
deferred:
  - summary: >-
      The host may pass its resolved default thinking level (not only the user's) as thinkingLevel, so a reasoning row could run on the medium variant instead of its own listed default.
    evidence: |-
      OpenClaw 2026.10.3 prepare.runtime passes params.thinkLevel through resolveProviderThinkingLevel unchanged; whether the caller fills in a default ("medium" for reasoning rows) before that was not traced. Settled by one live cursor-cli turn with no level set and one per level (the ticket's owner check).
    location: >-
      src/core/backend.ts:166
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Every `cursor-cli/*` catalog row is published with `reasoning: false`, so OpenClaw's Effort control is dead, and the host's thinking level never reaches Cursor.

**Approach:** The Cursor catalog marks a row `reasoning` when its exact id carries an effort parameter. The host's thinking level (`prepareExecution` `ctx.thinkingLevel`) travels to the adapter, which picks the listed sibling variant with that effort value; no match keeps the row's own id.

## Boundaries & Constraints

**Always:** Core stays CLI-agnostic (AD-2): Cursor parameter names live only in `src/adapters/cursor/`. Model names and ids already published stay as they are. The mapping uses only ids Cursor's listing offers (never a built id; ACP rejects unknown values).

**Never:** Change turns for rows without an effort parameter; build ids Cursor did not list; add `compat`/`thinkingLevelMap` to the published rows; run Cursor live.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reasoning row | id has `reasoning_effort=` or `effort=` | row `reasoning: true` | none |
| Plain row | no effort param (`default[]`, `composer-2.5[fast=true]`) | `reasoning: false` | none |
| Level matches | row `x[effort=high,fast=true]`, sibling `x[effort=low,fast=true]`, level `low` | sibling id | none |
| No match | level `xhigh`, no such sibling; or no level; or `adaptive` | row's own id | none |
| Other params differ | sibling `x[effort=low,fast=false]` only | not chosen (same non-effort params required) | none |
| Plain row, any level | `composer-2.5[fast=true]`, level `high` | row's own id | none |

</intent-contract>

## Code Map

- `src/adapters/cursor/models.ts` -- `parseId`, `buildCursorCatalog`, `selectCursorModel`; add effort-key detection, `reasoning` on `CliModel`, `effort` argument to `selectCursorModel`.
- `src/core/ports.ts` -- `CliModel` (add `reasoning?`), `OpenParams` (add `thinkingLevel?`).
- `src/core/catalog.ts` -- `CatalogRow`, `toRow`; carry `reasoning`.
- `src/core/synthetic-auth.ts` -- `toModelDefinition` hard-codes `reasoning: false`.
- `src/core/backend.ts` -- `prepareExecutionFor`: `ctx.thinkingLevel` -> `createExecute` options.
- `src/core/execute.ts` -- `ExecuteOptions`, `reuseKey` (level is part of the key: the model is set at open); `src/core/attach-session.ts` -- `adapter.open` params.
- `src/adapters/cursor/index.ts` -- `open()`'s `selectModel` passes the level.
- Tests: `src/adapters/cursor/models.test.ts`, `test/backend.test.ts` (~L1022 catalog rows), `src/core/execute.test.ts`/`test/` execute tests, fake agent `test/fixtures/fake-cursor-agent.mjs` (model lists).
- Docs: `docs/providers/cursor.md` (Models section, parity table P1), `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` (P1 row); `test/parity-suite.test.ts` keeps docs and matrix in step.

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/cursor/models.ts` -- effort keys (`reasoning_effort`, `effort`); `reasoning: true` on rows with one; `selectCursorModel(requested, offered, level?)` swaps in the sibling (same base, same non-effort params) whose effort value matches the level (`off`->`none`/`off`; others equal; case-insensitive) -- AC1, AC2
- [ ] `src/core/ports.ts`, `catalog.ts`, `synthetic-auth.ts` -- carry `reasoning` to the published definition -- AC1
- [ ] `src/core/backend.ts`, `execute.ts`, `attach-session.ts`, `src/adapters/cursor/index.ts` -- pass the level to `open`; add it to the reuse key -- AC2
- [ ] unit tests for the matrix rows (catalog flag, variant pick, fallbacks, reuse key, published definition) -- AC1, AC2
- [ ] `docs/providers/cursor.md`, `claude-cli-parity.md` -- how effort maps, what Cursor does not offer (only listed variants; ACP listing may offer one variant per model, so the level then changes nothing; no `xhigh`/`max` in the picker; effort applies when the session opens) -- AC3

**Acceptance Criteria:**
- Given a listing with a model that has an effort parameter and one that has none, when the catalog is built, then the first row is `reasoning: true` and the second `false`, also in the published model definition.
- Given a reasoning row with sibling variants, when a turn runs with level `low`, then the session is switched to the `low` sibling; a level with no sibling uses the row's id.
- Given the docs, when a reader looks up effort for Cursor, then `docs/providers/cursor.md` and the parity P1 row state the mapping and the limits.

## Implementation Notes

Route: oneshot. Production code is about 75 lines (tests and docs come on top), within the 100-line rule; this worker also has no way to launch a subagent, so it implements in the main session.

## Plan Change Log

## Review Triage Log

### 2026-10-22 - Review pass
- verdicts: 1 findings - high 0, medium 0, low 0, false 0, maybe-false 1
- findings:
  - `[maybe-false]` `[defer]` The host's default thinking level may reach `prepareExecution` when the user set none, moving a reasoning row off its listed default - the trace into the caller of `params.thinkLevel` was not done; a live turn with no level set would settle it. Recorded in `deferred`.
- Note: the Quick lens is a subagent; this worker cannot launch one, so the pass is the worker's own read of the diff (no independent reviewer, `lenses_ran` empty). All three acceptance criteria were checked against the diff and tests; no patch needed.

## Design Notes

Host facts (OpenClaw 2026.10.3): `CliBackendPrepareExecutionContext.thinkingLevel` is the user's level (undefined when unset); `execute`'s context has none, so `prepareExecutionFor` forwards it, as it does `authProfileId`. Real Cursor ids seen: `grok-4.7[context=256k,reasoning_effort=high,fast=true]`, `claude-opus-5-5[context=300k,effort=medium,fast=false]`. Live check not run (no login).

## Verification

**Commands:**
- `npm run ci` -- expected: passes

## Auto Run Result

**Summary:** Catalog rows whose Cursor ID carries an effort parameter (`reasoning_effort` or `effort`) are published `reasoning: true`. The host's thinking level (`prepareExecution` `thinkingLevel`) reaches `OpenParams.thinkingLevel`; the Cursor adapter swaps in the listed sibling (same base, same other parameters) whose effort value matches, else keeps the row's id. The level is part of the reuse key.

**Files changed:**
- `src/adapters/cursor/models.ts` - effort keys, `reasoning` flag, `selectCursorModel(..., level)`.
- `src/core/ports.ts`, `catalog.ts`, `synthetic-auth.ts` - `reasoning` on `CliModel`/`CatalogRow` and in the published definition; `OpenParams.thinkingLevel`.
- `src/core/backend.ts`, `execute.ts`, `attach-session.ts`, `src/adapters/cursor/index.ts` - level from `prepareExecution` to `open`, reuse key.
- Tests: `models.test.ts`, `index.test.ts`, `execute.test.ts`, `test/backend.test.ts`.
- Docs: `docs/providers/cursor.md` (Effort section, P1 row), parity matrix P1 row.

**Review:** patches applied 0; deferred 1 (medium, unverified); rejected 0. Independent Quick lens not run (no subagent available): `followup_review_recommended: true` for that unverified risk, plus the default-level question above.

**Verification:** `npm run ci` passed (typecheck, unit tests, build, package test, pack, install smoke). Live Cursor check not run (no login): effort per level, and the default-level question, wait for the owner's live turn.

**Residual risks:** Cursor's ACP listing may hold one variant per model, so the level then changes nothing (documented). Level change restarts the process for non-reasoning rows too (about 3 s, resume).
