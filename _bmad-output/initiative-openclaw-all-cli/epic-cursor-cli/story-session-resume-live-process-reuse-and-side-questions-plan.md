---
title: 'Session resume, live-process reuse, and side questions'
type: 'feature'
ticket: '7'
created: '2026-10-18'
status: done
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
- [x] `src/core/execute.ts`, `backend.ts`, adapter -- reuse key with mode and auth profile; side-question run without tools
- [x] `src/transports/acp/session.ts` -- foreign/stale id to `session_expired`; settle recovery with the host's behavior
- [x] live probe -- two processes resuming one chat (spec Q4): record the result in Implementation Notes and the spine's open question row
- [x] unit tests -- every matrix row with the fake agent
- [x] live tests (gated) -- a follow-up turn answers about the first with only the new prompt sent, also after the Gateway restarts; `/reset` starts a fresh chat (the model does not know the earlier fact); another agent's home cannot resume this chat; a side question runs without OpenClaw tools
- [x] docs, manifest, parity P4, P5, P18 -- match behavior and evidence

**Acceptance Criteria:**
- Given a chat with an earlier fact, when a follow-up turn runs (also after a Gateway restart), then the answer uses the fact and only the new prompt was sent.
- Given `/reset`, when a turn runs, then the earlier fact is not known.
- Given another agent, when it tries to resume this agent's chat, then it fails with `session_expired`.
- Given a side question, when it runs, then no OpenClaw tool is offered.

## Implementation Notes

- **Reuse key (AD-13).** `execute.ts` keys a warm process on `[modelId, mode, cwd, home.dir, authProfileId]`; the native session ID is checked on the session. `authProfileId` is known only to `prepareExecution`, not to `execute`, so `backend.ts` passes it into `createExecute` options (one execute per run; the key, not the closure, decides reuse). Mode comes from `ctx.executionMode`. The mode part is defense in depth: the host gives a side question no live session, and the core ignores `ctx.liveSession` for one, so a side question never reaches the reuse check.
- **Id changes.** `session/load` normally answers for the id it was given; `readMovedSessionId` takes an extra `sessionId` field when an agent moves the chat. The core emits the session's id on every turn (it already did), so the host stores the new one.
- **Stale or foreign id.** (Review patch, 2026-10-18: narrowed.) Real Cursor answers a missing chat with `-32602 Invalid params` and `data.message` `Session "<id>" not found`. `resumeError` reads the message and `data` strings and makes `session_expired` only when a phrase ties "session" to not found / does not exist / unknown / no such (or `no such|unknown|invalid session`); a bare `-32602`, "API key not found" or "workspace does not exist" stay `server_error`. A process that dies during `session/load` is a retryable death (the open waits `EXIT_SETTLE_MS` for the exit before it reports). The old text: `session/load` failures with `-32602` or a not-found wording became `session_expired` with the text `CLI session not found: ...`. The host classifies the failure from the message text (`isCliSessionExpiredErrorMessage`), not from our code, so the phrase is load-bearing. Other load failures stay `server_error`. The earlier soft spot (a bare `-32602` for bad `mcpServers` read as an expired chat) is gone with the narrowing.
- **Host recovery (recorded).** The backend sets `freshSessionRecovery: "invalidated-only"` (what `claude-cli` uses). Real OpenClaw 2026.10.3, checked against the isolated install: the failure arrives as `FailoverError reason=session_expired`; the host retries with a fresh chat only when it has a history prompt to reseed (needs a Cursor API-key profile, parity P15); without one (this host: `historyPrompt=none`) the turn fails. The host clears a failed chat binding only for `claude-cli` (`isClaudeCliProvider` in `attempt-execution.runtime`), so for `cursor-cli` every later turn fails the same way until `/reset`. The plugin cannot clear it (AD-5); documented in the provider doc and setup troubleshooting. The retry-with-history path is unverified live.
- **Side question.** `ctx.executionMode === "side-question"`: no proxy, no `mcpServers`, no settings file read, no resume (`resumeSessionId` dropped in the core and again in the adapter), every permission request answered `reject_once` without asking the host (`cancelled` after the turn ended), and no `sessionId` event or result session id (the chat is thrown away; the host also runs it with `sessionMode: "none"` and no live session). Cursor mode is `ask` for both kinds of run. `sideQuestionToolMode: "disabled"` is set because the plan lists it and without it the host refuses `/btw` for a backend with native tools (`cannot run with tools disabled because it exposes native tools`). Cursor cannot switch off native read, grep, glob per run (a static no-readers home is possible, not built), so P18 is `approx` and the docs say the model may still read files; no shell, write, or OpenClaw tool. The throwaway session directory stays in the agent's `acp-sessions` (not cleaned up).
- **Spec Q4, live probe (2026-10-18, cursor-agent 2026.10.16, real account).** Process A creates a chat (fact PELICAN-42). Process B, alive beside A, `session/load`s the same id without error and recalls the fact. A then adds HERON-7; B does not know it (B lists only PELICAN-42); A knows both. After both close, a third process loads the chat and sees PELICAN-42 and HERON-7: B's turns are not in the stored chat. Result: loading works, but each process keeps its own view and the last writer wins, so it is not safe. Behavior: the core keeps at most one process per chat (`chats` registry keyed by home and native id): an idle holder is closed before the new process loads, a holder mid-turn makes the new turn fail with a retryable `server_error`. In the host flow `live.restart()` already closes the previous handle, so this only guards the gaps. (Review patch: the claim is now registered before the process opens, with no await between check and set, so two concurrent resumes cannot both pass; a holder still opening counts as busy. After closing an idle holder the new entry holds the key at once and waits for the old exit, bounded by the abort grace and the turn's abort signal; a holder that does not exit in time fails the turn retryable. The session's own close already escalates SIGTERM to SIGKILL. A load that moved the chat re-keys the claim.)
- **Fake agent.** `FAKE_CURSOR_LOAD_ERROR=<json>`, `FAKE_CURSOR_LOAD_CRASH=1` (review patch), and the missing-chat error now carries `data.message` like Cursor; `FAKE_CURSOR_STORE=<dir>` (a chat store per home: unique ids, history, `session/load` of an absent id fails `Invalid params`), `FAKE_CURSOR_LOAD_RENAMES=1`, prompt `[[recall]]`.
- **Verified.** `npm run typecheck && npm run build && npx vitest run`; live (`OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live`, real cursor-agent with `CURSOR_API_KEY`) `test/live/session-resume.live.test.ts`: warm follow-up with only the new prompt, restart resume, `/reset` forgets, foreign home `session_expired`, side question, one process per chat, and two real `openclaw agent --local` runs (resume, then a deleted native chat fails `reason=session_expired`). One live run hit a transient Cursor `resource_exhausted` message and passed on rerun.
- **Not done.** Retry-with-history after `session_expired` (needs an API-key profile); `/reset` and `/btw` driven through a real Gateway chat command (`/reset` is covered at the `createExecute` level and by a fresh `--session-id`; `/btw` only at the `createExecute` level with the real CLI); cleanup of a side question's throwaway session directory.

## Plan Change Log

## Review Triage Log

## Design Notes

The host decides when a chat is resumed; the plugin decides only whether a warm process is safe to reuse and how to report a resume that cannot happen.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (run `npm run dev:install` first)
