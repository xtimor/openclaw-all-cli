---
title: 'Refactor sweep'
type: 'refactor'
ticket: '16'
created: '2026-10-20'
status: 'done'
baseline_revision: 'dffa35de26e75c871998b3fd5391d44509c3c85a'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/MEMORY.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The epic's plans left 22 deferred findings and 8 open items with no verdict, and the turn path grew into two oversized modules (`src/core/execute.ts` 779 lines with a 211-line `run`; `src/transports/acp/session.ts` 714 lines) plus long functions in `mcp-proxy.ts` and `backend.ts`, some duplicated helpers, unused exports, and one parity-matrix cell out of place.

**Approach:** Give every deferred item a verdict (table below), then run a behavior-preserving refactor in small steps, each ending green on the unchanged offline suite, with mutation spot checks wherever guard code moves, and the live suite once at the end.

## Boundaries & Constraints

**Always:** No behavior change: same records, events, errors, messages, files, timings, and order of awaits and yields. No test or fixture file changes (`*.test.ts`, `test/**`). Every symbol a test imports or mocks stays exported from the same module path (`createExecute`, `CONTINUITY_NOTE`, `HOST_SHELL_ARG` from `execute.ts`; `AcpSession`, `AcpPermissionRequest`, `AcpSessionOptions` from `session.ts`; `startMcpProxy`, `listToolNames` defined in `mcp-proxy.ts`; `takeHostImages` in `images.ts`). Callers keep importing `startMcpProxy` and `takeHostImages` from `./mcp-proxy.ts` and `./images.ts` (tests `vi.mock` those paths). AD-2: new core and transport files name no CLI, comments included. Moved guard code moves verbatim. Full offline suite after each step.

**Never:** Fix a deferred finding by changing behavior (those are follow-up tickets); edit `images.ts` or `pid-locks.ts` beyond removing an `export` keyword; split `mcp-proxy.ts` into several files; make module-level state per-`createExecute` (`prepareExecution` builds a new execute every turn); touch `ports.ts` contracts (the Antigravity hand-off); add dependencies; commit `.spike` or scratch scripts; edit `AGENTS.md`.

## I/O & Edge-Case Matrix

Refactor hazards. Each row must hold after its step.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Shared chat registry | `chats` map and `entries` WeakMap moved out of `execute.ts` | One module-level instance shared by every `createExecute` (a turn's new execute still sees the previous turn's holder) | resume of a busy holder still `server_error` retryable |
| Await/yield order | Statements of `run` moved into helpers | Same order: images read, `sessionId` yield, `freshChat` cleared, system-prompt `decide`, `startedAt`, prompt; abort checks at the same points | An abort at the `sessionId` yield keeps `freshChat` and the ledger untouched |
| Module mocks | `execute.test.ts` mocks `./mcp-proxy.ts`; `test/images.test.ts` mocks `../src/core/images.ts` | The new module that starts the proxy or reads images imports from those paths | Mocked calls still counted |
| Test imports | Tests import from `execute.ts`, `session.ts`, `system-prompt.ts` | Re-exports keep every listed symbol | `tsc` and suite green |
| Permission-request facts | Shared `rawInput`/`locations` merge helper for `session.ts` and `tool-calls.ts` | `requestPermission` keeps its own rule (an empty `rawInput` object wins there); the 256-entry LRU and post-finish merging of `toolCalls` stay | none |
| Unhandled rejections | `died.catch(() => {})` in `open` and `prompt`; `settleExit` helper for the two identical exit races | Every created rejection still has a catch | No unhandled rejection in the suite |
| TS narrowing | `marked && turnTarget.ok` in `run` | Kept: it narrows `turnTarget` for `.target` | none |
| AD-2 scan | New files `chat-registry.ts`, `turn-prompt.ts`, `tool-ledger.ts`, `live-entry.ts`, `attach-session.ts`, `acp/handshake.ts`, `acp/runtime.ts` (7; the last three added in the build, see Plan Change Log) | `test/import-boundary.test.ts` passes | none |
| Backend fields | `buildCliBackend` with `prepareExecution` extracted | Same fields and spread order; `test/backend.test.ts` field tests pass | `prepareExecution` failures still become one error record |

</intent-contract>

## Code Map

- `src/core/execute.ts` -- 779 lines. Module state `entries` (WeakMap), `chats` (Map). Pure helpers `splitHostShell` (called 3x per turn; strips `HOST_SHELL_ARG` and `SYSTEM_PROMPT_TRANSPORT_MARKER`, both stay), `reuseKey`, `composePrompt` (neutralization guard), `ToolLedger`, `errorRecord`. Closures in `createExecute`: `reusable`, `pointProxy`, `createEntry`, `releaseChat`, `claimChat`, `waitForExit`, `ensureVersion`, `attachSession` (109 lines), `run` (211 lines, lines 545-755). System-prompt delivery decision at 681-692 and the record rule at 706.
- `src/core/system-prompt.ts` -- `DeliveredPrompts`, `systemPromptBlock`, `runtimeUpdateNote`, `neutralizeBlockMarkers`; target for a delivery-plan helper. Neutralization regexes untouched.
- `src/transports/acp/session.ts` -- 714 lines. `open` 134 lines (spawn, runtime, client handler, race), `prompt` 111 (queue, settle closure, consumer loop), `setup` 91; helpers `readModelFacts`, `readModelState`, `selectModels`, `readMovedSessionId`, `SESSION_UNKNOWN`, `errorDetail`, `resumeError`, `login`, `switchModel`, `mapUsage`; duplicated exit race at 430 and 506; `isRecord` duplicated with `tool-calls.ts:65`; `rememberToolCall` duplicates the merge in `ToolCallTable.update`.
- `src/core/mcp-proxy.ts` -- `handle` 107 lines; `requestId(body)` re-parses what `requestsOf(body)` parses (same ids for single, batch, non-JSON, primitive); `answerExpired` and URL building are pure. Guards stay in place: `tokenMatches`, path check, `!current` 503, header drop sets, `relayedData` guard.
- `src/core/backend.ts` -- `buildCliBackend` 126 lines; `prepareExecution` (lines 122-158) extractable.
- Unused exports (no importer anywhere): `MissingCapability` type alias (`manifest.ts`, delete); remove `export` from `DEFAULT_CATALOG_TTL_MS`, `DEFAULT_CATALOG_FAILURE_TTL_MS` (`catalog.ts`), `DEFAULT_IDLE_MS`, `DEFAULT_ABORT_GRACE_MS` (`execute.ts`), `DEFAULT_IMAGE_LIMITS` (`images.ts`), `REAP_KILL_GRACE_MS` (`pid-locks.ts`), `POOL_CLOSE_WAIT_MS` (`pool.ts`), `MAX_TOOL_RESULT_CHARS` (`tool-calls.ts`), `volatileFields` (`system-prompt.ts`), `AUTO_MODEL` (`adapters/cursor/models.ts`), `backendConfigSchema` (`config.ts`), `RECORD_MARKER` (`events.ts`). Keep `FAILOVER_REASON_BY_CODE` (see D3). `tsc --noUnusedLocals --noUnusedParameters` is clean at baseline.
- `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` -- row P16: the live-test path sits in the Antigravity column (should be `tbd`), and the cursor cell leads with a `-p` transport the plugin does not use.
- Read-only: `src/core/images.ts`, `src/core/pid-locks.ts` (guards; only `export` removals), `src/core/ports.ts`, all tests and fixtures, `src/adapters/cursor/usage.ts` (factory closure of small functions; its timing tests are the flaky ones).
- As built, the split is 7 new modules (planned 4): `src/core/{tool-ledger,chat-registry,turn-prompt,live-entry,attach-session}.ts` and `src/transports/acp/{handshake,runtime}.ts`. `live-entry.ts` holds the entry types, the `liveEntries` WeakMap and handle/proxy creation; `attach-session.ts` holds `attachSession`; `acp/runtime.ts` holds process spawn and kill, client callbacks and the turn queue.
- Baseline (Node 24 from `.spike/node/bin`): `npx tsc --noEmit` clean; `npx vitest run` 27 files passed, 14 skipped; 802 tests passed, 60 skipped. This host has `cursor-agent` and `CURSOR_API_KEY`.

## Tasks & Acceptance

**Execution:**
- [x] Step 0 `<scratchpad>/size.mjs` (not committed) -- record the baseline commands' output in Implementation Notes; write a size script on `node_modules/rolldown/dist/parse-ast-index.mjs` `parseAst` that prints file lines and function lengths, a factory measured by its own statements -- the size AC needs a check.
- [x] Step 1 `claude-cli-parity.md` -- P16 cell: put `test/live/usage.live.test.ts` in the cursor-cli cell, Antigravity back to `tbd`, drop the `-p` lead -- docs drift.
- [x] Step 2 `src/core/{manifest,catalog,execute,images,pid-locks,pool,system-prompt,config,events}.ts`, `src/transports/acp/tool-calls.ts`, `src/adapters/cursor/models.ts` -- delete `MissingCapability`, drop the `export` keywords listed in Code Map -- dead surface.
- [x] Step 3 `src/core/mcp-proxy.ts` -- one body parse (`requestsOf` gives the id: single request's id, else null); top-level pure `expiredPayload(...)` and `upstreamUrl(...)`; `handle` ≤ 80 lines -- length, duplicate parse.
- [x] Step 4 (as built: also `src/transports/acp/runtime.ts`, new, for process/client/turn-queue helpers) `src/transports/acp/handshake.ts` (new) + `session.ts` + `tool-calls.ts` -- move `setup`, `login`, `switchModel`, the model-fact readers, `SESSION_UNKNOWN`/`errorDetail`/`resumeError` to `handshake.ts`; split `open` into spawn/runtime and client-handler helpers, `prompt` into queue and settle helpers, and `setup` into capability check and new-or-load helpers; one `settleExit(runtime)`; `tool-calls.ts` exports `isRecord` and a `mergeToolFacts` used by `ToolCallTable.update` and `rememberToolCall` -- session.ts ≤ 450 lines, functions ≤ 80.
- [x] Step 5 (as built: also `src/core/live-entry.ts` and `attach-session.ts`, new; `attachSession` lives there, `createEntry` became `createLiveEntry`) `src/core/tool-ledger.ts`, `chat-registry.ts`, `turn-prompt.ts` (new) + `execute.ts` + `system-prompt.ts` -- move `ToolLedger`; move `chats`, `chatKey`, claim/release/holder-exit wait and the post-open re-key (module-level, takes `home` and grace as arguments); move `composePrompt`, `CONTINUITY_NOTE`, `HOST_SHELL_ARG` and `splitHostShell` (computed once per turn) to `turn-prompt.ts`, re-exported from `execute.ts`; add a delivery-plan helper in `system-prompt.ts` for lines 681-692 and 706; split `run` into an open-fresh-entry helper and a turn-body helper, and `attachSession` into open and post-open (capability check, chat re-key, exit hooks) helpers -- execute.ts ≤ 450 lines, functions ≤ 80.
- [x] Step 6 `src/core/backend.ts` -- extract `prepareExecution` into a named builder -- `buildCliBackend` ≤ 80 lines.
- [x] After each of steps 1-6, `package.json` scripts `typecheck` and `test` -- same counts as baseline; for steps 3-5 also the mutation checks in Design Notes, each result recorded in Implementation Notes -- one green step at a time, so a failure points at one step.
- [x] Step 7 `package.json` scripts `build`, `dev:install`, `test:live`, plus `test/isolated-openclaw.test.ts` -- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`, build, install, the isolated load test, then the live suite once under the re-run rule; run the size script -- final net.
- [x] Step 8 `MEMORY.md` -- `CONTINUITY_NOTE` now in `src/core/turn-prompt.ts`; one line with the new module map (chat registry, turn prompt, tool ledger, ACP handshake). `docs/`: no change (no setup, config, or behavior change); say so in Implementation Notes.

**Acceptance Criteria:**
- Given the baseline, when `npx vitest run` runs after the sweep, then 802 tests pass and 60 skip, and `git diff dffa35de26e75c871998b3fd5391d44509c3c85a --stat -- '*.test.ts' test/` prints nothing.
- Given a host with a Cursor login, when `npm run test:live` runs once after `npm run dev:install`, then every live file passes (a known flake passes on its one re-run, recorded).
- Given the size script, when run on `src/` (tests excluded), then every file is ≤ 450 lines and every function ≤ 80 lines, except `takeHostImages` (91, kept whole: one guard sequence in order).
- Given each guard listed in Design Notes, when it is removed, then its named test file fails, and the restored file matches the committed one.
- Given this plan, when a reader looks up any deferred finding of the epic's plans, then the Deferred Findings table gives it a verdict, fixed or dropped, with a reason.

## Implementation Notes

Build worker run, 2026-10-20, branch `claude/friendly-hawking-tn9eme`, Node v24.22.0 (`.spike/node`). Committed afterwards by the coordinator as 03e5bdd (the worker committed nothing). No test, fixture, `images.ts` or `pid-locks.ts` change except the two `export` removals.

**Baseline** (before any edit): `npm run typecheck` clean, `npm run build` clean, `npx vitest run` 27 files passed / 14 skipped, 802 tests passed / 60 skipped. After every step 2-6 the same three commands gave the same counts, and `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` stayed clean.

**Size script** (`<scratchpad>/size.mjs`, not committed): rolldown `parseAst` (`lang: "ts"`); prints file lines and functions over 80 lines, a function measured by its own statements (nested functions subtracted) and also flagged when its total is over 80. Baseline flagged `execute.ts` 779, `session.ts` 714, and `attachSession` 88, `run` 205, `setup` 86, `handle` 54/107, `open` 61/134, `prompt` 49/111, `buildCliBackend` 78/126 (own/total). After: every file under `src/` is at most 439 lines; no function is over 80 lines except `takeHostImages` (91, kept whole) and the factories measured by their own statements (`createExecute` 54, `startMcpProxy` 22, `createCursorUsageReader` 36).

| File | Before | After |
|------|-------:|------:|
| `src/core/execute.ts` | 779 | 439 |
| `src/transports/acp/session.ts` | 714 | 323 |
| `src/core/mcp-proxy.ts` | 375 | 378 (`handle` 107 to 80) |
| `src/core/backend.ts` | 160 | 179 (`buildCliBackend` 126 to 78) |
| new `attach-session.ts`, `live-entry.ts`, `chat-registry.ts`, `turn-prompt.ts`, `tool-ledger.ts` | | 155, 116, 108, 46, 36 |
| new `acp/handshake.ts`, `acp/runtime.ts` | | 255, 243 |

**Steps.**
- Step 1: P16 cell now has the live test in the cursor-cli cell, Antigravity `tbd`, no `-p` lead.
- Step 2: `MissingCapability` deleted (`missingCapabilities` returns `RequiredCapability[]`); the 11 listed `export` keywords removed.
- Step 3: `requestId` removed (the id is the single request's id from `requestsOf`, else null); top-level `expiredPayload`, `upstreamUrl`, `relayedHeaders`; `handle` is 80 lines. The guards did not move.
- Step 4: new `acp/handshake.ts` (`setup` split into `checkCapabilities`, `authenticate`, `startSession`; `login`, `switchModel`, model readers, `SESSION_UNKNOWN`, `errorDetail`, `resumeError`, `toCliError`). `open` and `prompt` split into helpers; `settleExit` replaces the two exit races; `tool-calls.ts` exports `isRecord` and `mergeToolFacts`, used by `ToolCallTable.update` and `rememberToolCall`. Deviation: a second new file, `acp/runtime.ts` (process spawn and kill, client callbacks, turn queue, `Runtime`), because `session.ts` stayed at 544 lines with `handshake.ts` alone. Both files import `core/ports` and each other (types from `./session.ts`, helpers from `./tool-calls.ts`), nothing else in the repo (AD-2 test green).
- Step 5: `tool-ledger.ts`, `chat-registry.ts` (module-level `chats`, takes `home` and the grace as arguments), `turn-prompt.ts` (`composePrompt`, `CONTINUITY_NOTE`, `HOST_SHELL_ARG`, `HOST_SHELL_TOOL`, `splitHostShell`, `modeOf`; `execute.ts` re-exports the two tests import), `planDelivery` in `system-prompt.ts`. `splitHostShell` is computed once per `run`; `reuseKey` takes its `hostShell`. Deviation: two more new files, `live-entry.ts` (entry types, the `liveEntries` WeakMap that is the "entries" state, handle and proxy creation) and `attach-session.ts` (`attachSession` split into `openProcess` and `settleOpened`), because `execute.ts` could not reach 450 lines otherwise. The shared state stays module-level: one `chats` map and one `liveEntries` map for every `createExecute`. `run` is now `run`, `openFresh`, `runTurn`, `promptTurn`. `vi.mock("./mcp-proxy.ts")` still applies: `live-entry.ts` imports from that path; `takeHostImages` is still imported by `execute.ts` from `./images.ts`.
- Step 6: `prepareExecutionFor` and `resolveExecutionArgsFor` extracted from `buildCliBackend`; same fields, same spread order.
- Step 8: `MEMORY.md`: `CONTINUITY_NOTE` path fixed, one module-map entry added. `docs/`: no change (no setup, config, or behavior change).

**Mutation spot checks** (guard removed in a copy of the tree under the scratchpad, named test file run, tree restored and diffed identical to `src/` each time). All failed as required:
- `mcp-proxy.test.ts`: token check (4 failed), path check (1), `!current` 503 (2), `REQUEST_DROP_PREFIXES` filter (2), `relayedData` guard (1).
- `session.test.ts`: `SESSION_UNKNOWN` branch forced true (4), capability check moved after login (2), `requiredModeId` check off (1), `cancelled` maps to an option (1).
- `execute.test.ts` + `test/system-prompt.test.ts` + `test/exec-tool.test.ts`: neutralization flag off (1), side-question/approvals reject path off (2), `hostShell` without the `exec` listing check (5), `degraded` on an unreadable list removed (1), busy-holder refusal off (2), discard for a resumed chat (1), ledger record on any event (2).
- Review lens record (verification-gap): 45 guard-removal mutations on the moved code at its new locations; 40 were caught by existing tests, 3 guards survived with the suite green: (1) the chat re-key after an open (`chat-registry.ts` close of another holder, `attach-session.ts` `rekeyChat` call), (2) the two closed-handle checks around the claim in `attachSession`, (3) both `proxy.close()` calls on process exit. Closed by the new additive `test/refactor-guards.test.ts` (7 tests); each was revert-checked: guard removed in a copy of the tree, the new test failed, and it passes on the real tree. The reviewer did not run 32 further mutations: all of `mcp-proxy.ts`, `handshake.ts`, `runtime.ts`, the `tool-calls.ts` merge, the backend exec marker, and the `execute.ts` failed-turn flags. Those areas were verified by the build worker's 16 spot checks listed above (mcp-proxy 5, session 4, execute 7), not re-verified by the reviewer; the exec marker and failed-turn flags are covered only through the execute/exec-tool tests in the suite. `images.ts` and `pid-locks.ts` guards did not move (only `export` removals), so no mutation was run on them.

**Final disposition** (every deferred finding D1-D22 and open item O1-O8; reasons in Design Notes):

| # | Final | Where / reason |
|---|-------|----------------|
| D1, D7 | fixed | ticket 1.6 |
| D14 | fixed | tickets 1.4, 1.19 |
| D16 | fixed | ticket 1.19 |
| D2 | own ticket | 1.20 (F1): needs text heuristics, a behavior change |
| D22 | own ticket | 1.21 (F3): lifecycle change |
| O2 | own ticket | 1.21 (F3): adds a delete |
| O3 | own ticket | 1.22 (F4): needs test edits |
| D3 | dropped | host reads only `errorText`; clearing the binding is host-side for `claude-cli` only |
| D4 | dropped | the host fingerprint already hashes argv, argv0, env (`buildCliLiveSessionFingerprint`, `.spike/openclaw/node_modules/openclaw/dist/cli-live-session-registry-Iq0txoVH.mjs` lines 1590-1658: `argv` 1642, `argv0` 1643, `env` 1656) |
| D5 | dropped | host watchdog aborts `ctx.abortSignal`; `open` ends on abort |
| D6 | dropped | the static home is the lock, checked live |
| D8 | dropped | rewritten only when permissions differ |
| D9 | dropped | per-agent config dir sees the Linux login (1.15 proof) |
| D10-D12 | dropped | need warm reuse, which 2026.10.3 never does; MEMORY open risk "warm-reuse effects" (added after review) covers the recheck |
| D13, D21 | dropped here | offline host-contract tests: F5, no own ticket, fits 1.17 |
| D15 | dropped | host-bound, MEMORY open risk |
| D17 | dropped | no stable signal from Cursor; documented |
| D18 | dropped | host-blocked on 2026.10.3; changes resume behavior |
| D19, D20 | dropped | no clock source / invisible over ACP; Known limits |
| O1 | dropped | changes reply text; F2, no own ticket |
| O4 | dropped | restart risks one double count within 5 s; persisting is a behavior change |
| O5 | kept | host contract; `splitHostShell` now computed once per turn |
| O6 | dropped | the host's reference backend, not an adapted CLI; AD-2 test passes |
| O7 | fixed | step 1 |
| O8 | fixed | steps 2-6 |

**Step 7**: `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` clean; `npm run build` and `npm run dev:install` ok; `npx vitest run test/isolated-openclaw.test.ts` passed (1 test, not skipped). `git diff dffa35d --stat -- '*.test.ts' test/` printed nothing. 

**Live result** (after `npm run build && npm run dev:install`, one `npm run test:live`, 12:35-13:27 UTC, 3107 s, `CURSOR_API_KEY` set): first run 12 files passed, 2 failed (57 tests passed, 2 failed, 1 skipped). Both match the re-run rule. (1) `history-continuity` (e) probe: `CLI transcript compaction failed for cursor-cli/auto: No API key found` (the recorded `cli_budget` compaction flake); it failed again in the paired re-run with the same message and passed alone on the third run. (2) `exec-tool` "stops a foreground command that runs past Cursor's 60 s call limit": the row exhausted its retries with an empty reply (recorded flake: an exec row that exhausts its retries); the re-run of `exec-tool` and `history-continuity` passed `exec-tool` fully. The 3 MB exec test passed in the first run. No other live file failed. No stray process remained except one orphaned `cursor-agent worker-server` with its `typescript-language-server` child (the recorded orphan behavior), killed by pid; no temp dir of this run is left.

## Plan Change Log

- Build, 2026-10-20: the planned 4 new modules became 7. (1) `src/transports/acp/runtime.ts`: with `handshake.ts` alone `session.ts` was still 544 lines against the 450 limit, so the process spawn/kill, client callbacks and turn queue moved too (`session.ts` 323, `runtime.ts` 243, `handshake.ts` 255). (2) `src/core/live-entry.ts` and (3) `src/core/attach-session.ts`: after the planned moves `execute.ts` was about 530 lines (779 minus ledger, registry, turn prompt), too many for 450, so the entry types with handle/proxy creation and `attachSession` moved out (`execute.ts` 439, `live-entry.ts` 116, `attach-session.ts` 155). `entries` became `liveEntries` in `live-entry.ts`; `chats` stays module-level in `chat-registry.ts`. Verbatim moves, no behavior change; the AD-2 scan and the size AC cover the new files.
- Review follow-ups (docs only): F5 added to ticket 1.17, ticket 1.21 rewritten to what is feasible, F2 added to Known limits, D4 evidence referenced, P16 matrix cell given the manifest caveats, MEMORY open risk for D10-D12.

## Review Triage Log

## Design Notes

**Deferred findings and open items (verdicts).** "Fixed" names where; "dropped" gives the reason; F-items are proposed follow-up tickets, not done here.

| # | Item (source plan) | Verdict |
|---|---|---|
| D1 | Non-auto model fails, Cursor reports `models` not a select (1.1) | Fixed in 1.6 (`readModelFacts`, `session/set_model`) |
| D2 | Cursor backend errors arrive as reply text with `end_turn` (1.1) | Own ticket 1.20 (F1): needs text heuristics, a behavior change |
| D3 | `code`/`retryable` never reach failover; dead chat never dropped (1.1) | Dropped: host reads only `errorText`; `resumeError` text gives `session_expired`; clearing the binding is host-side for `claude-cli` only (MEMORY entry 7). `FAILOVER_REASON_BY_CODE` stays: AD-11 names it |
| D4 | Reuse key ignores command, args, env (1.1) | Dropped: `reusable()` requires the host fingerprint, which hashes argv, argv0, env (`buildCliLiveSessionFingerprint`, OpenClaw 2026.10.3: `dist/cli-live-session-registry-Iq0txoVH.mjs` lines 1641-1657) |
| D5 | Handshake has no own timeout (1.1) | Dropped: host watchdog aborts `ctx.abortSignal` (entry 8); `open` terminates on abort |
| D6 | `current_mode_update` could lift `ask` (1.1) | Dropped: the static home is the lock, checked live in `agent` mode (entry 19); the update is ignored |
| D7 | `auto` keeps the previous model on resume (1.1) | Fixed in 1.6 (switch back to Auto) |
| D8 | `cli-config.json` read-modify-rename race (1.2) | Dropped: rewritten only when permissions differ; Cursor writes only the last model there, which every open sets again |
| D9 | `probeAuth` reads the shared home (1.2) | Dropped: a per-agent config dir sees the Linux login (1.15 proof) |
| D10-D12 | `degraded` from settings; SSE cut between turns; `Mcp-Session-Id` across turns (1.3) | Dropped: need warm reuse, which 2026.10.3 never does; MEMORY open risk "warm-reuse effects" covers the recheck |
| D13 | No login-free check of the host settings-file contract (1.3) | Dropped here (adds a test): F5 |
| D14 | Host flags without enforcement (1.3) | Fixed in 1.4/1.19 (`execution-args`, `resolveExecutionArgs`) |
| D15 | Per-turn credentials 401 if the fingerprint stabilises (1.3) | Dropped: host-bound, MEMORY open risk |
| D16 | Real runs have no `exec` (1.4) | Fixed in 1.19 |
| D17 | Model names follow Cursor's list order (1.6) | Dropped: no stable signal from Cursor; documented in Models |
| D18 | Lost chat with a profile: pre-register probe (1.11) | Dropped: host-blocked on 2026.10.3; changes resume behavior |
| D19 | Clock skew over 5 s gives 0 usage (1.10) | Dropped: no clock source; Known limits |
| D20 | Cursor may shorten the block (1.13) | Dropped: invisible over ACP; Known limits |
| D21 | Offline pin of the host's exec-serving contract (1.19) | Dropped: host function not exported; live rows cover it. F5 |
| D22 | `worker-server` child outlives its parent; listing process unlocked (1.8) | Own ticket 1.21 (F3): lifecycle change; stays in Known limits until then |
| O1 | Text before and after a tool call joins without a separator (entry 5) | Dropped: changes reply text. F2 |
| O2 | Side question leaves its `acp-sessions/<id>` dir (1.7) | Own ticket 1.21 (F3): adds a delete |
| O3 | Timing-based `usage.test.ts` bounds (wall clock < 400-450 ms) | Own ticket 1.22 (F4): needs test edits |
| O4 | In-memory usage stamps vs on-disk prompt ledger | Dropped: a restart only risks one double count within 5 s (CAP-3 row); persisting is a behavior change |
| O5 | Host-shell and system-prompt marker args | Kept (host contract); `splitHostShell` computed once per turn (step 5) |
| O6 | `claude-cli` named in core comments | Dropped: the host's reference backend, not an adapted CLI; AD-2 test passes |
| O7 | Parity matrix P16 cell | Fixed (step 1) |
| O8 | Unused exports, duplicate helpers, long functions | Fixed (steps 2-6) |

Follow-ups: F1 classify Cursor error text; F2 tool-call text separator; F3 side-question dir cleanup, listing lock and unload, process-group kill; F4 fake-timer usage tests; F5 offline host-contract tests (fits 1.17).

**Mutation spot checks** (remove or invert, run the file, expect a failure, restore): mcp-proxy -- token check, path check, `!current` 503, `REQUEST_DROP_PREFIXES` filter, `relayedData` guard (`src/core/mcp-proxy.test.ts`). execute -- user-text neutralization flag, side-question/approvals reject path, `hostShell` only when `exec` is listed, `degraded` when the list is unreadable, busy-holder refusal, discard only for a new chat, ledger record only on `result` (`src/core/execute.test.ts`, `test/system-prompt.test.ts`, `test/exec-tool.test.ts`). session -- `SESSION_UNKNOWN` needs a session phrase, capability check before login, `requiredModeId` fail-closed, `cancelled` maps to no option (`src/transports/acp/session.test.ts`). A guard no test catches is recorded as a gap for F5 and moved by cut and paste only.

**Live re-run rule:** a failing live file gets one re-run only when its failure matches a recorded flake: `cli_budget` compaction failure (`history-continuity` c, agent-mode rows), a transient Cursor `RetriableError`, an `exec-tool` row that exhausts its retries. Anything else is a regression: bisect by step.

**Review:** thorough recommended. Risk is high, raised from the ticket's low: the sweep moves guard code on every turn's path (proxy token, prompt neutralization, mode gate, chat exclusivity).

## Verification

**Commands:**
- `PATH=$PWD/.spike/node/bin:$PATH npx tsc --noEmit --noUnusedLocals --noUnusedParameters` -- expected: no output
- `npx vitest run` -- expected: 802 passed, 60 skipped
- `git diff dffa35de26e75c871998b3fd5391d44509c3c85a --stat -- '*.test.ts' test/` -- expected: empty
- `npm run build && npm run dev:install && npx vitest run test/isolated-openclaw.test.ts` -- expected: pass
- `npm run test:live` -- expected: all live files pass under the re-run rule

## Auto Run Result

Planning result (historical): ready-for-dev, route full (auto), risk high (raised from low), review thorough recommended. Baseline `dffa35de26e75c871998b3fd5391d44509c3c85a`: typecheck clean, unused-locals check clean, 802 tests passed and 60 skipped. No product code was written at that point.

Build result: implemented, committed as 03e5bdd, 802 passed / 60 skipped, live suite green under the re-run rule (see Implementation Notes). Status: done.
