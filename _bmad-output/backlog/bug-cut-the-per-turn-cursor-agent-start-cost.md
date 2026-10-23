---
id: 6
type: bug
title: "Cut the per-turn cursor-agent start cost"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: high
severity: P1
---

# Cut the per-turn cursor-agent start cost

## Description

A plain `cursor-cli/grok-4.7` turn takes 15-20 s to the first character, against 3-5 s on `claude-cli`. About 5 s of it is starting a new `cursor-agent` process on every turn, 3.6 s of that a codebase cache rebuilt on each start. The first character also arrives together with the finished short reply. Turns should start faster, and text should stream as it arrives.

## Reproduction

1. Enable the plugin, sign in with `cursor-agent login`, open a webchat session on `cursor-cli/grok-4.7`.
2. Send three short messages that need no tools.
3. Actual: time to `assistant_output_started` 16.1 s, 17.4 s, 15.5 s; each turn starts a new `cursor-agent` (statsig `fromCache=false`, session loaded from scratch, `computeGlobalCache` 3.6 s). Expected: a follow-up turn is much closer to `claude-cli`.

## Cause Hypothesis

The parity manifest (P4) records that OpenClaw 2026.10.3 puts the per-turn MCP settings path in its live-session fingerprint, so the process restarts every turn and resumes with `session/load`. The start cache is likely rebuilt because each start is a fresh process and home. Whether deltas are buffered before the model finishes is unknown; the ~10 s model segment may be only model latency.

## Acceptance Criteria

1. **Timings are measured first**
   **Given** a live turn on a `cursor-cli` model
   **When** the plan starts
   **Then** the plan records process start, cache build, first-delta, and total timings for a plain follow-up turn, with no key, token, or account id; if Cursor is unreachable the live check is recorded as not run with the reason
2. **The start cost drops**
   **Given** a conversation with one finished turn
   **When** a plain follow-up turn is sent
   **Then** time to first character is within a bound stated in the plan from the measured numbers, and a live timing test asserts it
3. **Deltas are not buffered by the plugin**
   **Given** a turn whose reply arrives as several ACP text deltas
   **When** the plugin forwards them
   **Then** each delta reaches the host as it arrives, covered by a test that fails if the plugin holds them until the result
4. **The record is updated**
   **Given** the manifest and the parity matrix
   **When** the change is done
   **Then** the P4 note and its matrix row state the measured cost and what was changed or why nothing could be
5. **Tests cover the change**
   **Given** the test suite and `npm run ci`
   **When** they run
   **Then** they pass, with a test for each behavior the fix changes
6. **Or: the fix is larger than approved**
   **Given** the measurements
   **When** they show the approved fix is wrong or needs a different process-reuse design (AD-13)
   **Then** the ticket is blocked for the owner with the numbers and no code beyond measurement is committed; this supersedes 2 to 5

## Boundaries

- Must not change: tool routing, permissions, abort, and session resume behavior (CAP-4, CAP-6, CAP-7).
- Must not change: the process caps and cleanup of leftover Cursor workers (CAP-9).

## References

- parent — none
- spec — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/spec-cursor-cli-provider.md
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md, AD-13
- parity matrix — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md, P4

## Notes

- Issue: #11
- Decision: measure first, then change code (owner, 2026-10-23); live checks never block the build.
- Decision: try, in order, a stable MCP settings path per conversation, then reuse of Cursor's cache across starts.
- Check outside the criteria: the owner sends plain follow-up turns in webchat and compares with `claude-cli`.
