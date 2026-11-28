---
title: 'Live tier in GitHub Actions with the real cursor-agent'
type: 'feature'
ticket: '5'
created: '2026-11-28'
status: 'in-review'
baseline_revision: '5478be7'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The 17 files of `test/live/` (about 85 tests against the real cursor-agent and Cursor) have never run in CI or a release, so model-behavior bugs (#76 exec refused, #75 GPT structured output, slow first replies #11/#38/#44) come back unnoticed. The owner put his Cursor key as `CURSOR_API_KEY` into the GitHub environment `regression` (2026-11-28).

**Approach:** A `live` tier in `scripts/regression.sh` and `regression.yml`: the job uses the environment `regression`, installs the cursor-agent the plugin pins (download, sha256 check), runs `test/live/` plus new model-behavior scenarios with up to 3 tries each, a run time cap and a turn cap, and writes a result file with tries, timings and Cursor tokens that the summary job shows. Dispatchable alone; `ci.yml` never runs it.

## Boundaries & Constraints

**Always:** the key reaches only the `live` job, through `environment: regression` and `secrets`, never an output, log line or artifact; without the key the tier fails in its first step with one clear line ("CURSOR_API_KEY is not set: the live tier needs the `regression` environment"); cursor-agent is the pinned build from `src/adapters/cursor/install.ts` (version, URL, sha256 read from that file, not copied), a sha mismatch fails; a scenario passes when any of its 3 tries passes and the result records the tries used; the run stops starting turns at the turn cap (default 400, input `live_turn_cap`) and the job has a time cap (`timeout-minutes` 120); new scenarios assert behavior, never weaken an existing assertion; ledger entries for #38, #44, #75, #76 gain a `tier = "live"` test and lose `planned = "4.5"`; English.

**Never:** change `src/` (a scenario red on main is a new bug: stop and report it with its log); run live on pull requests, on `push`, or nightly; add a #102 scenario (it comes with the #102 fix); pass the key to the Gateway or UI tiers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Green run | dispatch `tier=live`, key set | every scenario passes in ≤3 tries; summary: per file pass/fail, tries, seconds; totals: time, turns, tokens | none |
| No key | `CURSOR_API_KEY` empty | fails within the first minute with the clear line | exit 1, no install, no turns |
| Flaky scenario | passes on try 2 | green, `tries: 2` shown, listed under "needed retries" | none |
| Red scenario | all 3 tries fail | red, failing list as in the Gateway tier, with the last failure message | exit 1 |
| Turn cap hit | more turns than the cap | remaining turns fail with "turn cap N reached", run red | named in the summary |
| Ledger late | usage event not yet listed | the token reader waits and retries (events appear 2 to 6.2 s late) | tokens shown as "unknown" if still missing after 60 s, never 0 |

</intent-contract>

## Code Map

- `test/live/harness.ts` -- `startGateway` runs `scripts/dev-openclaw.sh` in `.spike/`; `LIVE` gate, `LIVE_TIMEOUT_MS`; home for the turn counter and the conversation-id record.
- `test/live/*.live.test.ts` -- existing suite; `exec-tool.live.test.ts` (`runIt` names exec, `retrying`) is the home for #76; `turn-latency.live.test.ts` (relative speed only) for the first-reply budget.
- `src/adapters/cursor/usage.ts` -- the usage ledger client (key exchange, `GetFilteredUsageEvents` by `conversationId`); the token reader reuses its logic from a script, not by changing it.
- `src/adapters/cursor/install.ts` -- the pin (linux-x64 URL, sha256, version 2026.11.11-b912975).
- `scripts/regression.sh`, `scripts/regression-result.mjs` -- tiers and the result file (`failed` from the Vitest JSON report; no tries or tokens yet).
- `.github/workflows/regression.yml` -- `resolve`, per-version `tier`, `summary`; tier choice `gateway|ui`; no secrets today.
- `test/regression/ledger.toml`, `test/regression/ledger.test.ts` -- entries #38, #44, #75, #76 planned 4.5.
- `docs/release.md`, `docs/agents/implement.md` ("Live checks never block"), `MEMORY.md`.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/install-cursor-agent.mjs` (+ test of the pin parsing and the sha check) -- download the pinned build for this host into a given dir, verify sha256, print the launcher path
- [x] `scripts/regression.sh live` -- key check first, install, `dev:install` for the requested OpenClaw, `test:live` with a JSON and a tries reporter, result file with `tries`, `turns`, `tokens`, `seconds`
- [x] Vitest live config -- `retry: 2` for the live tier; a small reporter records each test's `retryCount`
- [x] harness -- turn counter with `LIVE_TURN_CAP`; record ACP conversation ids for the token reader
- [x] new scenarios -- #76 (agent mode, a command asked without naming exec, the marker file appears), #75 (a GPT model's structured output per the issue), first reply within an absolute budget (set from the measured run plus margin, stated in the test), Test connection (`models.probe` on `cursor-cli` ok with the real key), quota (the quota reading the plugin returns is present and well formed)
- [x] `scripts/live-tokens.mjs` -- sum the run's tokens from the usage ledger by conversation id, after the delay
- [x] `regression.yml` -- tier `live` (dispatch choice and `workflow_call`), job `environment: regression`, `CURSOR_API_KEY` from secrets, `live_turn_cap` input, default versions `latest` for live, summary columns tries and tokens
- [x] ledger -- live tests for #38, #44, #75, #76
- [x] docs -- `docs/release.md` (how to dispatch, cost), `MEMORY.md` (measured time and tokens of one full run)

**Acceptance Criteria:**
- Given the tier run locally with a valid key on latest OpenClaw, when it ends, then every scenario has a pass/fail and a try count, and the result file has total seconds, turns and tokens.
- Given no key, when the tier starts, then it fails fast with the clear line and starts no turn.
- Given `npm test`, `npm run typecheck`, `node scripts/plan-gate.mjs`, then all are green.
- Given the workflow merged to main (dispatch needs it on the default branch), when the owner or the agent dispatches `tier=live`, then the summary shows the results, tries, time and tokens (verified after merge; hitl).

## Implementation Notes

- Decision: install the pinned cursor-agent, not `curl cursor.com/install`: the live tier then tests what the plugin ships. The managed install itself (`offerInstall`) needs a yes from a prompter, so CI cannot drive it.
- Decision: the live job runs one OpenClaw version per dispatch (default `latest`); the release (ticket 7) chooses the versions.
- Decision: tokens are summed over the run's own conversation ids, because the key is the owner's and the account-wide ledger also holds his own use.
- The measurement in MEMORY.md comes from the first full local run in this container (the container has a key); the CI number is added after the first dispatched run.
- Decision: the turn counter is a cursor-agent shim (`test/live/turn-meter.mjs`, on `PATH` and in `CURSOR_AGENT_BIN`), not a counter in `test/live/harness.ts`: many live files drive `cursor-agent acp` directly or through the plugin's own spawn, past the harness, and only a shim sees every `session/prompt`. It counts across processes through its log, refuses prompts past the cap with a JSON-RPC error `turn cap N reached`, logs session ids and stop reasons but never prompt text, and leaves `--version` and other non-ACP calls unmetered.
- Decision: `scripts/install-cursor-agent.mjs` reads the pin from `src/adapters/cursor/install.ts` (Node type stripping imports it) but reimplements the download, sha256 check and unpack with the system `tar`: `src/core/managed-install.ts` uses TypeScript parameter properties, which type stripping refuses, and `src/` stays untouched. Downloads use `redirect: "error"` and only the pin's own origin; a verified copy (`.pinned-sha256`) is reused.
- Decision: the 3 tries are Vitest's `retry: 2`, set in `vitest.config.ts` when `OPENCLAW_ALL_CLI_LIVE=1` (also for `npm run test:live`), together with one file at a time; `test/live/tries-reporter.ts` writes each test's tries from `retryCount`.
- Decision: the token total is `null` ("unknown"), never 0, when any finished turn's conversation has no ledger event after 60 s, when nothing matched, or when the sum is 0; a cancelled or refused turn is not expected in the ledger.
- Decision: `LIVE_TESTS` narrows the tier's files, for trying the tier; the workflow never sets it.
- Decision: #75 runs on `cursor-cli/gpt-5.5`, the issue's model and the owner's live check of the fix (2026-11-08). Exploring on OpenClaw 2026.10.3, `cursor-cli/gpt-5.3-codex` still ended `failed` with `schemaError: "structured_output was not called"` in 2 of 3 tries (`"collectorCompletion":{"status":"failed","schemaError":"structured_output was not called","usage":{"inputTokens":14096,"outputTokens":219}}`), while gpt-5.5 and claude-opus-5-5 ended `done`: reported as a probable new bug (the #75 fix does not hold for codex models), not added as a scenario.
- Decision: the checks that need a cursor-cli model in the Gateway's catalog (#75, Test connection) skip with the reason on OpenClaw 2026.11 and later when that catalog lists none: those versions take it from `catalog.openclaw.ai`, unreachable in this container. 2026.10.x lists the plugin's rows offline and never skips.
- Decision: the harness finds Gateway logs where each version writes them (`<state>/logs` from 2026.11, `$TMPDIR/openclaw` before; `history-continuity` and `turn-latency` read them) and follows `SPIKE_DIR`, so the tier's isolated state under `.regression/` is the one the files read.
- Decision: live tests record numbers with `recordMeasurement` (`OAC_LIVE_MEASURE_FILE`), and the result file carries them (`measurements`), so the first-reply budget can be checked against what each run saw.
- Decision: the first-reply budget is 20 s on the median of three new sessions: measured 2026-11-28 in this (loaded, 4-core) container at 8.8-9.5 s on OpenClaw 2026.10.3 and 11.4-13.2 s on 2026.11.11; 20 s is the slower median (12.4 s) plus about 60 %. The test states it in `FIRST_REPLY_BUDGET_NOTE`.
- Decision: Vitest's retry re-runs a test in the same file state, so the live tests that made a fixed folder (`mcp-proxy`, `per-agent-home`, `permission-routing`, `skills-system-prompt`, `streaming`) make it with `freshDir` (harness), which removes what an earlier try left; their assertions are unchanged. Found in the first full run, where every retry of those tests failed with `EEXIST`.
- Decision: `scripts/regression-result.mjs` lists a live run's failures from the tries reporter (`<file> > <describe> > <test>: <last message>`): the JSON report joins titles with spaces and has no message, so matching the two never worked. The tier filters `test/live/` with the slash (a bare `test/live` also ran `test/live-tier.test.ts`); `npm run test:live` too.
- Decision: a turn a test fails on purpose before it reaches a model (the refused model host of `errors.live.test.ts`) has no ledger event; the test marks its window with `markUnbilled` in the turn log, and the token reader does not wait for such turns. The first full run had exactly that one turn missing (an `end_turn` 0.36 s after the prompt), so its total read `unknown`; with the window its total is 8,464,981.
- Decision: #102's live scenario (`ask-mode-write.live.test.ts`) follows the Gateway scenario: `sessions.patch {key, execHost: "node"}` before the first turn, then two turns of one session that ask for a file without naming a tool; it passes when each file holds its unguessable content and the turn called an OpenClaw tool that changes things, and (in the tier) both prompts went to one cursor-agent process (the turn log, now exported as `OAC_LIVE_TURN_LOG`).
- Decision: the live job is its own job in `regression.yml`, not the `tier` job with a conditional environment, so the gateway and ui jobs can never see the key; its first step checks the key before checkout; uploaded logs pass through `scripts/scrub-key.mjs` and the state (which holds the saved profile) is never uploaded. Versions default to the tier's own (`min latest`, or `latest` for live) when the input is empty, and several versions run one at a time (`max-parallel: 1`).

## Verification (2026-11-28, this container)

- `npm test`, `npm run typecheck`, `node scripts/plan-gate.mjs --changed`, and `actionlint` 1.7.9 on the workflows: green (one known load flake in `src/core/pid-locks.test.ts`, green alone).
- First full run, `scripts/regression.sh live --openclaw latest` (2026.11.11, on baseline 21cb142, before #105/#106/#102 were merged): 5150 s, 139 turns, 8,464,981 tokens; 68 passed, 17 red, 3 skipped. After the harness fixes the red files ran again on 2026.11.11 and on 2026.10.3 (with #102's new scenario), on 2b9286b.
- Red because of this container (catalog.openclaw.ai unreachable, so 2026.11.x lists no cursor-cli model): `model-catalog` (3 tests), `turn-latency` "a new agent on a Gateway whose model catalog has loaded"; the new #75 and Test connection checks skip with that reason.
- Red because the tests read a 2026.10 host log line (`cli exec: provider=… useResume=… historyPrompt=…`) that 2026.11.11 no longer writes: `history-continuity` (a)-(d) and `session-resume` "resumes through the real OpenClaw" (green on 2026.10.3, except history-continuity (c), below).
- Red on the plugin side, reported, not changed here:
  - #102 (new scenario): red on 2026.11.11 and 2026.10.3, 3 tries each. With `execHost: "node"` (and also with `tools.deny: ["exec","process"]`) cursor-cli/auto refuses in turn 1 without calling any tool: "This chat is in Ask mode, so I can't write files, even though the OpenClaw instructions mention `file_write`." The only tool the sentence names there is `file_write` (OpenClaw's file-transfer plugin, which writes on paired nodes), no `write` or `edit`.
  - `permission-routing` "falls back to OpenClaw exec when the host denies the native shell": `expected [] to include 'exec'` on both versions (the model never calls exec).
  - 2026.11.11 only, green on 2026.10.3: `images-compaction` (c) and `success-signal` (AD-7): the workspace gains `.openclaw/tmp/cursor-agent-logs-*`, because OpenClaw 2026.11 points `TMPDIR` of agent runs at `<workspace>/.openclaw/tmp` (`prepareAgentExecScratch`) and cursor-agent writes its logs there; `operations` "locks the model listing's process … leaves no process or lock" (`expected 1 to be +0`) and "stops a hung model listing … by the time a Gateway SIGTERM completes" (`expected false to be true`); `skills-system-prompt` (e) (a changed tool list opened a second chat: `expected [ 'fake-session-…', …(1) ] to have a length of 1 but got 2`).
  - 2026.10.3: `history-continuity` (c) "a lost cursor-cli chat gets the host's history prompt": the log has no `reason=session_expired`, 3 tries.
- Flaky: `mcp-proxy` (3 tries on 2026.11.11, 1 on 2026.10.3); `exec-tool` "stops a foreground command that runs past Cursor's 60 s call limit" (3 tries); `permission-routing` abort test (2 tries on 2026.10.3, timed out on 2026.11.11 before the fixes).
