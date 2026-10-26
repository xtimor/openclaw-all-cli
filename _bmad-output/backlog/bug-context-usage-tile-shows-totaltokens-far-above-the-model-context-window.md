---
id: 15
type: bug
title: "Context usage tile shows totalTokens far above the model context window"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# Context usage tile shows totalTokens far above the model context window

## Description

The Control UI context tile showed 5.6M / 256k after a turn whose input plus output was 186.8k. A working session looks broken. A turn's `total` must not be read as context size.

## Reproduction

1. Multi-turn webchat on `cursor-cli/grok-4.7` with several tool calls.
2. Read the context tile across turns.
3. Actual: 221.5k / 256k, then 5.6M / 256k one turn later while input plus output grew 106.6k to 186.8k. Expected: `used` stays near input plus output and not far above the window.

## Cause Hypothesis

`mapUsage` passes `usage.totalTokens` of the ACP response through; for Cursor that value is probably all tokens billed in the turn, with repeated cache reads counted again.

## Acceptance Criteria

1. **Total stays plausible**
   **Given** a usage report whose `total` exceeds the model's context window or is far above input plus output
   **When** it is mapped for OpenClaw
   **Then** `total` is input plus output (or omitted), and input, output, and cache counts are as reported
2. **Tests cover both sources**
   **Given** `src/transports/acp` tests and `src/core/usage.test.ts`
   **When** they run
   **Then** each covers a plausible total (kept) and an implausible one (clamped) for both usage sources, and `npm test` passes
3. **Meaning is documented**
   **Given** the change
   **When** a user reads `docs/`
   **Then** it says what the numbers mean; the notes record which source the live 2026.10.22 uses

## References

- parent — none
- source — GitHub issue #40

## Notes

- Issue: #40
- Live check is not run without a Cursor login.
