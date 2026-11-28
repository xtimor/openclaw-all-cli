---
id: 41
type: bug
title: "Live tests that do not test what they claim"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# Live tests that do not test what they claim

## Description

Two red findings of the live tier's first full run (ticket 4.5, 2026-11-28) are test defects, not plugin bugs: each test sets up a case that no longer exists, so it fails whatever the plugin does.

- `test/live/permission-routing.live.test.ts` "falls back to OpenClaw exec when the host denies the native shell" (`expected [] to include 'exec'`, OpenClaw 2026.11.11 and 2026.10.3, every try). The stub turn had no host-shell marker, so the core ran it in Cursor's `ask` mode with no shell sentence, and its home left the native shell to ask the host, which no production home does (both static profiles deny `Shell(*)`). On cursor-agent 2026.11.11 the model there either never asked for the native shell, or asked, was refused, and gave up ("the rejection looks like a decision to block it"): the host's deny message never reaches the model (an ACP permission answer is an option id only).
- `test/live/history-continuity.live.test.ts` (c) "a lost cursor-cli chat gets the host's history prompt" (no `reason=session_expired`, 2026.10.3, 3 tries). Deleting the chat's `acp-sessions/<id>` folder did not lose the chat: the turn's warm cursor-agent (bug 6, 2026-10-24) held it in memory and answered turn 2 from it (`reuse=reusable`, the fact in the reply).

## Acceptance Criteria

1. **The fallback test runs the production case**
   **Given** the production home (`cursorAdapter.prepareHome`, `Shell(*)` denied) and a turn where OpenClaw serves `exec` (the backend's marker)
   **When** the user asks for the command through the built-in shell, naming no other tool
   **Then** the test asserts a host-shell turn, no permission request to the host, the native shell call before the OpenClaw `exec` call with the same command, and the stub's output in the reply; the user text names no fallback
2. **(c) really loses the chat**
   **Given** turn 1 of (c)
   **When** the chat is deleted
   **Then** the Gateway was stopped first, its process group and every process in the plugin's pid locks are gone (else the test fails naming them), and the Gateway starts again on the same port whatever fails (so a retry and `afterAll` find a Gateway)
3. **Green**
   **Given** the live tier on OpenClaw 2026.10.3
   **When** each file runs
   **Then** both tests are green; their assertions about the plugin are unchanged or stronger

## Boundaries

- Test files only (and MEMORY.md); no plugin change. If the model does not fall back in the production case, that is a plugin finding, reported, not scripted around.
- history-continuity: only (c) (the 2026.11.11 log-line reads in (a)-(d) belong to another agent).

## References

- live tier plan — _bmad-output/initiative-openclaw-all-cli/epic-regression-gate/story-live-tier-in-github-actions-with-the-real-cursor-agent-plan.md (Verification)
- bug 23 (issue #76) — the shell sentence
- doc — docs/providers/cursor.md, "Permissions and tool availability", "Shell commands"
