---
title: 'Gateway scenarios for past turn, process, and prompt bugs'
type: 'feature'
ticket: '3'
created: '2026-11-27'
status: 'in-progress'
baseline_revision: '59645a0e921b9afea65c5d2739223ab4fa904f59'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
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
- [ ] `test/regression/gateway/*.regression.test.ts` -- new scenario files covering every matrix row (group by family where they share a Gateway setup)
- [ ] `test/fixtures/fake-cursor-agent.mjs` -- only the knobs the rows need
- [ ] `test/regression/harness.ts` -- only shared helpers the rows need
- [ ] `test/regression/ledger.toml` -- the entries above
- [ ] the plan's Implementation Notes -- per row: the mutation used and red/green on 2026.10.3, and green on 2026.11.10

**Acceptance Criteria:**
- Given main, when `scripts/regression.sh gateway` and `scripts/regression.sh gateway --openclaw latest` run, then every scenario passes (or is skipped on a version with a stated reason) and the tier finishes in about 10 minutes or less per version.
- Given each row's fix reverted in a scratch copy, when the tier runs there, then that row's scenario fails.
- Given `npm test`, when it runs, then the ledger check passes with the new gateway tests and the scenario files are skipped.
- Given a run ends, when it is over, then no Gateway or fake process from it is left.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `scripts/regression.sh gateway` -- expected: all scenarios pass on 2026.10.3
- `scripts/regression.sh gateway --openclaw latest` -- expected: all pass (or stated skips) on 2026.11.10
- `npm test` -- expected: green (ledger check included)
- `npm run typecheck` -- expected: clean
