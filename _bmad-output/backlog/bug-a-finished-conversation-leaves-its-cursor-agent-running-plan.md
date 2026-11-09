---
title: 'A finished conversation leaves its cursor-agent running'
type: 'bugfix'
ticket: 'bug-a-finished-conversation-leaves-its-cursor-agent-running'
created: '2026-11-09'
status: done
baseline_revision: '943150046a6c65f5fbbfbd5229811e0e94ca62c8'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      A process that is busy when its conversation ends gets no early release; it waits for the idle close or the next release of the key.
    evidence: |-
      releaseConversation skips busy members, as the ticket criterion 3 allows ("still closed by the idle close or the next release").
    location: >-
      src/core/pool.ts
    severity: medium
  - summary: >-
      A released member leaves the pool count before its process exits, so a burst of /new can briefly pass maxProcesses.
    evidence: |-
      Release does not wait for the exit by design (bounded close); the transport SIGKILLs within 2 s.
    location: >-
      src/core/pool.ts
    severity: low
  - summary: >-
      conversationOf takes the first Runtime line in the system prompt; a crafted earlier line would tag the wrong key. A stale session_end under a kept key can close a successor's idle process.
    evidence: |-
      Not shown reachable on a real host (unverified); the cost is one restart, no data loss.
    location: >-
      src/core/conversation.ts, src/core/register.ts
    severity: low (unverified)
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

### 2026-11-09 — Review pass
- verdicts: 16 findings — high 0, medium 3, low 7, false 0, maybe-false 6
- findings:
  - `[medium]` `[patch]` handle.close leaks the process if releaseChat/live.remove throws — close of session and proxy moved into a finally.
  - `[medium]` `[patch]` ctx.sessionKey fallback untested; empty-string event key skips the fallback — `||` instead of `??`, test added.
  - `[medium]` `[patch]` P4 manifest note and provider doc row lack the release (criterion 7) — added.
  - `[medium]` `[defer]` busy-at-end process gets no early release — matches criterion 3; deferred.
  - `[low]` `[defer]` cap overlap while a released process exits; first-match Runtime line; stale session_end under a kept key — recorded as deferred.
  - `[low]` `[reject]` second parser for the Runtime line, no log on a missing key, no release log line, conversation captured once, fixed sleeps in tests, reason type union, CHANGELOG wording, plan status — cosmetic or not worth the added complexity; the plan status is fixed by this pass.

## Design Notes

Decision: the pool key is the native Cursor id, but `execute` sees neither OpenClaw's `sessionId` nor `sessionKey` (checked: `ExecuteContext`, `env`, `args`, MCP file). The host's Runtime line (`Runtime: agent=main | session=agent:main:explicit:x | ...`, kept in the system prompt on normal CLI turns, docs `reference/prompt-caching.md`) names the key; `session_end.sessionKey` matches it. `/new` keeps the key and changes the session id, so a key release closes the ended conversation's process; a race with the successor's first turn is safe because that member is busy. A host that changes the line only loses the early release.

## Verification

**Commands:**
- `npx vitest run test/session-end-release.test.ts` -- green after the fix
- `npm run ci` -- passes

**Manual checks (if no CLI):**
- Isolated Gateway with the fake agent: after `/new` the `fake-cursor-agent` process is gone. Live Cursor check not run (no login).

## Auto Run Result

Status: built

- Summary: a `session_end` hook closes the idle pool members of the ended conversation (reasons `new`, `reset`, `deleted`, `idle`, `daily`); the member's conversation is the `session=<key>` of the host's Runtime line in the system prompt.
- Files: `src/core/conversation.ts` (parser, reasons), `src/core/pool.ts` (`releaseConversation`), `src/core/live-entry.ts` (member conversation; close in a finally), `src/core/register.ts` (hook), tests in `test/session-end-release.test.ts`, `src/core/pool.test.ts`, `src/core/conversation.test.ts`; docs in `docs/providers/cursor.md`, `docs/setup.md`, `openclaw.plugin.json`, the Cursor manifest P4 note, AD-14, `CHANGELOG.md`, `MEMORY.md`.
- Review: thorough, four lenses. 16 findings: patches applied 3 (all medium), deferred 3 entries, the rest rejected with reasons in the triage log.
- Follow-up review recommended: false (no high patched; 3 medium patched, each a one-line change with a test or text).
- Verification: reproduction test failed first, then green; `npx vitest run src/core test/session-end-release.test.ts` green after the patches; live in the isolated Gateway with the fake agent, `/new` freed the ended chat's process. Live Cursor check not run (no login).
- Residual risks: the Runtime line is a host text format (a change only loses the early release); a stale or racing `session_end` can close a successor's idle process (one restart).
