---
id: 22
type: bug
title: "A finished conversation leaves its cursor-agent running"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
---

# A finished conversation leaves its cursor-agent running

## Description

When a conversation ends (new, reset, deleted, idle, or daily rollover), the pooled `cursor-agent` that served it stays resident. No other conversation can reuse it, so it holds about 200 MB until the 15-minute idle close or the process cap removes it. On a small host this ends in out-of-memory kills. After the fix, a process is released when its conversation ends, and the idle close stays as the backstop.

## Reproduction

1. Gateway with the plugin and `cursor-cli/auto`; run a turn in one conversation, then end that conversation (for example `/new`).
2. Actual: the `cursor-agent` of the ended conversation is still alive for up to 15 minutes. The plugin registers no OpenClaw lifecycle hook, so nothing tells it the conversation ended.
3. Expected: the process of that conversation is closed when the conversation ends; processes of other conversations are untouched.

Offline: registering the plugin against a host that offers `api.on` records no hook. The test in Notes fails with `expected [] to include 'session_end'`.

## Cause Hypothesis

Pool members are keyed by the native session id, so a new conversation never matches an old member. Members leave only at the process cap, at the idle close, and at unload. The plugin never subscribes to the host's `session_end` metadata hook (OpenClaw 2026.10.3 hooks reference), so the end of a conversation reaches no code.

## Acceptance Criteria

1. **A finished conversation releases its process**
   **Given** a pool member that serves a conversation and runs no turn
   **When** the host fires `session_end` for that conversation (reasons `new`, `reset`, `deleted`, `idle`, `daily`)
   **Then** that member is closed and removed from the pool
2. **Other conversations are untouched**
   **Given** members for two conversations
   **When** `session_end` fires for one
   **Then** only its member closes
3. **A running turn is never cut off**
   **Given** a member that runs a turn
   **When** `session_end` fires for its conversation
   **Then** the member is not closed under the turn, and it is still closed by the idle close or the next release
4. **Shutdown keeps its path**
   **Given** `session_end` with reason `shutdown` or `restart`
   **When** it fires
   **Then** the existing close-all path stays the only closer and the 2 s drain is not exceeded
5. **A host without hooks still loads**
   **Given** a host whose API has no `on`
   **When** the plugin registers
   **Then** registration succeeds and the idle close still applies
6. **The close is bounded**
   **Given** a process that ignores the close
   **When** the release runs
   **Then** it ends within the existing abort grace and the hook never blocks the host
7. **Tests and docs**
   **Given** the test suite and docs
   **When** `npm run ci` runs
   **Then** the reproduction test (committed as `test/session-end-release.test.ts`) and a test for each criterion above pass, and `docs/providers/cursor.md`, the manifest text, and the AD-14 note say that a process is released at conversation end with the idle close as backstop

## Boundaries

- Must not change: the reuse key (AD-13), the 15-minute idle close (AD-14), the process cap, and unload behavior.
- The core names no CLI (AD-2).
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/74
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md, AD-13 and AD-14

## Notes

- Issue: #74
- Risk medium: a wrong release could close a process mid-turn. Check outside the criteria: the existing pool and execute suites stay green, and a live run (`NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1`) when `CURSOR_API_KEY` is set; otherwise recorded as not run.
- Code to read: the pool, the registration module, and `execute` under `src/core/`.
- Triage reproduced it on `main` `082fee7d7ec0cfd833b2270d531262a14e7e102b`. Reproduction test, to be added first as `test/session-end-release.test.ts`:

```ts
import { expect, it } from "vitest";
import { registerAdapters } from "../src/core/register.ts";
import { ADAPTERS } from "../src/registry.ts";

it("registers a session_end hook, so a finished conversation releases its process", () => {
  const hooks: string[] = [];
  registerAdapters(
    {
      pluginConfig: {},
      registerProvider: () => {},
      registerCliBackend: () => {},
      logger: { warn: () => {} },
      on: (name: string) => void hooks.push(name),
    } as never,
    ADAPTERS,
  );
  expect(hooks).toContain("session_end");
});
```

  Failing output: `AssertionError: expected [] to include 'session_end'`.
- Open question: which payload field of `session_end` names the conversation (session id vs session key) and how it maps to the pool's key; the build reads the host's hook reference and records a `Decision:`.
