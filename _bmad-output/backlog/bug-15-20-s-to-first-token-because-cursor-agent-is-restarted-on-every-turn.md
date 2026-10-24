---
id: 6
type: bug
title: "15-20 s to first token because cursor-agent is restarted on every turn"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: high
severity: P1
---

# 15-20 s to first token because cursor-agent is restarted on every turn

## Description

On a `cursor-cli` model every turn takes 15-20 s to the first character, including turns without tools; `claude-cli` answers in 3-5 s. A new `cursor-agent` process starts each turn (about 5 s, 3.6 s of it a codebase cache rebuild). After this, the per-turn start cost is measured and cut, and time to first character for a plain follow-up turn is within a stated bound.

## Reproduction

1. Webchat session on a `cursor-cli` model, block streaming off.
2. Send three short plain messages.
3. Actual: 16.1 s, 17.4 s, 15.5 s to `assistant_output_started`. Expected: close to `claude-cli`.
Reported breakdown of one turn: gateway about 1 s, process start about 5 s (`statsig fromCache=false`, `computeGlobalCache` 3.6 s), model request about 10 s with the first character arriving together with the finished answer.

## Cause Hypothesis

OpenClaw 2026.10.3 puts the per-turn MCP settings path into its live-session fingerprint, so the process restarts every turn (manifest P4). Cursor rebuilds its global cache on each start. Deltas may also be buffered before the model finishes; this is unmeasured.

## Acceptance Criteria

1. **The cost is measured**
   **Given** a live `cursor-cli` turn
   **When** the build measures start, cache, and first-delta timings
   **Then** the numbers are recorded in the plan, with no key, token, or account id
2. **The start cost drops**
   **Given** the measured causes
   **When** the build keeps the MCP settings path stable per conversation, reuses Cursor's cache across starts, or both, as the numbers support
   **Then** a plain follow-up turn reaches the first character within a bound stated in the plan, or the plan proves the approved fix is wrong or larger and the issue returns to the owner with the numbers
3. **No plugin buffering**
   **Given** ACP text deltas
   **When** they arrive before the model finishes
   **Then** the plugin passes them on without waiting for the result
4. **The record is current**
   **Given** the manifest and parity matrix
   **When** the fix lands
   **Then** the P4 note and the matrix row describe the new behavior
5. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers the changed behavior, and `npm run ci` passes

## Boundaries

- Must not change: tool routing, permissions, session resume (AD-13 stays unless the numbers force a design change, which then goes to the owner).

## References

- parent — none
- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md, CAP-4, CAP-8

## Notes

- Issue: #11
- Check outside the criteria: a live timing test (`NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1`) when `CURSOR_API_KEY` is set; otherwise recorded as not run, and the owner times one real follow-up turn.
- Open question: whether the fix needs a different process-reuse design; if so, block for the owner with the numbers.
