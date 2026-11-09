---
title: 'A finished conversation leaves its cursor-agent running'
type: 'bugfix'
ticket: 'bug-a-finished-conversation-leaves-its-cursor-agent-running'
created: '2026-11-09'
status: blocked
baseline_revision: '943150046a6c65f5fbbfbd5229811e0e94ca62c8'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
blocked_at: "2026-11-09"
blocked_reason: "no subagents"
---

<intent-contract>

## Intent

**Problem:** When a conversation ends (`/new`, reset, delete, idle or daily rollover) its pooled `cursor-agent` (about 200 MB) stays until the 15-minute idle close or the process cap, because the plugin never subscribes to the host's `session_end` hook.

**Approach:** Register a `session_end` hook that closes the idle pool members of the ended conversation. A member learns its conversation from the `session=<sessionKey>` field of the host's Runtime line in `ctx.systemPrompt` (the only place `execute` sees it); `session_end` carries the same `sessionKey`. Shutdown stays on the close-all path; the idle close stays as backstop.

## Boundaries & Constraints

**Always:** Close only idle members (never under a turn). Never block the host: start the close, do not await it. Keep working when `api.on` is missing or a payload lacks a key. Core names no CLI (AD-2).

**Never:** Change the reuse key (AD-13), the 15-minute idle close, the process cap, or unload. Handle `shutdown`, `restart`, `compaction`, `unknown`. Read the host's session store. Use hooks that need `allowConversationAccess` (`agent_end`, `llm_input`, ...; blocked for non-bundled plugins, probed live).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ended, idle | `session_end` reason `new\|reset\|deleted\|idle\|daily`, key K, idle member of K | member closed, leaves pool | none |
| Other conversation | members of K and L, event for K | only K's closes | none |
| Running turn | member of K busy | not closed; idle close or next release ends it | none |
| Shutdown | reason `shutdown\|restart` | hook does nothing; close-all stays the only closer | none |
| No key | event without `sessionKey`, or member without a conversation | nothing closes | none |
| Stubborn process | ignores SIGTERM | handler returns at once; transport SIGKILL ends it | close errors swallowed |
| No hooks | `api.on` absent | registration succeeds | none |

</intent-contract>

## Code Map

- `src/core/register.ts` -- `registerAdapters`: add `api.on?.("session_end", ...)` over all pools.
- `src/core/pool.ts` -- `ProcessPool`, `PoolMember`: add `conversation?` and `releaseConversation(key)`.
- `src/core/live-entry.ts` -- `createLiveEntry`: set `member.conversation` from `ctx.systemPrompt`.
- `src/core/conversation.ts` (new) -- `conversationOf(systemPrompt)`, `RELEASING_REASONS`.
- Handle close path already does pool remove, chat release, host `remove`, session close (`handle.close("idle")`); reuse it.
- `docs/providers/cursor.md` (lines 9, 400-406), `openclaw.plugin.json` (`maxProcesses` help), AD-14 in the architecture doc, `CHANGELOG.md`, `MEMORY.md`.

## Tasks & Acceptance

**Execution:**
- [x] `test/session-end-release.test.ts` -- reproduction test first, fails with `expected [] to include 'session_end'`
- [ ] `src/core/conversation.ts`, `src/core/pool.ts`, `src/core/live-entry.ts`, `src/core/register.ts` -- the fix
- [ ] `test/session-end-release.test.ts`, `src/core/pool.test.ts`, `src/core/conversation.test.ts` -- a test per criterion
- [ ] docs, manifest text, AD-14 note, CHANGELOG, MEMORY

**Acceptance Criteria:**
- Given an idle member of a conversation, when `session_end` fires for it, then it closes and leaves the pool.
- Given members of two conversations, when one ends, then only its member closes.
- Given a busy member, when its conversation ends, then it is not closed under the turn.
- Given reason `shutdown` or `restart`, when it fires, then the hook closes nothing.
- Given a host without `on`, when the plugin registers, then it succeeds.
- Given a process that ignores SIGTERM, when released, then the hook returns at once and the process ends within the transport grace.

## Implementation Notes

Route changed from full to oneshot: the production change is about 70 lines (the tests and docs are the rest), and this session has no tool to launch an implementing subagent. Decisions and the probe record are under Design Notes and in `MEMORY.md`.

## Plan Change Log

## Review Triage Log

## Design Notes

Decision: the pool key is the native Cursor id, but `execute` sees neither OpenClaw's `sessionId` nor `sessionKey` (checked: `ExecuteContext`, `env`, `args`, MCP file). The host's Runtime line (`Runtime: agent=main | session=agent:main:explicit:x | ...`, kept in the system prompt on normal CLI turns, docs `reference/prompt-caching.md`) names the key; `session_end.sessionKey` matches it. `/new` keeps the key and changes the session id, so a key release closes the ended conversation's process; a race with the successor's first turn is safe because that member is busy. A host that changes the line only loses the early release.

## Verification

**Commands:**
- `npx vitest run test/session-end-release.test.ts` -- green after the fix
- `npm run ci` -- passes

**Manual checks (if no CLI):**
- Isolated Gateway with the fake agent: after `/new` the `fake-cursor-agent` process is gone. Live Cursor check not run (no login).

## Auto Run Result

Status: blocked
Blocking condition: no subagents. The thorough review (four lenses) needs subagents and this session has no tool to launch one. Review not run. The implementation is built, committed, and verified.

- Summary: a `session_end` hook closes the idle pool members of the ended conversation (reasons `new`, `reset`, `deleted`, `idle`, `daily`); the member's conversation is the `session=<key>` of the host's Runtime line in the system prompt.
- Files: `src/core/conversation.ts` (parser, reasons), `src/core/pool.ts` (`releaseConversation`), `src/core/live-entry.ts` (member conversation), `src/core/register.ts` (hook), tests in `test/session-end-release.test.ts` (repro first, then one per criterion with the real adapter and the ACP stand-in), `src/core/pool.test.ts`, `src/core/conversation.test.ts`; docs in `docs/providers/cursor.md`, `docs/setup.md`, `openclaw.plugin.json`, AD-14, `CHANGELOG.md`, `MEMORY.md`.
- Verification: the repro test failed first with `expected [] to include 'session_end'`, green after the fix; mutation of the key/idle check fails three tests; `npm run ci` passed; live in the isolated Gateway with the fake agent: after `/new` the ended chat's process was gone and the other chat's stayed. Live Cursor check not run (no login).
- Residual risks: the Runtime line is a host text format (a change only loses the early release); a race where the successor's turn is idle before the hook runs would close its warm process (a restart, no data loss).
- Open for the orchestrator: run the thorough review (`bmad-build-auto` on the plan, status then follows step 4).
