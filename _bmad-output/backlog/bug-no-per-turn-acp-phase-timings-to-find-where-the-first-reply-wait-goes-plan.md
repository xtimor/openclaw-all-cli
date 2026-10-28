---
title: 'Per-turn phase timings in the debug log (ticket 16, issue #44)'
type: 'bugfix'
ticket: '16'
created: '2026-10-28'
status: 'built'
baseline_revision: '7178269be9f668f729ad99cdbc343db5eaa1f2d8'
route: 'full'
route_source: 'auto'
risk: 'low'
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

**Problem:** A turn on `cursor-cli` logs no phase durations, so where the 15-20 s first-reply wait goes (process start, `session/new` or `session/load`, model selection, the model's silence or thinking) is inferred from file times.

**Approach:** Every turn writes one debug-log line. The ACP transport reports how long each open phase took through a callback; the core adds the marks it sees itself (prompt sent, first thought, first text, end). Nothing sent to or shown from `cursor-agent` changes.

## Boundaries & Constraints

**Always:** A phase that did not happen (a reused process has no spawn, initialize, session, or model switch; a turn without thoughts has no first-thought) is absent, never `0`. The line holds only a backend id, a model id, an outcome, an error code, and milliseconds: no prompt text, key, or path. A failing log or callback never fails a turn. The core names no CLI.

**Never:** A pool of processes, a shorter system prompt, dropping the duplicate `AGENTS.md`. Moving model selection beside `session/load` without a test that proves it (AC 3). Editing tickets or `tickets.toml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New chat, thoughts then text | fake agent, `[[sleep:60]]` | one line: `process=new`, spawn, initialize, new_session, mode, set_model (if switched), prompt_sent, first_thought, first_text > first_thought, end, `outcome=ok` | none |
| Resumed chat | `useResume` + known id | `load_session` present, `new_session` absent | none |
| Warm follow-up | process reused | `process=reused`, no spawn/initialize/session/mode/set_model keys | none |
| No thoughts | prompt `[[no-think]]` | no `first_thought` key | none |
| Failed turn | `[[crash]]`, session/load error | line still logged, `outcome=error code=<code>`, only the marks reached | none |
| No debug logger | host logger without `debug` | no line, no error | none |

</intent-contract>

## Code Map

- `src/core/ports.ts` -- `OpenParams` (add `onPhase`, `OpenPhase`); the core's seam to a transport.
- `src/transports/acp/handshake.ts` -- `setup`, `switchModel`: wrap initialize, authenticate, new/load session, set mode, set model request in a timer.
- `src/transports/acp/session.ts` -- `AcpSessionOptions.onPhase`; `open` times the spawn (call to the child's `spawn` event).
- `src/adapters/cursor/index.ts` -- `open()` passes `onPhase` through; `listModels` does not.
- `src/core/turn-timings.ts` (new) -- `TurnTimings`: open phases, marks, `line()`.
- `src/core/attach-session.ts`, `src/core/execute.ts` -- thread the recorder; mark prompt sent, first thought/text, end in `promptTurn`; log in the `execute` wrapper's `finally`.
- `src/core/backend.ts`, `src/core/register.ts` -- thread `debug` (`api.logger.debug?.`).
- `test/fixtures/fake-cursor-agent.mjs` -- always sends one thought chunk; add `[[no-think]]`.
- Reuse: `FAKE_CURSOR_LOG` lines carry `t` (epoch ms) for the order test; `test/backend.test.ts` `runTurn` pattern for real adapter + fake agent.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports.ts`, handshake, session, cursor adapter -- open-phase callback -- the transport knows the phases
- [x] `src/core/turn-timings.ts`, `attach-session.ts`, `execute.ts`, `backend.ts`, `register.ts` -- record and log one line per turn
- [x] fake agent -- `[[no-think]]`
- [x] tests: unit for the line; ACP phases on the fake; end-to-end line (new, resumed, reused, no-think, failed); order of `session/new` before `session/set_*`; logger without `debug`
- [x] `docs/providers/cursor.md`, `CHANGELOG.md` -- the line and fields; the live split or "not run"

**Acceptance Criteria:**
- Given a turn on the fake agent, when the debug log is read, then one line holds the AC 1 fields; absent phases are absent.
- Given thoughts before text, then first_thought and first_text differ; with no thoughts the first_thought key is absent.
- Given `npm run ci`, then it passes and no message to the agent changes.

## Implementation Notes

Full route by size. No subagent tool exists in this session: the implementation is done in the main session and the review is inline (see Review Triage Log).

Files: `src/core/ports.ts` (`OpenPhase`, `OpenParams.onPhase`), `src/transports/acp/handshake.ts` (`timePhase`, `reportPhase`), `session.ts` (spawn timing, `onPhase`), `src/adapters/cursor/index.ts` (passes `onPhase`), `src/core/turn-timings.ts` (new), `attach-session.ts`, `execute.ts`, `backend.ts`, `register.ts` (`api.logger.debug?.`), fake agent (`[[no-think]]`), tests `test/turn-timings.test.ts` and `src/transports/acp/session.test.ts`, docs and changelog.

Decisions: names `login`, `new_session`, `load_session`, `set_mode`, `set_model` (the line's `model=` is the model name, so the switch is `set_model`). The core collects open phases through the callback so a failed open keeps the phases it reached. `prompt_sent` counts from the start of `execute` (slot wait included); the three later marks count from the prompt sent. Marks are taken where the core reads the events, not in the transport (same clock, no interface change to `prompt`). `end` is taken before the usage lookup.

AC3 (model selection order): the order stays. `selectModel` maps the wanted name to the exact ID (brackets included) from the model list that `session/new` or `session/load` returns, so a switch cannot be sent beside the call; no test can prove a safe move because there is no ID to send. `test/turn-timings.test.ts` pins `session/new` before the switch and the switch before `session/prompt`. Live: `set_model` costs 0.85 to 1.4 s on `grok-4.7` (see docs).

Checked end to end on OpenClaw 2026.10.3 (installed pack, fake agent as `cursor-agent`): the line shows with `OPENCLAW_LOG_LEVEL=debug` under `[plugins]`, and not at `info`.

Live (AC6, `CURSOR_API_KEY` set, outside the sandbox, about 3 minutes): 3 turns on `grok-4.7` and 3 on `auto` through the plugin backend with the real `cursor-agent` 2026.10.22, a new home per turn, prompt "Reply with the single word OK.". No OpenClaw around it (no Gateway, no 42 KB system prompt). Ranges are in `docs/providers/cursor.md`. The key was never printed.

## Plan Change Log

## Review Triage Log

### 2026-10-28 — Review pass 1 (inline; no subagent tool in this session)
- verdicts: 3 findings — high 0, medium 0, low 1, false 2, maybe-false 0
- findings:
  - `[false]` `[reject]` Hoisting `composePrompt` before `throwIfAborted` changes behavior on abort — `composePrompt` (`src/core/turn-prompt.ts`) is pure (string joins); an abort still throws before the prompt is sent.
  - `[false]` `[reject]` The line could leak prompt text, a key, or a path — fields are a backend id, a sanitized model name, fixed words, an error code, and integers; the tests assert the prompt text and the scratch path are absent and that a hostile model name stays one token.
  - `[low]` `[reject]` `end` excludes the usage lookup that follows the result (about 4 s with an API key in the live run) — intended (the ticket asks for the wait to the first reply); the docs say `end` is before the usage lookup; adding another field would widen the line for nothing the ticket asked.

## Design Notes

Line: `turn timings (cursor): model=grok-4.7 process=new outcome=ok spawn=5ms initialize=640ms new_session=3210ms set_mode=2ms set_model=4ms prompt_sent=3900ms first_thought=2400ms first_text=9800ms end=10400ms`. Open phases are durations. `prompt_sent` is ms from the start of the turn (slot wait, version check, proxy, open included). `first_thought`, `first_text`, `end` are ms from the prompt sent. A phase that ran counts at least 1 ms.

Model selection stays after the session response: the exact model ID (brackets included) is picked from the model list that `session/new` or `session/load` returns, so it cannot be sent beside it. A test pins the order.

## Verification

**Commands:**
- `npm run ci` -- expected: exit 0

## Auto Run Result

**Summary.** Every turn writes one debug line, `turn timings (<backend>): model=... process=new|reused outcome=ok|error|aborted [code=...] spawn initialize [login] new_session|load_session [set_mode] [set_model] prompt_sent first_thought first_text end`, in ms. Open phases come from the ACP transport through `OpenParams.onPhase`; the core adds the marks it sees. Absent phases are absent. A failed turn and a failed open still log. Nothing sent to the agent changes (test compares the wire before and after).

**Files.** `src/core/turn-timings.ts` (new, the line), `src/core/ports.ts`, `src/transports/acp/handshake.ts`, `src/transports/acp/session.ts`, `src/adapters/cursor/index.ts`, `src/core/attach-session.ts`, `src/core/execute.ts`, `src/core/backend.ts`, `src/core/register.ts` (wiring), `test/fixtures/fake-cursor-agent.mjs` (`[[no-think]]`), `test/turn-timings.test.ts` and `src/transports/acp/session.test.ts` (tests), `docs/providers/cursor.md` (fields, live split), `CHANGELOG.md` (#44).

**Review.** Patches applied 0; deferred 0; rejected 3 (two false, one low; reasons in the triage log). Follow-up review recommended: false (nothing patched).

**Verification.** `npm run ci`: exit 0 (typecheck, full unit suite, build, package test, pack, install smoke). Mutation: with the `debug` call removed, 8 of 16 tests in `test/turn-timings.test.ts` fail. Live check run (AC6); an end-to-end log check on OpenClaw 2026.10.3 passed.

**Residual risks.** The live split comes from the plugin driving `cursor-agent` directly, not from a Gateway turn with OpenClaw's system prompt, so it shows the plugin's phases, not the 15 to 20 s of a real first reply. The review was inline by the implementer. Ticket 17 also edits `CHANGELOG.md` `Unreleased`; a merge may need a manual join.
