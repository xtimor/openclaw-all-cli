---
title: 'Gateway scenarios for past turn, process, and prompt bugs'
type: 'feature'
ticket: '3'
created: '2026-11-27'
status: done
baseline_revision: '59645a0e921b9afea65c5d2739223ab4fa904f59'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'auto'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The past turn-level bugs are guarded only by unit tests against the plugin's own model of the host (`reproduces = false` in `test/regression/ledger.toml`), which is how #40 came back as #97 and #76 left #102 open. Each needs a test that recreates its original conditions through a real Gateway with the packed plugin.

**Approach:** Add Gateway-tier scenario files under `test/regression/gateway/` on the ticket 4.2 harness, one `describeRegression` per bug (or family), each recreating the bug's conditions with `fake-cursor-agent` and asserting on what the Gateway returns and what the CLI received; prove each red by reverting its fix in a scratch copy; record each in the ledger as `tier = "gateway", reproduces = true` and drop `4.3` from its `planned`.

## Boundaries & Constraints

**Always:** one shared Gateway per file at most (start/stop in hooks; the 4.2 `onStarted` stop pattern); fresh session ids per test; every assertion message carries the evidence (CLI output, fake log lines, frames); each scenario passes on OpenClaw 2026.10.3 and 2026.11.10 (`scripts/regression.sh gateway` and `--openclaw latest`), or the test states which host versions it applies to with the reason; the whole tier stays under about 10 minutes per version; English.

**Never:** change `src/` (a scenario that is red on main is a new bug: stop and report it, do not fix it here); real `cursor-agent` or a key; a scenario for #102 (its fix ticket adds it); weaken an assertion to get green; touch `.spike/`.

## I/O & Edge-Case Matrix

| Scenario | Conditions recreated | Expected (green on main) | Red when |
|----------|---------------------|--------------------------|----------|
| #11/#38 warm process | two `openclaw agent` turns on one session through the Gateway, catalog loaded | the fake log shows one `initialize` for both turns (one process), the second turn has no `session/new` or `session/load` | the per-turn restart is back (settings file path in the env, see backlog bug "15-20 s…") |
| #12/#46 context windows | the fake reports several models with different windows and a `context=1m` variant (`FAKE_CURSOR_*` model knobs; add one if missing) | the Gateway's model list (`models.list`/`models list --json`) gives each `cursor-cli/*` row its own window and no 1M row the ACP refuses | all rows share one window, or a 1M row is offered |
| #13 one reply | one `chat.send` turn | the session transcript (`chat.history` or the session file) holds exactly one assistant row with the reply, and exactly one `chat` final frame | the reply is stored or sent twice |
| #14 one backend | Gateway start with the plugin | the Gateway log has no `already registered` line for `cursor-cli` and `plugins inspect --runtime --json` lists `cursor-cli` once | the clash is back |
| #40/#97 usage | three turns with `FAKE_CURSOR_USAGE=<json>` per turn (a tool-heavy turn's summed usage, then a plain turn), model with a known window | the session's context reading (what `sessions.list` / the session store gives the Control UI tile) never exceeds the window and never goes down between turns | the summed usage is read as context size, or the reading falls |
| #67 empty native selection | an agent whose tool policy leaves no native tool (the restricted profile) | the turn runs and the agent home's `profiles/restricted/cli-config.json` is used, no refusal | every run is refused |
| #74 no leftover process | a chat ends (session reset/delete through the Gateway, `sessions.reset` or `/new`) | the fake process of that chat exits within the pool's timeout; no `acp` fake left for it | the pool keeps it alive |
| #76 shell note | a turn where the host serves `exec` (agent mode) | the prompt the fake receives contains the native-shell-disabled note naming OpenClaw `exec` (text from `src/core/turn-prompt.ts` `shellNote`), and `session/set_mode` is `agent` | the note is missing |
| #99 throttle | the fake answers the prompt with Cursor's `resource_exhausted` throttle error (`[[error]]` or a new knob) | the Gateway's reply/error says a temporary limit and is retryable, not that the plan quota is spent | the throttle reads as a spent quota |

</intent-contract>

## Code Map

- `test/regression/harness.ts`, `test/regression/gateway/tracer.regression.test.ts` -- the 4.2 harness and its patterns (`fakeCommand`, `configure`, `startRegressionGateway` with `onStarted`, `gatewayAgentTurn`, `chatSend`, `readFakeLog`, `promptText`, `liveFakes`/`killFakes`); extend it with small shared helpers only when two scenarios need them.
- `test/fixtures/fake-cursor-agent.mjs` -- knobs in its header (`FAKE_CURSOR_USAGE`, `FAKE_CURSOR_DEFAULT_MODEL`, `FAKE_CURSOR_MODEL_SURFACE`, `[[error]]`, `[[updates]]`, `FAKE_CURSOR_START_MODE`, `FAKE_CURSOR_LOG_END`); add a knob only when a row needs one, documented in the header like the others; existing unit tests that use the fake must stay green.
- `test/regression/ledger.toml` + `test/regression/ledger.ts` -- add the new gateway tests to #11, #12, #13, #14, #38, #40, #46, #67, #74, #76, #97, #99 with `tier = "gateway", reproduces = true`; remove `4.3` from their `planned` (keep other tickets listed there).
- Per-bug context (conditions, fix, and the unit tests already pinning them): the backlog bug files and plans under `_bmad-output/backlog/` (`bug-15-20-s-to-first-token…`, `bug-cursor-cli-models-all-report-the-same-128k…`, `bug-1m-context-variants…`, `bug-webchat-shows-the-assistant-reply-twice…`, `bug-explain-a-cursor-cli-backend-id-clash…`, `bug-context-usage-tile-shows-totaltokens…`, `bug-context-usage-tile-moves-down…`, `bug-cursor-cli-refuses-every-run-with-an-empty-native-selection…`, `bug-a-finished-conversation-leaves-its-cursor-agent-running…`, `bug-a-denied-native-shell-call…`, `bug-transient-cursor-throttle…`), `MEMORY.md` (facts per issue), and `git log --grep '#<n>'`.
- Host surfaces for asserting: `openclaw gateway call <method> --port <p> --json` (`models.list`, `sessions.list`, `chat.history`), the Gateway log, the agent home under the regression state (`state/agents/<id>/agent/openclaw-all-cli/cursor-cli/`).
- Mutation proof: for each row, in a scratch copy of the repo (outside `.regression/` of the main checkout; `git worktree add` under the scratchpad), revert the fix (the smallest edit that brings the bug back), run `scripts/regression.sh gateway` there, and record red/green per scenario in Implementation Notes. A row whose fix cannot be reverted in isolation records why and what edit was used instead.

## Tasks & Acceptance

**Execution:**
- [x] `test/regression/gateway/*.regression.test.ts` -- new scenario files covering every matrix row (group by family where they share a Gateway setup)
- [x] `test/fixtures/fake-cursor-agent.mjs` -- only the knobs the rows need
- [x] `test/regression/harness.ts` -- only shared helpers the rows need
- [x] `test/regression/ledger.toml` -- the entries above
- [x] the plan's Implementation Notes -- per row: the mutation used and red/green on 2026.10.3, and green on 2026.11.10

**Acceptance Criteria:**
- Given main, when `scripts/regression.sh gateway` and `scripts/regression.sh gateway --openclaw latest` run, then every scenario passes (or is skipped on a version with a stated reason) and the tier finishes in about 10 minutes or less per version.
- Given each row's fix reverted in a scratch copy, when the tier runs there, then that row's scenario fails.
- Given `npm test`, when it runs, then the ledger check passes with the new gateway tests and the scenario files are skipped.
- Given a run ends, when it is over, then no Gateway or fake process from it is left.

## Implementation Notes

**Files.** Four scenario files, one Gateway each: `test/regression/gateway/turn-process.regression.test.ts` (#11/#38, #74, #67), `reply-prompt.regression.test.ts` (#13, #76, #99), `context-usage.regression.test.ts` (#12/#46, #40/#97), `backend-registration.regression.test.ts` (#14). Fake knobs (header documented, unit tests green): `FAKE_CURSOR_MODELS=<json>` (replaces the model list), prompt `[[usage:<json>]]` (per-turn ACP usage; the last one in the prompt counts), prompt `[[error-json:<json string>]]` (an exact error chunk; `[[error]]` takes the rest of the prompt, which OpenClaw extends with its own lines). The fake now logs `pid` on every line (a `worker` line keeps the worker's). Harness: `gatewayCall`, `gatewayLog` (+ `logFile` on `startRegressionGateway`, and on `startGateway` in `test/live/harness.ts`, which now can write the Gateway's console log to a file), `chatPids` (the processes a prompt reached, by a marker in its text) and `linesOf` (one process's lines), `fakeAlive`, `finishRegression` (kills the fakes and removes the temp dir even when the stop throws), `chatMessageText`. Ledger: one gateway test (`reproduces = true`) on each of #11, #12, #13, #14, #38, #40, #46, #67, #74, #76, #97, #99; `4.3` removed from `planned` (#38, #76 keep `4.5`; #40, #97 keep `4.6`).

**How each row recreates its conditions** (all through a real Gateway with the packed plugin):
- #11/#38: two `openclaw agent` turns of one session after the catalog loaded; both prompts reached one process (`chatPids`), which has one `initialize` and one `session/new`; no process in the window got a `session/load`; both prompts on one Cursor chat; one `cli live session start` in the Gateway log.
- #12/#46: `FAKE_CURSOR_MODELS` with a Cursor-shaped listing (own `context=` values, a family row with none, unknown rows, Opus 5.5 as its 300k row, and the matrix's `context=1m` variant of Opus 5.5 listed after it); `models.list` rows carry 256000/300000/300000/200000 and 1000000 for the listed 1M row (`claude-opus-5-5-1m-medium-false`, its own model, #46's settled behavior for a listed 1M ID), the 300k row keeps the bare name, unknown rows get the host's 128000, the returned rows carry more than one window, and the only row with a 1M window or name is the listed one (no 1M row the ACP did not list, which is the kind it refuses). Skipped on 2026.11.10 (stated in the test): offline it lists no model for any provider.
- #13: `chat.send`; exactly one `final` frame with the reply once, and `chat.history` holds one assistant row with the reply once (and no other non-user row with it).
- #14: first one `openclaw agent` turn on `cursor-cli/auto` through the Gateway, and the Gateway console log must show its `cli live session start` line (the log is one in which the plugin loaded and its backend ran); then that log has no `already registered`; `plugins inspect openclaw-all-cli --runtime --json` lists `cursor-cli` once as cli backend and has no error diagnostic.
- #40, #97: `cursor-cli/grok-4.7` (256k window) and three turns each with its own `[[usage]]`: plain, then summed tool-heavy (5.6M, #40) or within-window tool-heavy (100k reading, #97), then plain. Each turn ran on `grok-4.7[context=256k,...]` (the last model switch its chat got before its prompt, asserted). The session's `totalTokens` (`sessions.list`) must stay within 256000 and never fall. A withheld reading shows as no `totalTokens` (`totalTokensFresh: false`), which the test counts as no reading. A reading near the window makes 2026.10.3 run `cli_budget` compaction, which fails the turn without an API key, so #97's high is 100k, not 200k.
- #67: an automation with a tool allow-list (`cron add --tools sessions_history`, `cron run --wait`) is a run with an empty native selection on both versions (`tools.fs.workspaceOnly` gives none on 2026.10.3); the job is removed again (`cron rm` in a finally, so it does not stay in the tier's shared state); the run succeeds, the process its prompt reached opens with `CURSOR_CONFIG_DIR=<agent home>/profiles/restricted`, and that `cli-config.json` denies `Read(*)`.
- #74: two chats, each chat's process being the one its prompt reached; `sessions.reset` of one; its process exits within 20 s (the pool's own idle close is 15 min), the other chat's keeps running.
- #76: sessions start in `ask` (`FAKE_CURSOR_START_MODE`); an `openclaw agent` turn's prompt contains `shellNote(true)` (imported from `src/core/turn-prompt.ts`) and the fake logs one `session/set_mode` `agent`.
- #99: `chat.send` with Cursor's `RetriableError: [resource_exhausted]` text; one `error` frame with `errorKind: "rate_limit"` and an `errorMessage` that says "temporary rate limit" and not usage limit, quota, or plan.

**Facts the build found.** Without `FAKE_CURSOR_STORE` every fake process names its first chat `fake-session-1`, and the plugin's chat registry closes the earlier process holding that ID (`rekeyChat`): every new file uses a store. The shim records the pid of every run, probes included, and the catalog's model listing (60 s cache) opens real ACP processes with `initialize` and `session/new` at any time, so a chat's process is the one its `session/prompt` reached (review patch 1), never an `initialize` or `session/new` count.

**New bug, not fixed here (stop-and-report rule):** on OpenClaw 2026.10.3, when the config has a second agent in `agents.entries` (even `{}`), `sessions.reset` releases no process: the #74 scenario goes red on main (scratch copy, fresh state: green with only `main`, red after `config set agents.entries.second '{}'`; 2026.11.10 stays green with the second agent). A probe of the installed plugin showed the `session_end` hook running in another captured plugin build (`state/tmp/plugin-captures/.../openclaw-plugin-build-*`) whose pool was empty. The tier's default config has only `main`, so the scenario is green there; no scenario adds an agent (config outlives a file). Needs its own bug ticket.

**Mutation proof** (scratch `git worktree` under the session scratchpad with this change applied, `scripts/regression.sh gateway` per mutation, fresh state each run; script `mutate.py` there):

| Row | Mutation (smallest edit that brings the bug back) | 2026.10.3 | Others red in the same run |
|-----|------|------|------|
| #11/#38 | `backend.ts` `bundleMcpMode` back to `gemini-system-settings` | red (re-run after review: the session's two prompts reached two processes, the second with `session/load`) | #97 (the high is per warm process and the process restarts each turn), #76 (no MCP config path in the args, so no tool list and no note), and after review #74 (its precondition: the ended chat's process was already gone before the reset, as each new live session replaced the last) |
| #12 | `catalog.ts` drops `contextWindow` from the row | red (re-run after review: `grok-4.7` has no 256000) | none |
| #46 | no code fix exists (Cursor refuses 1M over ACP); mutation: `buildCursorCatalog` adds a 1M sibling for each row with a `context=` value | red (re-run after review, with the listed 1M row: unlisted `claude-opus-5-5-1m`, `fake-mini-1m`, `grok-4.7-1m` at 1000000 beside the listed `claude-opus-5-5-1m-medium-false`) | none |
| #13 | no code fix exists (closed not_planned); mutation: `parseJsonlEvent` streams the result text again before the result (what the report blamed) | red (final frame holds the reply twice) | tracer `chat.send` (same symptom) |
| #14 | `register.ts` registers the backend twice | red (re-run after review: the turn passed and its `cli live session start` line was there, then the Gateway-log check went red on `cli backend already registered: cursor-cli (openclaw-all-cli)`, before `plugins inspect` ran) | none |
| #40 | `usage.ts` drops the ceiling check | red | none |
| #97 | `usage.ts` ignores the highest accepted reading | red | none |
| #67 | `permissions.ts` drops the restricted-profile branch | red (re-run after review: `cron run` exit 1; the job was removed) | none |
| #74 | `register.ts` hook no longer calls `releaseConversation` | red (re-run after review: the ended chat's process alive 20 s after `sessions.reset`; also red on 2026.11.10 after review) | none |
| #76 | `execute.ts` never sets `shellNote` | red | none |
| #99 | `errors.ts` maps `resource_exhausted` to the plan-exhaustion failure | red | none |

On main every scenario is green on 2026.10.3 and 2026.11.10 (#12/#46 skipped on 2026.11.10 with its reason); see Verification. #74 on 2026.10.3 on main with the default config: green (scratch run with no skip, 296 s tier).

## Plan Change Log

- 2026-11-27, review of 0418703: #12/#46 had left out the matrix's `context=1m` variant (the first build listed Opus 5.5 only as its 300k row, as real Cursor does). It is now listed; what it must give is #46's settled behavior for a 1M ID the ACP lists (its own model with a 1,000,000 window, the 300k row unchanged), and "no 1M row the ACP refuses" is checked as no 1M row the listing did not have. The test title changed accordingly (ledger updated). No other change to the contract.

## Review Triage Log

Review of 0418703 (coordinator, 2026-11-27): 8 patches applied, 1 deferred, 0 rejected.

| # | Finding | Decision | What changed |
|---|---------|----------|--------------|
| 1 | Model-listing ACP processes (catalog, 60 s cache: `initialize`, `session/new`) can be counted as chat processes in #11/#38, #74, #67 | patch | fake logs `pid` on every line; `chatPids(lines, marker)` (processes a prompt with the marker reached) and `linesOf` replace `acpPids`; #11/#38 counts `initialize`/`session/new` on the chat's process only, `session/load` over all; #74 and #67 take each chat's process by its prompt; #76 reads `session/set_mode` on its chat's process only |
| 2 | #14 trusted the absence of `already registered` in any non-empty log | patch | one turn on the backend first, then a required `cli live session start` line, then the absence check; the m14 mutation re-proved red through the Gateway-log check (see the mutation table) |
| 3 | #12/#46 built the distinct-window set from `WINDOWS` | patch | built from the returned rows |
| 4 | #12/#46 lacked the matrix's `context=1m` variant | patch | listed 1M row added and asserted (Plan Change Log) |
| 5 | #40/#97 printed the model instead of asserting it | patch | each turn's chat must have been switched to `grok-4.7[context=256k,...]` last before its prompt |
| 6 | #67 left its cron job in the tier's shared state | patch | `cron rm` in a finally, and its exit asserted |
| 7 | `finishRegression` skipped the cleanup when the stop threw | patch | try/finally |
| 8 | `[[usage:...]]` took the first match | patch | last match, header says so |
| - | pin the file order or reset config per file | defer | ticket 4.10 |

## Auto Run Result

- **Summary:** twelve Gateway-tier scenarios in four files recreate the conditions of #11/#38, #12/#46, #13, #14, #40, #97, #67, #74, #76 and #99 through a real Gateway with the packed plugin and `fake-cursor-agent`; each is proved red by reverting its fix (or an invented mutation for #13 and #46, which had no code fix); ledger entries now carry `tier = "gateway", reproduces = true`.
- **Files:** `test/regression/gateway/{turn-process,reply-prompt,context-usage,backend-registration}.regression.test.ts`, `test/regression/harness.ts`, `test/fixtures/fake-cursor-agent.mjs` (`FAKE_CURSOR_MODELS`, `[[usage:]]`, `[[error-json:]]`, pid on every log line), `test/live/harness.ts` (optional `logFile`), `test/regression/ledger.toml`, `MEMORY.md`.
- **Review:** 8 patched (medium 2, low 6), 1 deferred to ticket 4.10 (pin file order or reset config per file), 0 rejected.
- **Follow-up review recommended:** false (no high finding).
- **Verification:** `scripts/regression.sh gateway` 12/12 on 2026.10.3 (288 s), `--openclaw latest` 11 passed + 1 stated skip on 2026.11.10 (384 s), `npm test` 2090 passed, `npm run typecheck` clean; CI green on 0418703; orchestrator re-ran the 2026.10.3 tier green before the patches.
- **New bug found (not fixed here):** #105, on 2026.10.3 a second configured agent stops `sessions.reset` from releasing the chat's cursor-agent.
- **Residual risks:** #12/#46 is checked only on 2026.10.3 (2026.11.10 lists no models offline); the tier's config is shared between files, so a scenario must not add agents until 4.10 isolates it.

## Verification

**Commands:**
- `scripts/regression.sh gateway` -- expected: all scenarios pass on 2026.10.3
- `scripts/regression.sh gateway --openclaw latest` -- expected: all pass (or stated skips) on 2026.11.10
- `npm test` -- expected: green (ledger check included)
- `npm run typecheck` -- expected: clean

**Results (on main, fresh `.regression/` state each run):**
- `scripts/regression.sh gateway` (2026.10.3): 12 passed, exit 0, 4m49s; no fake-cursor-agent or Gateway process left afterwards.
- `scripts/regression.sh gateway --openclaw latest` (2026.11.10): 11 passed, 1 skipped (#12/#46: `models.list` is empty offline for every provider, reason stated in the test), exit 0, 6m14s; no process left afterwards.
- `npm test`: 71 files passed (23 skipped, the gated tiers among them), 2090 tests passed; ledger check green.
- `npm run typecheck`: clean.
- Mutation proof: every row red on 2026.10.3 under its mutation (table above).

**Results after the review patches (2026-11-27, on main plus the patches, fresh `.regression/` state each run):**
- `scripts/regression.sh gateway` (2026.10.3): 12 passed, exit 0, 288 s (vitest 269 s).
- `scripts/regression.sh gateway --openclaw latest` (2026.11.10): 11 passed, 1 skipped (#12/#46, as before), exit 0, 384 s (vitest 356 s).
- No fake-cursor-agent or Gateway process left after either run.
- `npm test`: 71 files passed (23 skipped), 2090 tests passed, ledger check green (87 s). `npm run typecheck`: clean.
- Mutations re-run in a fresh scratch worktree with the patches: m11, m74, m67, m14, m46, m12 all red on 2026.10.3, m74 also red on 2026.11.10 (table above).
