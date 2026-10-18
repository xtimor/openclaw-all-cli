---
title: 'Session resume, live-process reuse, and side questions'
type: 'feature'
ticket: '7'
created: '2026-10-18'
status: 'in-progress'
baseline_revision: 'f8d4c01f75ba31a58ef8a88c28e6cdbb5804815c'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Resume already works through ACP `session/load` and a warm process is reused by model, cwd, home and session, but AD-13 also requires mode and auth profile to match, a stale native session (one Cursor no longer knows) fails every later turn with no recovery, and a side question (`executionMode: "side-question"`) still runs like a normal turn with tools. Whether two processes can resume one chat safely (spec Q4) is unknown.

**Approach:** Resume from `ctx.sessionId` and `useResume` via `session/load`, emit the new native id whenever it changes, reuse a live process only when `modelId`, mode, `cwd`, home, `authProfileId` and the native session id all match (AD-13), and run side questions without tools. Parity rows P4, P5, P18.

## Boundaries & Constraints

**Always:** OpenClaw owns session binding (AD-5): the plugin never stores its own session map, it only receives `ctx.sessionId`/`useResume` and emits the native id it ends up with (`sessionId` event). `/reset` (the host passes no resume id) starts a fresh chat. Another agent's chat cannot be resumed: homes are per agent (entry 2), so `session/load` of a foreign id fails; that failure must be a clear `session_expired` `CliError`, never a silent fresh chat that drops context unless the host's own recovery asks for it (settle with the host's `freshSessionRecovery` behavior and record it). A side question runs with no OpenClaw tools (no MCP server handed to the CLI), every permission request rejected, and in Cursor's `ask` mode; if native read/grep/glob cannot be switched off per run, say so in the P18 row and docs rather than claiming "no tools". Mode is part of the reuse key (a side question never reuses an agent-mode process or the reverse).

**Never:** Duplicate the host's session store; reuse a process across auth profiles or modes; hide a failed resume behind a new chat without recording it; change permission routing or events behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Follow-up turn | `useResume`, known id, warm process | Same process reused, only the new prompt sent | No error expected |
| After Gateway restart | `useResume`, known id, no process | New process, `session/load`, context kept | No error expected |
| `/reset` | No resume id | `session/new`, the new id is emitted | No error expected |
| Foreign agent's id | `session/load` of an id this home lacks | `session_expired` `CliError` with a clear message | Turn fails with that error |
| Different auth profile | `authProfileId` changed | New process | No error expected |
| Mode change | Agent turn after a side question | New process | No error expected |
| Side question | `executionMode: "side-question"` | No MCP server, requests rejected, ask mode, answer returned | No error expected |
| Two processes, one chat | Resume an id another live process holds | Behavior recorded from a live probe (safe, or refuse) | Per probe |
| Native id changes | The CLI returns another id after load | The new id is emitted | No error expected |

</intent-contract>

## Code Map

- `src/core/execute.ts` -- `reuseKey` (model, cwd, home today): add mode and `authProfileId`; side-question handling (`ctx.executionMode`); `sessionId` emission; no proxy/`mcpServers` for side questions
- `src/transports/acp/session.ts` -- `setup` `session/load` failure to `session_expired`; the id returned by `session/new`/`load`
- `src/core/backend.ts` -- `sideQuestionToolMode: "disabled"`, `freshSessionRecovery`, session config the host needs; manifest flags for P4/P5/P18
- `src/adapters/cursor/` -- mode selection per run (side question), manifest P4/P5/P18
- `test/fixtures/fake-cursor-agent.mjs` -- load of an unknown id, a changed id
- Host reference (read-only): `.spike/openclaw/node_modules/openclaw/dist/` -- `executionMode: "side-question"`, `sideQuestionToolMode`, `freshSessionRecovery`, how the host treats a backend error on resume and what it does with an emitted `sessionId`
- Facts: real `cursor-agent acp` supports `session/load` (verified); a load of an id the home lacks returns `Invalid params`; real runs show `reuse=reusable` in the host log for follow-up turns; OpenClaw 2026.10.3 restarts the process each turn in this MCP mode (P4 approx), so the warm path is only observable with a stable fingerprint (stub host) while the restart path goes through `session/load` every turn. Real cursor-agent and `CURSOR_API_KEY` are available.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/execute.ts`, `backend.ts`, adapter -- reuse key with mode and auth profile; side-question run without tools
- [ ] `src/transports/acp/session.ts` -- foreign/stale id to `session_expired`; settle recovery with the host's behavior
- [ ] live probe -- two processes resuming one chat (spec Q4): record the result in Implementation Notes and the spine's open question row
- [ ] unit tests -- every matrix row with the fake agent
- [ ] live tests (gated) -- a follow-up turn answers about the first with only the new prompt sent, also after the Gateway restarts; `/reset` starts a fresh chat (the model does not know the earlier fact); another agent's home cannot resume this chat; a side question runs without OpenClaw tools
- [ ] docs, manifest, parity P4, P5, P18 -- match behavior and evidence

**Acceptance Criteria:**
- Given a chat with an earlier fact, when a follow-up turn runs (also after a Gateway restart), then the answer uses the fact and only the new prompt was sent.
- Given `/reset`, when a turn runs, then the earlier fact is not known.
- Given another agent, when it tries to resume this agent's chat, then it fails with `session_expired`.
- Given a side question, when it runs, then no OpenClaw tool is offered.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

The host decides when a chat is resumed; the plugin decides only whether a warm process is safe to reuse and how to report a resume that cannot happen.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (run `npm run dev:install` first)
