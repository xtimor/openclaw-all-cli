---
id: 31
type: bug
title: "With a second agent configured, a reset chat keeps its cursor-agent running"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# With a second agent configured, a reset chat keeps its cursor-agent running

## Description

On OpenClaw 2026.10.3 (the supported minimum), once the config names a second agent (`config set agents.entries.second '{}'`, even an empty entry), ending a chat no longer ends its `cursor-agent` process: it stays until the 15-minute idle close, which is what #74 (backlog bug 22, AD-14) fixed. With only `main`, and on 2026.11.10 with the second agent, the release works. After the fix, a chat's process is released at its conversation end whatever number of agents the config has, and the idle close stays the backstop.

## Reproduction

1. Fresh regression state on OpenClaw 2026.10.3 with the packed plugin, `cursor-cli.command` pointing at the fake, `agents.defaults.model.primary` = `cursor-cli/auto`.
2. `openclaw config set agents.entries.second '{}'`, then start the Gateway.
3. Run one turn on a fresh session of `main`, then `sessions.reset` that chat.
4. Actual: the chat's `acp` process is still alive after 20 s (until the 15-minute idle close). Expected: it exits within seconds; another chat's process stays.

A probe showed the plugin's `session_end` hook running in a different captured copy of the plugin build (`state/tmp/plugin-captures/.../openclaw-plugin-build-*`), whose process pool was empty.

## Cause Hypothesis

OpenClaw 2026.10.3 loads the plugin more than once in one Gateway, and the process pool is per module instance. The hook runs in the copy the Gateway activated; the turn's process lives in another copy's pool. Which host path makes the second copy appear only with a second agent is to be read in the 2026.10.3 host sources.

## Acceptance Criteria

1. **The release reaches the copy that holds the process**
   **Given** OpenClaw 2026.10.3 with a second agent in the config
   **When** a chat of `main` is reset with `sessions.reset`
   **Then** that chat's `cursor-agent` exits within 20 s, and another chat's process keeps running
2. **The second agent's own chats too**
   **Given** the same Gateway
   **When** a chat of the second agent is reset
   **Then** its process exits within 20 s
3. **Nothing else changes**
   **Given** a config with only `main`, or OpenClaw 2026.11.x
   **When** the tier runs
   **Then** the #74 scenario and every other Gateway scenario stay green, and the release rules of AD-14 (busy members stay, `shutdown`/`restart` on the unload path) hold
4. **The tier's shared state never gets a second agent**
   **Given** the new scenario
   **When** it runs
   **Then** it uses a state and config of its own, and later files see the shared config unchanged
5. **Tests**
   **Given** the suites
   **When** they run
   **Then** a Gateway scenario reproduces the bug (red before the fix, green after), unit tests cover the fix, and the ledger has a `[[bug]]` entry for #105 at tier `gateway` with `reproduces = true`

## Boundaries

- Must not change: the reuse key (AD-13), the 15-minute idle close, the process caps, unload behavior, or which hook reasons release.
- The core names no CLI (AD-2). No patch to installed OpenClaw files except a temporary probe that is restored after.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- issue — https://github.com/xtimor/openclaw-all-cli/issues/105
- bug — _bmad-output/backlog/bug-a-finished-conversation-leaves-its-cursor-agent-running.md (#74, bug 22)
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md, AD-14
- memory — MEMORY.md, "Gateway scenarios for past bugs" fact (3)

## Notes

- Issue: #105
- Found while building epic-regression-gate ticket 4.3 (the #74 scenario goes red once a second agent is added).
- Risk medium: a release that reaches the wrong pool could close a process of another chat; a shared pool could let one copy's unload close another copy's processes.
- Check outside the criteria: a live Cursor run when `CURSOR_API_KEY` is set; otherwise recorded as not run.
