---
title: 'Context usage tile shows totalTokens far above the model context window'
type: 'bugfix'
ticket: 15
created: '2026-10-26'
status: done
baseline_revision: '3332cd30b5c6be5db2ddae4dcdff7e8bb76cc96b'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** After a multi-request Cursor turn (tool calls) the Control UI context tile showed 5.6M / 256k (issue #40). OpenClaw 2026.10.3 reads a CLI turn's usage as a context snapshot: the session row's `totalTokens` (the tile's `used`, and `cli_budget` compaction's input) is `input + cacheRead + cacheWrite` of the turn's usage, or `total - output` when those are empty. Both plugin sources report per-turn sums over every model request (Cursor's ledger event, ACP `Usage`), so cache reads are counted once per request and the reading can exceed any window.

**Approach:** The core bounds a turn's usage before it reaches the host: when the context reading (`input + cacheRead + cacheWrite + output`, or `total`) exceeds the session's context ceiling, `total` is omitted and the usage is marked "context size unknown", which the record boundary sends as the host's own `contextUsage: {state: "unavailable"}` (OpenClaw then keeps no context snapshot from it). Input, output, and cache counts stay as reported. The adapter supplies the ceiling: the model's window, else the largest window among the account's models.

## Boundaries & Constraints

**Always:** One bounding function in the core, used for both sources (ACP `usage` event and `readUsage`). Plausible usage passes unchanged. No ceiling means no change. Docs say what the numbers mean. Record which source live cursor-agent 2026.10.22 uses.

**Never:** Invent a context number; rescale or drop input/output/cache counts; read OpenClaw config or the catalog in `execute`; edit protected files, ticket files, `tickets.toml`, runs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Plausible ledger turn | in 5 074, out 31, cacheRead 10 240, total 15 345; ceiling 256 000 | unchanged, no marker | none |
| Implausible ledger turn | in 100 000, out 86 800, cacheRead 5 400 000, total 5 586 800; ceiling 256 000 | `total` omitted, buckets kept, context unknown | none |
| Implausible ACP turn | ACP usage total 5 600 000, in 100 000, out 86 800; ceiling 256 000 | same as above | none |
| Plausible ACP turn | ACP total 7, in 3, out 4 | unchanged | none |
| Output pushes over | in 250 000 (prompt sum), out 10 000, ceiling 256 000 | context unknown (one request cannot exceed the window) | none |
| Exactly at ceiling | reading == ceiling | unchanged | none |
| No ceiling | adapter knows no window (no listed model has one) | unchanged | none |
| Auto | session on `default[]`, listed models up to 1 000 000 | ceiling 1 000 000 | none |

</intent-contract>

## Code Map

- `src/core/ports.ts` -- `NormalizedUsage` (add `contextUnknown?: true`), `CliSession` (add `readonly contextCeiling?: number`). Transports and adapters import only this file from the core.
- `src/core/usage.ts` -- add pure `boundTurnUsage(usage, ceiling)`; `readTurnUsage` stays.
- `src/core/execute.ts:400-423` -- usage event and `readTurnUsage` set `summary.usage`; bound both with `active.session.contextCeiling` before `toRecord`.
- `src/core/events.ts` -- `parseJsonlEvent` result: map `contextUnknown` to host field `contextUsage: {state: "unavailable"}` (host wire lives here only).
- `src/transports/acp/handshake.ts:145-147,237-266` -- `switchModel` returns the ID the session runs (`wanted`, or `currentId` for `null`); `Handshake.modelId`.
- `src/transports/acp/session.ts:108-117,160-170` -- `mapUsage` unchanged (as reported); new option `contextCeilingOf?(modelId, offered)`; session exposes `contextCeiling`.
- `src/adapters/cursor/models.ts` -- add `cursorContextCeiling(modelId, offered)` from `buildCursorCatalog`.
- `src/adapters/cursor/index.ts:221-268` -- pass `contextCeilingOf` in `open`.
- `test/fixtures/fake-cursor-agent.mjs:332` -- `FAKE_CURSOR_USAGE` also takes a JSON usage object.
- Host facts (OpenClaw 2026.10.3, read): `usage-*.mjs` `deriveContextPromptTokens` reads `lastCallUsage.contextUsage` first (`unavailable` → no snapshot); CLI `lastCallUsage` is the plugin's usage object as is (`cli-runner` `agentMeta`, `projectCliBackendEvent`); Control UI tile `Rw` uses session `totalTokens`, `~` when `totalTokensFresh === false`; `cli-compaction` uses fresh `totalTokens`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports.ts` -- add the two fields with docs -- contract for the marker and ceiling.
- [x] `src/core/usage.ts` -- `boundTurnUsage` -- the one rule.
- [x] `src/core/execute.ts` -- bound both sources -- AC1.
- [x] `src/core/events.ts` -- marker to `contextUsage` -- host reads it.
- [x] `src/transports/acp/handshake.ts`, `session.ts` -- effective model ID, `contextCeilingOf`, `contextCeiling`.
- [x] `src/adapters/cursor/models.ts`, `index.ts` -- Cursor ceiling.
- [x] `test/fixtures/fake-cursor-agent.mjs` -- JSON usage knob.
- [x] `src/core/usage.test.ts` -- matrix rows for `boundTurnUsage` (ledger and ACP shapes).
- [x] `src/transports/acp/session.test.ts` -- ACP source through the fake: plausible kept, implausible clamped by the core rule with the session's ceiling; ceiling follows the selected model.
- [x] `src/core/execute.test.ts` -- result record for both sources, plausible and implausible.
- [x] `src/core/events.test.ts` -- marker becomes `contextUsage`.
- [x] `src/adapters/cursor/models.test.ts` -- ceiling: own window, Auto, none.
- [x] `test/host-contract.test.ts` -- host: `deriveSessionTotalTokens` gives the prompt sum without the marker and nothing with it.
- [x] `docs/providers/cursor.md` -- what the usage numbers and the tile mean -- AC3.
- [x] `CHANGELOG.md` -- Unreleased line linking #40.
- [x] `MEMORY.md` -- finding, live source, fake knob.

**Acceptance Criteria:**
- Given a Cursor turn whose usage reading exceeds the model's window, when OpenClaw records it, then the session row gets no fresh `totalTokens` from it (the tile cannot show a value above the window from this turn) while input, output, and cache counts stay as reported and `total` is omitted.
- Given a plausible usage report from either source, when it is mapped, then the result record carries it unchanged.
- Given `npm run ci`, when it runs, then it passes, including the tests above.
- Given `docs/`, when a user reads the Cursor provider page, then it says what input, output, cache, and the context tile mean and when the tile shows `~`.

## Implementation Notes

- No subagents in this run (worker session): the full route's implementation and the four review lenses ran inline in this session, one pass each, in the lens order of step 4. Recorded as a deviation from the full route's handoff.
- Live check (cheap, run 2026-10-26 with `CURSOR_API_KEY`, cursor-agent 2026.10.22): a scratch ACP probe (`session/new`, two prompts, temp `CURSOR_CONFIG_DIR`) got `{stopReason: "end_turn"}` with no `usage` and no `usage_update`; the ledger listed one event per turn (in 5 074 / out 31 / cacheRead 10 240, then in 164 / out 32 / cacheRead 15 232). So the live source is the ledger. A live tool-call turn and the Control UI tile were not run.
- Host probe (scratch `SPIKE_DIR` with links to `.spike/node` and `.spike/openclaw`, fresh state, plugin installed, fake agent as `command`, `FAKE_CURSOR_USAGE` JSON in `cursor-cli.env`, `openclaw agent --local --model cursor-cli/fake-slow`, then `openclaw sessions --json`): a 5 586 800-token usage gave `agentMeta.lastCallUsage` with `contextUsage: {state: "unavailable"}` and no total, and the session row `totalTokens: null`, `totalTokensFresh: false`, input/output kept; a plausible usage gave `totalTokens: 15314`, fresh. Scratch state removed after.
- Mutation checks: removing the bound in `execute.ts` failed the execute "summed usage" test; removing `contextCeilingOf` from the Cursor `open` failed the new adapter wiring test. Both restored.
- Files beyond the Code Map: `src/adapters/cursor/index.test.ts` (wiring test, from review). The ticket's "far above input plus output" trigger is not used on its own (Design Notes).

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 9 findings — high 0, medium 1, low 3, false 5, maybe-false 0
- findings:
  - `[low]` `[reject]` blind-hunter: a throwing `contextCeilingOf` fails the open (inside the handshake `try`, so `failedOpen`) — the only implementation (`cursorContextCeiling`) maps a list and cannot throw on ACP data; a guard adds a branch for an unseen case.
  - `[false]` `[reject]` blind-hunter: the ceiling is fixed at open while a warm session's model could change — the reuse key holds model and thinking level (`execute.ts` key), so another model is another session.
  - `[false]` `[reject]` blind-hunter: dropping `total` makes the transcript total 0 — the host's `buildUsageWithNoCost` sums the buckets when `totalTokens` is absent (`stream-message-shared-*.mjs`).
  - `[false]` `[reject]` blind-hunter: `HostUsage` with `contextUsage` breaks the SDK `parseJsonlEvent` type — typecheck passes; the probe showed the field reaching `lastCallUsage`.
  - `[low]` `[reject]` blind-hunter: for Auto the ceiling is the largest listed window, so an Auto turn just under it still reads high — documented in docs and Design Notes; the plugin has no per-request split.
  - `[false]` `[reject]` edge-case-hunter: buckets empty and only `total` set — `count(total)` is in the reading; tested (`{ total: 256_001 }`).
  - `[medium]` `[patch]` verification-gap: no test would fail if the Cursor adapter stopped passing `contextCeilingOf` (session tests pass their own callback, execute tests use fake sessions) — added "gives the session the context ceiling of the model it runs" in `src/adapters/cursor/index.test.ts`; mutation-checked.
  - `[low]` `[patch]` verification-gap: the handshake's no-choice branch (`facts.currentId`) had no test — added a no-`selectModel` open to the session ceiling test.
  - `[false]` `[reject]` intent-alignment: the ticket's Given "far above input plus output" is not a trigger, and "used stays near input plus output" is not produced — the live ledger shows a plain cached turn 15 232 cache read vs 196 input+output, so that trigger would clamp every plausible turn, contradicting AC2's "plausible total (kept)"; AC1's Then allows "(or omitted)"; the diff exercises the outermost reachable surface (host `deriveSessionTotalTokens`, session row via the probe), the Control UI render is not run.

## Design Notes

- Why not clamp `total` only (ticket hypothesis): the host's context reading is the prompt buckets, not `total`; a clamped `total` alone would leave the tile at 5.6M. `contextUsage: {state: "unavailable"}` is the host's own signal for this (its `transcript-persistence` sets it for CLI usage it cannot read), though not in `CliBackendJsonlUsage`; a host-contract test pins it.
- "Far above input plus output" alone is no signal: live ledger 2026-10-26, plain cached turn: in 164, out 32, cacheRead 15 232 (normal). Only the ceiling decides.
- A sum over several requests that stays under the ceiling still overstates; the plugin cannot split it (one ledger event per turn). Documented.
- Live source (cursor-agent 2026.10.22, 2026-10-26 probe, API key): `session/prompt` answers `{stopReason: "end_turn"}` with no `usage` and no `usage_update`; usage comes from the ledger (one event per turn).

## Verification

**Commands:**
- `npx vitest run src/core/usage.test.ts src/core/events.test.ts src/core/execute.test.ts src/transports/acp/session.test.ts src/adapters/cursor/models.test.ts test/host-contract.test.ts` -- expected: all pass.
- `npm run ci` -- expected: exit 0.

**Manual checks (if no CLI):**
- Isolated Gateway probe with the fake agent (`FAKE_CURSOR_USAGE` JSON 5.6M, model `fake-slow`): the session row's `totalTokens` is not 5.6M. Record if not run.

## Auto Run Result

- Summary: a Cursor turn's usage whose context reading (prompt buckets plus output, or total) exceeds the session's context ceiling now reaches OpenClaw without `total` and with `contextUsage: {state: "unavailable"}`, so the session row's `totalTokens` (Control UI tile, `cli_budget` compaction) takes no 5.6M reading from it; counts stay as reported. Ceiling: the model's window, else the largest listed window. Applies to both sources (ledger, ACP `usage`). Live cursor-agent 2026.10.22 uses the ledger.
- Files: `src/core/ports.ts` (marker, `CliSession.contextCeiling`); `src/core/usage.ts` (`boundTurnUsage`); `src/core/execute.ts` (bound before the result record); `src/core/events.ts` (marker to host `contextUsage`); `src/transports/acp/handshake.ts` (model ID the session runs); `src/transports/acp/session.ts` (`contextCeilingOf`, `contextCeiling`); `src/adapters/cursor/models.ts` (`cursorContextCeiling`); `src/adapters/cursor/index.ts` (wiring); `test/fixtures/fake-cursor-agent.mjs` (JSON `FAKE_CURSOR_USAGE`); tests in `src/core/{usage,events,execute}.test.ts`, `src/transports/acp/session.test.ts`, `src/adapters/cursor/{models,index}.test.ts`, `test/host-contract.test.ts`; `docs/providers/cursor.md` (Usage: meaning of the numbers, the tile; limitation); `CHANGELOG.md` (Fixed, #40); `MEMORY.md`.
- Review: 9 findings; 2 patched (1 medium, 1 low: adapter wiring test, no-choice handshake branch); 0 deferred; 7 rejected (2 low, 5 false) with reasons in the triage log.
- Follow-up review recommended: false (first pass; no high patched, one medium patched).
- Verification: focused vitest set passed; `npm run ci` exit 0 twice (1327 passed, 70 skipped; smoke `loaded`, `cursor-cli`); host probe and live ACP/ledger probe as in Implementation Notes.
- Residual risks: `contextUsage` is not in OpenClaw's public `CliBackendJsonlUsage` type (pinned by `test/host-contract.test.ts`); a summed turn under the ceiling still reads high; the Control UI render and a live tool-call turn were not run.

